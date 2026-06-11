'use strict';

import { Transform, TransformCallback } from 'stream';
import crypto from 'crypto';
import { createLogger } from './log';

const log = createLogger('protocol-translate');

// --- Types ---

interface ContentBlock {
    type: string;
    text?: string;
    source?: { type?: string; media_type?: string; data?: string };
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
    thinking?: string;
    signature?: string;
    content?: string | ContentBlock[];
    tool_use_id?: string;
}

interface AnthropicMessage {
    role: string;
    content: string | ContentBlock[];
}

interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
    model: string;
    messages: AnthropicMessage[];
    stream?: boolean;
    system?: string | ContentBlock[];
    tools?: AnthropicTool[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tool_choice?: unknown;
    metadata?: Record<string, unknown>;
}

interface OpenAIToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

interface OpenAIMessage {
    role: string;
    content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
}

interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    stream_options?: { include_usage: boolean };
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop?: string[];
    tool_choice?: unknown;
    metadata?: Record<string, unknown>;
}

interface OpenAIChoice {
    index: number;
    message?: OpenAIMessage;
    finish_reason?: string;
    delta?: {
        role?: string;
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
        }>;
    };
}

interface OpenAIResponseBody {
    id?: string;
    choices?: OpenAIChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    model?: string;
}

// --- Translation helpers ---

function mapFinishReason(reason: string | null | undefined): string {
    const map: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'content_filter' };
    return (reason && map[reason]) || 'end_turn';
}

function stringifyContent(content: string | ContentBlock[] | null | undefined): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // When content contains non-text blocks (tool_use, image), serialize
        // the full structure as JSON so downstream models receive complete data.
        const hasNonText = content.some(b => b.type !== 'text');
        if (hasNonText) {
            return JSON.stringify(content);
        }
        const parts: string[] = [];
        for (const b of content) {
            if (b.type === 'text') {
                parts.push(b.text || '');
            } else if (b.type === 'image' && b.source) {
                parts.push(`[Image: ${b.source.type || 'base64'}, data length: ${(b.source.data || '').length}]`);
            } else if (b.type === 'tool_use') {
                parts.push(`[Tool call: ${b.name || 'unknown'}(${JSON.stringify(b.input || {})})]`);
            }
        }
        return parts.join('\n');
    }
    return String(content);
}

// --- Request translation ---

export function translateRequest(anthropicBody: AnthropicRequestBody): { openaiBody: OpenAIRequestBody; model: string } {
    const model = anthropicBody.model;
    const openaiBody: OpenAIRequestBody = {
        model,
        messages: [],
        stream: anthropicBody.stream || false,
    };

    if (anthropicBody.system) {
        let systemContent = '';
        if (typeof anthropicBody.system === 'string') {
            systemContent = anthropicBody.system;
        } else if (Array.isArray(anthropicBody.system)) {
            systemContent = anthropicBody.system
                .filter((b: ContentBlock) => b.type === 'text')
                .map((b: ContentBlock) => b.text)
                .join('\n');
        }
        if (systemContent) {
            openaiBody.messages.unshift({ role: 'system', content: systemContent });
        }
    }

    for (const msg of anthropicBody.messages) {
        const converted = convertMessage(msg);
        if (Array.isArray(converted)) {
            openaiBody.messages.push(...converted);
        } else {
            openaiBody.messages.push(converted);
        }
    }

    if (anthropicBody.tools && anthropicBody.tools.length) {
        openaiBody.tools = anthropicBody.tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.input_schema },
        }));
    }

    if (anthropicBody.max_tokens !== undefined) openaiBody.max_tokens = anthropicBody.max_tokens;
    if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
    if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
    if (anthropicBody.top_k !== undefined) openaiBody.top_k = anthropicBody.top_k;
    if (anthropicBody.metadata !== undefined) openaiBody.metadata = anthropicBody.metadata;
    if (anthropicBody.stop_sequences && anthropicBody.stop_sequences.length) {
        openaiBody.stop = anthropicBody.stop_sequences;
    }
    if (anthropicBody.tool_choice !== undefined) {
        openaiBody.tool_choice = translateToolChoice(anthropicBody.tool_choice);
    }

    // Request stream usage reporting from OpenAI-compatible providers.
    // This adds `usage` to the final SSE chunk, which forward.ts extracts.
    if (openaiBody.stream) {
        openaiBody.stream_options = { include_usage: true };
    }

    return { openaiBody, model };
}

function convertMessage(msg: AnthropicMessage): OpenAIMessage | OpenAIMessage[] {
    if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
            return { role: 'user', content: msg.content };
        }
        const contentBlocks = msg.content as ContentBlock[];
        const toolResults = contentBlocks.filter(b => b.type === 'tool_result');
        const textBlocks = contentBlocks.filter(b => b.type === 'text' && b.text);
        if (toolResults.length > 0) {
            // Filter out tool results without a valid tool_use_id to avoid
            // OpenAI API 400 errors from an empty tool_call_id string.
            const validToolResults = toolResults.filter(block => block.tool_use_id);
            const result: OpenAIMessage[] = validToolResults.map(block => {
                // Normalize content before stringifyContent: null → '', string → pass,
                // array → pass. Avoids producing the string "null" for undefined content.
                const raw = block.content;
                const normalized = (raw == null) ? '' : raw;
                return {
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    content: stringifyContent(normalized as string | ContentBlock[]) || '',
                };
            });
            if (textBlocks.length > 0) {
                result.push({ role: 'user', content: textBlocks.map(b => b.text).join('\n') });
            }
            return result;
        }
        const hasImage = contentBlocks.some(b => b.type === 'image');
        const hasDocument = contentBlocks.some(b => b.type === 'document');
        if (hasImage || hasDocument) {
            const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
            for (const block of contentBlocks) {
                if (block.type === 'text') {
                    content.push({ type: 'text', text: block.text });
                } else if (block.type === 'image' && block.source) {
                    // Anthropic supports both 'base64' and 'url' source types.
                    // URL sources pass the URL directly; base64 sources construct a data URI.
                    if (block.source.type === 'url' && (block.source as any).url) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: (block.source as any).url as string },
                        });
                    } else {
                        content.push({
                            type: 'image_url',
                            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
                        });
                    }
                } else if (block.type === 'document' && block.source) {
                    // Anthropic document blocks (PDFs, etc.) — pass as file data URIs.
                    // OpenAI Chat Completions doesn't have a standard document content part,
                    // so we emit a text annotation AND a data URI for providers that support it.
                    const mediaType = block.source.media_type || 'application/octet-stream';
                    const docName = (block as any).title || (block as any).file_name || 'document';
                    if (block.source.type === 'url' && (block.source as any).url) {
                        content.push({ type: 'text', text: '[Attached document: ' + docName + ' (' + mediaType + ')]' });
                    } else {
                        content.push({
                            type: 'image_url',
                            image_url: { url: `data:${mediaType};base64,${block.source.data}` },
                        });
                        content.push({ type: 'text', text: '[Attached document: ' + docName + ' (' + mediaType + ', ' + Math.round((block.source.data || '').length * 3 / 4) + ' bytes)]' });
                    }
                }
            }
            return { role: 'user', content };
        }
        return {
            role: 'user',
            content: contentBlocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n'),
        };
    }

    if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
            return { role: 'assistant', content: msg.content };
        }
        const contentBlocks = msg.content as ContentBlock[];
        const textParts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        for (const block of contentBlocks) {
            if (block.type === 'text') {
                textParts.push(block.text || '');
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id || '',
                    type: 'function',
                    function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
                });
            }
        }
        const result: OpenAIMessage = { role: 'assistant' };
        if (textParts.length) result.content = textParts.join('\n');
        if (toolCalls.length) result.tool_calls = toolCalls;
        return result;
    }

    // Null/undefined content → omit content field entirely (valid OpenAI shape for
    // pure tool_calls responses). String(content) would produce "null" or "undefined".
    if (msg.content == null) return { role: msg.role };
    return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
}

function translateToolChoice(tc: unknown): unknown {
    if (tc === 'auto' || tc === 'any') {
        return tc === 'any' ? 'required' : 'auto';
    }
    if (tc && typeof tc === 'object') {
        const obj = tc as { type?: string; name?: string };
        // { type: 'any' } → 'required' (same as string 'any' shortcut)
        if (obj.type === 'any') return 'required';
        if (obj.type === 'tool' && obj.name) {
            return { type: 'function', function: { name: obj.name } };
        }
    }
    return 'auto';
}

// --- Response translation ---

export function translateResponse(openaiBody: OpenAIResponseBody, model: string): Record<string, unknown> {
    const choice = openaiBody.choices && openaiBody.choices[0];
    const message: OpenAIMessage | undefined = choice ? choice.message : undefined;
    const finishReason = choice ? choice.finish_reason : null;
    const usage = openaiBody.usage || {};

    const content: ContentBlock[] = [];

    // Emit thinking block for non-streaming reasoning_content (DeepSeek R1, etc.)
    if (message && message.reasoning_content && message.reasoning_content.length > 0) {
        content.push({ type: 'thinking', thinking: message.reasoning_content });
    }

    if (message && message.content != null) {
        let contentText: string;
        if (typeof message.content === 'string') {
            contentText = message.content;
        } else if (Array.isArray(message.content)) {
            contentText = message.content.map((b: any) => b.text || '').join('\n');
        } else {
            contentText = String(message.content);
        }
        // Skip empty text block when tool_calls are present — Anthropic clients
        // expect content to contain only tool_use blocks for pure tool-call responses.
        if (contentText.length > 0 || !(message.tool_calls && message.tool_calls.length > 0)) {
            content.push({ type: 'text', text: contentText });
        }
    }
    if (message && message.tool_calls) {
        for (const tc of message.tool_calls) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* malformed JSON, use default */ }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
    }

    return {
        id: openaiBody.id || `msg_${crypto.randomUUID()}`,
        type: 'message',
        model,
        role: 'assistant',
        content,
        stop_reason: mapFinishReason(finishReason),
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
        },
    };
}

// --- Streaming transformer ---

interface TransformerState {
    started: boolean;
    finished: boolean;
    blockIndex: number;
    currentBlockType: string | null;
    toolCallMap: Record<number, number>;
    lastToolUseIdx: number;
    messageId: string;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
}

export function createStreamTransformer(model: string): Transform {
    const state: TransformerState = {
        started: false,
        finished: false,
        blockIndex: 0,
        currentBlockType: null,
        toolCallMap: {},
        lastToolUseIdx: -1,
        messageId: `msg_${crypto.randomUUID()}`,
        model,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    function emit(eventType: string, data: Record<string, unknown>): string {
        return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    function closeBlock(): string {
        if (!state.currentBlockType) return '';
        const idx = state.blockIndex - 1;
        state.currentBlockType = null;
        return emit('content_block_stop', { type: 'content_block_stop', index: idx });
    }

    function openBlock(type: string, contentBlock: Record<string, unknown>): string {
        const idx = state.blockIndex++;
        state.currentBlockType = type;
        return emit('content_block_start', {
            type: 'content_block_start', index: idx, content_block: contentBlock,
        });
    }

    function appendBlock(deltaType: string, delta: Record<string, unknown>): string {
        const idx = state.blockIndex - 1;
        return emit('content_block_delta', {
            type: 'content_block_delta', index: idx,
            delta: { type: deltaType, ...delta },
        });
    }

    function finishStream(stopReason: string): string {
        let output = closeBlock();
        output += emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: state.usage,
        });
        output += emit('message_stop', { type: 'message_stop' });
        state.finished = true;
        return output;
    }

    function processEvent(eventBlock: string): string {
        const dataLines = [...eventBlock.matchAll(/^data: ?(.*)$/gm)];
        if (!dataLines.length) return '';
        const payload = dataLines.map(m => m[1]).join('\n');

        if (payload === '[DONE]') {
            return finishStream('end_turn');
        }

        let parsed: OpenAIResponseBody;
        try { parsed = JSON.parse(payload); } catch { return ''; }

        // Propagate upstream SSE error events (content filter, rate limit mid-stream, etc.)
        if (parsed.error) {
            const upstreamError = parsed.error;
            const apiError = upstreamError.type === 'api_error'
                ? { type: 'error', error: upstreamError }
                : { type: 'error', error: { type: 'api_error', message: upstreamError.message || String(upstreamError) } };
            return emit('error', apiError);
        }

        const choice = parsed.choices && parsed.choices[0];
        if (!choice) return '';

        const delta = choice.delta || {};
        let output = '';

        if (!state.started) {
            state.started = true;
            output += emit('message_start', {
                type: 'message_start',
                message: {
                    id: state.messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: state.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });
        }

        if (parsed.usage) {
            state.usage = {
                input_tokens: parsed.usage.prompt_tokens || 0,
                output_tokens: parsed.usage.completion_tokens || 0,
            };
        }

        if (delta.reasoning_content) {
            if (state.currentBlockType && state.currentBlockType !== 'thinking') output += closeBlock();
            if (state.currentBlockType !== 'thinking') output += openBlock('thinking', { type: 'thinking', thinking: '' });
            output += appendBlock('thinking_delta', { thinking: delta.reasoning_content });
        }

        if (delta.content) {
            if (state.currentBlockType && state.currentBlockType !== 'text') output += closeBlock();
            if (state.currentBlockType !== 'text') output += openBlock('text', { type: 'text', text: '' });
            output += appendBlock('text_delta', { text: delta.content });
        }

        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                if (tc.function && tc.function.name) {
                    if (state.currentBlockType) output += closeBlock();
                    const idx = state.blockIndex++;
                    state.currentBlockType = 'tool_use';
                    state.lastToolUseIdx = idx;
                    if (tc.index !== undefined) state.toolCallMap[tc.index] = idx;
                    output += emit('content_block_start', {
                        type: 'content_block_start', index: idx,
                        content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
                    });
                }
                if (tc.function && tc.function.arguments) {
                    const idx = (tc.index !== undefined && state.toolCallMap[tc.index] !== undefined)
                        ? state.toolCallMap[tc.index] : state.lastToolUseIdx;
                    if (idx >= 0) {
                        output += emit('content_block_delta', {
                            type: 'content_block_delta', index: idx,
                            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                        });
                    }
                }
            }
        }

        if (choice.finish_reason) {
            output += finishStream(mapFinishReason(choice.finish_reason));
        }

        return output;
    }

    class StreamTransformer extends Transform {
        private _buf = '';

        _transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback): void {
            // Check buffer BEFORE concatenation to avoid false-positive overflow
            // from accumulated partial events that haven't been delimited by \n\n.
            const newData = chunk.toString();
            if (this._buf.length + newData.length > 1_048_576) {
                this.destroy(new Error('SSE buffer exceeded 1MB'));
                return;
            }
            this._buf += newData;
            const parts = this._buf.split('\n\n');
            this._buf = parts.pop() || '';
            let output = '';
            for (const part of parts) {
                if (state.finished) break;
                const trimmed = part.trim();
                if (!trimmed) continue;
                output += processEvent(trimmed);
            }
            callback(null, output);
        }

        _flush(callback: TransformCallback): void {
            let output = '';
            if (this._buf && this._buf.trim()) {
                if (!state.finished) output += processEvent(this._buf.trim());
            }
            // Emit finishStream if stream started; otherwise emit minimal start+stop
            // so Anthropic clients don't receive orphaned message_stop without message_start.
            if (!state.finished) {
                if (!state.started) {
                    state.started = true;
                    output += emit('message_start', {
                        type: 'message_start',
                        message: {
                            id: state.messageId, type: 'message', role: 'assistant',
                            content: [], model: state.model,
                            stop_reason: null, stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 },
                        },
                    });
                }
                output += finishStream('end_turn');
            }
            callback(null, output);
        }
    }

    return new StreamTransformer();
}

