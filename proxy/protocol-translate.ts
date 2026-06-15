'use strict';

import { Transform, TransformCallback } from 'stream';
import crypto from 'crypto';
import { createLogger } from './log';
import type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicRequestBody,
  AnthropicToolChoice,
  AnthropicUsage,
  AnthropicSSEEvent,
  AnthropicDelta,
  AnthropicStopReason,
  OpenAIRequestBody,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIResponseBody,
  OpenAIResponseChoice,
  ExtendedOpenAIUsage,
  GeminiRequestBody,
  GeminiContent,
  GeminiPart,
  GeminiFunctionDeclaration,
  GeminiResponseBody,
  GeminiSSEEvent,
} from './protocol-types';
import { mapFinishReason, translateToolChoice } from './protocol-types';

const log = createLogger('protocol-translate');

// Re-export for backward compatibility
export { mapFinishReason, translateToolChoice };
export type {
  AnthropicMessage,
  AnthropicContentBlock as ContentBlock,
  AnthropicRequestBody,
  OpenAIRequestBody,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIResponseBody,
  OpenAIResponseChoice,
  AnthropicUsage,
  AnthropicSSEEvent,
  AnthropicDelta,
  AnthropicStopReason,
  AnthropicToolChoice,
  ExtendedOpenAIUsage,
};

// --- Translation helpers ---

function stringifyContent(content: string | AnthropicContentBlock[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // When content contains non-text blocks (tool_use, image), serialize
    // the full structure as JSON so downstream models receive complete data.
    const hasNonText = content.some((b) => b.type !== 'text');
    if (hasNonText) {
      return JSON.stringify(content);
    }
    const parts: string[] = [];
    for (const b of content) {
      if (b.type === 'text') {
        parts.push(b.text || '');
      } else if (b.type === 'image' && b.source) {
        parts.push(
          `[Image: ${b.source.type || 'base64'}, data length: ${(b.source.data || '').length}]`,
        );
      } else if (b.type === 'tool_use') {
        parts.push(`[Tool call: ${b.name || 'unknown'}(${JSON.stringify(b.input || {})})]`);
      }
    }
    return parts.join('\n');
  }
  return String(content);
}

// --- Request translation ---

export function translateRequest(anthropicBody: AnthropicRequestBody): {
  openaiBody: OpenAIRequestBody;
  model: string;
} {
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
      const textBlocks = anthropicBody.system.filter((b: ContentBlock) => b.type === 'text');
      if (textBlocks.length < anthropicBody.system.length) {
        log.warn(
          null,
          'system prompt: ' +
            (anthropicBody.system.length - textBlocks.length) +
            ' non-text block(s) filtered out (only text blocks are forwarded to OpenAI-compatible providers)',
        );
      }
      systemContent = textBlocks.map((b: ContentBlock) => b.text).join('\n');
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
    openaiBody.tools = anthropicBody.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    }));
  }

  if (anthropicBody.max_tokens !== undefined) openaiBody.max_tokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
  // top_k and metadata are Anthropic-specific — not forwarded to OpenAI providers
  // as they cause 400 errors on standard OpenAI-compatible endpoints.
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

  // Note: thinking is NOT passed through to openaiBody here.
  // start-proxy.ts reads budget_tokens from the original Anthropic request
  // body and derives the correct reasoning_effort for the target provider.
  // Passing it here would prevent start-proxy.ts from applying the mapping
  // (the !openaiBody.thinking guard would short-circuit).

  return { openaiBody, model };
}

function convertMessage(msg: AnthropicMessage): OpenAIMessage | OpenAIMessage[] {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }
    const contentBlocks = msg.content as ContentBlock[];
    const toolResults = contentBlocks.filter((b) => b.type === 'tool_result');
    const textBlocks = contentBlocks.filter((b) => b.type === 'text' && b.text);
    if (toolResults.length > 0) {
      // Filter out tool results without a valid tool_use_id to avoid
      // OpenAI API 400 errors from an empty tool_call_id string.
      const validToolResults = toolResults.filter((block) => block.tool_use_id);
      if (validToolResults.length < toolResults.length) {
        log.warn(
          null,
          'dropping ' +
            (toolResults.length - validToolResults.length) +
            ' tool_result(s) with missing tool_use_id',
        );
      }
      const result: OpenAIMessage[] = validToolResults.map((block) => {
        // Normalize content before stringifyContent: null → '', string → pass,
        // array → pass. Avoids producing the string "null" for undefined content.
        const raw = block.content;
        const normalized = raw == null ? '' : raw;
        return {
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: stringifyContent(normalized as string | ContentBlock[]) || '',
        };
      });
      if (textBlocks.length > 0) {
        result.push({ role: 'user', content: textBlocks.map((b) => b.text).join('\n') });
      }
      return result;
    }
    const hasImage = contentBlocks.some((b) => b.type === 'image');
    const hasDocument = contentBlocks.some((b) => b.type === 'document');
    if (hasImage || hasDocument) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'image' && block.source) {
          // Anthropic supports both 'base64' and 'url' source types.
          // URL sources pass the URL directly; base64 sources construct a data URI.
          if (block.source.type === 'url' && block.source.url) {
            content.push({
              type: 'image_url',
              image_url: { url: block.source.url as string },
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
          const docName = block.title || block.file_name || 'document';
          if (block.source.type === 'url' && block.source.url) {
            const docUrl = block.source.url as string;
            content.push({
              type: 'text',
              text: '[Attached document: ' + docName + ' (' + mediaType + ')]',
            });
            content.push({ type: 'image_url', image_url: { url: docUrl } });
          } else {
            content.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${block.source.data}` },
            });
            content.push({
              type: 'text',
              text:
                '[Attached document: ' +
                docName +
                ' (' +
                mediaType +
                ', ' +
                Math.round(((block.source.data || '').length * 3) / 4) +
                ' bytes)]',
            });
          }
        }
      }
      return { role: 'user', content };
    }
    return {
      role: 'user',
      content: contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('\n'),
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
  return {
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  };
}

// translateToolChoice re-exported from protocol-types.ts

// --- Response translation ---

export function translateResponse(
  openaiBody: OpenAIResponseBody,
  model: string,
): Record<string, unknown> {
  const choice = openaiBody.choices && openaiBody.choices[0];
  const message: OpenAIMessage | undefined = choice ? choice.message : undefined;
  const finishReason = choice ? choice.finish_reason : null;
  const usage = openaiBody.usage || {};

  const content: ContentBlock[] = [];

  // Emit thinking block for non-streaming reasoning_content (DeepSeek R1, etc.)
  if (message && message.reasoning_content && message.reasoning_content.length > 0) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
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
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* malformed JSON, use default */
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  // Count server-side tool use for Claude Code's "Did N searches" display.
  // Claude Code reads usage.server_tool_use from the Anthropic response to set
  // searchCount in toolUseResult. Without this the display always shows 0.
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  for (const block of content) {
    if (block.type === 'tool_use') {
      if (block.name === 'web_search') webSearchRequests++;
      else if (block.name === 'web_fetch') webFetchRequests++;
    }
  }

  // Map cache tokens from OpenAI field names (prompt_cache_hit/miss) to
  // Anthropic field names (cache_read/cache_creation_input_tokens) when present.
  const usageAny = usage as ExtendedOpenAIUsage;
  const hasCache = typeof usageAny.prompt_cache_hit_tokens === 'number';

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
      ...(hasCache
        ? {
            cache_read_input_tokens: usageAny.prompt_cache_hit_tokens,
            cache_creation_input_tokens: usageAny.prompt_cache_miss_tokens || 0,
          }
        : {}),
      ...(webSearchRequests > 0 || webFetchRequests > 0
        ? {
            server_tool_use: {
              web_search_requests: webSearchRequests,
              web_fetch_requests: webFetchRequests,
            },
          }
        : {}),
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
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  serverToolUse: { web_search_requests: number; web_fetch_requests: number };
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
    serverToolUse: { web_search_requests: 0, web_fetch_requests: 0 },
  };

  function emit(eventType: string, data: Record<string, unknown>): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function closeBlock(): string {
    if (!state.currentBlockType) return '';
    const idx = state.blockIndex - 1;
    const blockType = state.currentBlockType;
    state.currentBlockType = null;
    let output = '';
    if (blockType === 'thinking') {
      output += emit('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'signature_delta', signature: '' },
      });
    }
    output += emit('content_block_stop', { type: 'content_block_stop', index: idx });
    return output;
  }

  function openBlock(type: string, contentBlock: Record<string, unknown>): string {
    const idx = state.blockIndex++;
    state.currentBlockType = type;
    return emit('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: contentBlock,
    });
  }

  function appendBlock(deltaType: string, delta: Record<string, unknown>): string {
    const idx = state.blockIndex - 1;
    return emit('content_block_delta', {
      type: 'content_block_delta',
      index: idx,
      delta: { type: deltaType, ...delta },
    });
  }

  function emitMessageStart(): string {
    state.started = true;
    return emit('message_start', {
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

  function finishStream(stopReason: string): string {
    let output = closeBlock();
    const srv = state.serverToolUse;
    const hasServerTools = srv.web_search_requests > 0 || srv.web_fetch_requests > 0;
    const hasCache = typeof state.usage.cache_read_input_tokens === 'number';
    output += emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: state.usage.output_tokens,
        ...(hasCache
          ? {
              cache_read_input_tokens: state.usage.cache_read_input_tokens,
              cache_creation_input_tokens: state.usage.cache_creation_input_tokens,
            }
          : {}),
        ...(hasServerTools ? { server_tool_use: srv } : {}),
      },
    });
    output += emit('message_stop', { type: 'message_stop' });
    state.finished = true;
    return output;
  }

  function processEvent(eventBlock: string): string {
    const dataLines = [...eventBlock.matchAll(/^data: ?(.*)$/gm)];
    if (!dataLines.length) return '';
    const payload = dataLines.map((m) => m[1]).join('\n');

    if (payload === '[DONE]') {
      let output = '';
      if (!state.started) output += emitMessageStart();
      return output + finishStream('end_turn');
    }

    let parsed: OpenAIResponseBody;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return '';
    }

    // Propagate upstream SSE error events (content filter, rate limit mid-stream, etc.)
    if (parsed.error) {
      const upstreamError = parsed.error;
      const apiError =
        upstreamError.type === 'api_error'
          ? { type: 'error', error: upstreamError }
          : {
              type: 'error',
              error: { type: 'api_error', message: upstreamError.message || String(upstreamError) },
            };
      let output = emit('error', apiError);
      if (!state.started) output += emitMessageStart();
      output += finishStream('end_turn');
      return output;
    }

    const choice = parsed.choices && parsed.choices[0];
    if (!choice) return '';

    const delta = choice.delta || {};
    let output = '';

    if (!state.started) {
      output += emitMessageStart();
    }

    if (parsed.usage) {
      const usageAny = parsed.usage as ExtendedOpenAIUsage;
      state.usage = {
        input_tokens: parsed.usage.prompt_tokens || 0,
        output_tokens: parsed.usage.completion_tokens || 0,
      };
      // Map cache tokens from OpenAI field names (prompt_cache_hit/miss) to
      // Anthropic field names (cache_read/cache_creation_input_tokens).
      if (typeof usageAny.prompt_cache_hit_tokens === 'number') {
        state.usage.cache_read_input_tokens = usageAny.prompt_cache_hit_tokens;
        state.usage.cache_creation_input_tokens = usageAny.prompt_cache_miss_tokens || 0;
      }
    }

    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      if (state.currentBlockType && state.currentBlockType !== 'thinking') output += closeBlock();
      if (state.currentBlockType !== 'thinking')
        output += openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
      output += appendBlock('thinking_delta', { thinking: delta.reasoning_content });
    }

    if (delta.content) {
      if (state.currentBlockType && state.currentBlockType !== 'text') output += closeBlock();
      if (state.currentBlockType !== 'text')
        output += openBlock('text', { type: 'text', text: '' });
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
          // Track server-side tool requests for usage.server_tool_use
          if (tc.function.name === 'web_search') state.serverToolUse.web_search_requests++;
          else if (tc.function.name === 'web_fetch') state.serverToolUse.web_fetch_requests++;
          output += emit('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
          });
        }
        if (tc.function && tc.function.arguments) {
          const idx =
            tc.index !== undefined && state.toolCallMap[tc.index] !== undefined
              ? state.toolCallMap[tc.index]
              : state.lastToolUseIdx;
          if (idx >= 0) {
            output += emit('content_block_delta', {
              type: 'content_block_delta',
              index: idx,
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
        output += finishStream('end_turn');
      }
      callback(null, output);
    }
  }

  return new StreamTransformer();
}

// --- Anthropic-format SSE interceptor ---
// Lightweight Transform that passes through all SSE events unchanged.
// Web search requests are now handled by the direct response path in
// start-proxy.ts (pre-execute → return results immediately), so the
// interceptor no longer needs to inject server_tool_use counts.

export function createAnthropicStreamInterceptor(
  _preExecutedSearches: number = 0,
  originalModel?: string | null,
): Transform {
  let buf = '';
  let wsCount = _preExecutedSearches; // web_search count
  let wfCount = 0; // web_fetch count
  // Hold back the message_delta event so we can inject server_tool_use
  // into its usage field after we've counted all tool_use blocks.
  let heldDelta: string | null = null;
  // Strip slot prefix (haiku:claude-haiku-4-5-20251001 -> claude-haiku-4-5-20251001)
  const ccModel = originalModel
    ? (originalModel.match(/^[a-z]+:(.+)$/) || [null, originalModel])[1]
    : null;
  let modelRewritten = false;

  class Interceptor extends Transform {
    _transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback): void {
      buf += chunk.toString();
      if (buf.length > 1_048_576) {
        this.destroy(new Error('Anthropic SSE buffer exceeded 1MB'));
        return;
      }

      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      let output = '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) {
          output += '\n\n';
          continue;
        }

        // Rewrite model in message_start so CC trusts server_tool_use.
        if (!modelRewritten && ccModel) {
          const msMatch = trimmed.match(/^event: message_start\ndata: (.+)$/m);
          if (msMatch) {
            try {
              const d = JSON.parse(msMatch[1]);
              const upstreamModel = d.message?.model;
              if (
                upstreamModel &&
                typeof upstreamModel === 'string' &&
                !upstreamModel.startsWith('claude-')
              ) {
                d.message.model = ccModel;
                modelRewritten = true;
                output += 'event: message_start\ndata: ' + JSON.stringify(d) + '\n\n';
                continue;
              }
            } catch (_) {
              /* non-fatal */
            }
          }
        }

        // Count web_search / web_fetch tool_use blocks
        const cbMatch = trimmed.match(/^event: content_block_start\ndata: (.+)$/m);
        if (cbMatch) {
          try {
            const d = JSON.parse(cbMatch[1]);
            const cb = d.content_block;
            if (cb) {
              if (cb.name === 'web_search') wsCount++;
              else if (cb.name === 'web_fetch') wfCount++;
            }
          } catch (_) {
            /* non-fatal */
          }
        }

        // Hold back message_delta so we can inject server_tool_use later
        if (/^event: message_delta$/m.test(trimmed)) {
          heldDelta = trimmed;
          continue;
        }

        // When message_stop arrives, emit the modified message_delta first
        if (/^event: message_stop$/m.test(trimmed) && heldDelta) {
          const dataMatch = heldDelta.match(/^data: (.+)$/m);
          if (dataMatch && (wsCount > 0 || wfCount > 0)) {
            try {
              const parsed = JSON.parse(dataMatch[1]);
              if (!parsed.usage) parsed.usage = {};
              // Only inject server_tool_use if the upstream provider didn't
              // include it. Anthropic returns it natively; DeepSeek and other
              // providers don't. Preferring upstream prevents the interceptor
              // from ever overwriting a correct count with a wrong one.
              if (!parsed.usage.server_tool_use) {
                parsed.usage.server_tool_use = {
                  web_search_requests: wsCount,
                  web_fetch_requests: wfCount,
                };
              }
              output += heldDelta.replace(dataMatch[1], JSON.stringify(parsed)) + '\n\n';
            } catch (_) {
              output += heldDelta + '\n\n';
            }
          } else {
            output += heldDelta + '\n\n';
          }
          heldDelta = null;
          output += trimmed + '\n\n';
          continue;
        }

        output += trimmed + '\n\n';
      }

      callback(null, output);
    }

    _flush(callback: TransformCallback): void {
      // If we have a held message_delta without a following message_stop,
      // emit it as-is (inject server_tool_use if we counted any).
      if (heldDelta && (wsCount > 0 || wfCount > 0)) {
        const dataMatch = heldDelta.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]);
            if (!parsed.usage) parsed.usage = {};
            // Same guard as _transform: prefer upstream server_tool_use.
            if (!parsed.usage.server_tool_use) {
              parsed.usage.server_tool_use = {
                web_search_requests: wsCount,
                web_fetch_requests: wfCount,
              };
            }
            this.push(heldDelta.replace(dataMatch[1], JSON.stringify(parsed)) + '\n\n');
          } catch (_) {
            this.push(heldDelta + '\n\n');
          }
        }
      } else if (heldDelta) {
        this.push(heldDelta + '\n\n');
      }
      if (buf.trim()) {
        callback(null, buf);
      } else {
        callback(null, '');
      }
    }
  }

  return new Interceptor();
}

// --- Google Gemini protocol translation ------------------------------------

/**
 * Convert an Anthropic request body to Google Gemini format.
 * Returns the translated body and the model name (extracted for URL construction).
 */
export function translateRequestToGemini(anthropicBody: AnthropicRequestBody): {
  geminiBody: GeminiRequestBody;
  model: string;
} {
  const model = anthropicBody.model || 'gemini-2.5-flash';
  const geminiBody: GeminiRequestBody = { contents: [] };

  // System prompt → systemInstruction
  if (anthropicBody.system) {
    const parts: GeminiPart[] = [];
    if (typeof anthropicBody.system === 'string') {
      parts.push({ text: anthropicBody.system });
    } else if (Array.isArray(anthropicBody.system)) {
      for (const block of anthropicBody.system) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        }
      }
    }
    if (parts.length > 0) geminiBody.systemInstruction = { parts };
  }

  // Messages → contents
  const messages = anthropicBody.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parts: GeminiPart[] = [];
    let role: GeminiContent['role'] = 'user';

    if (msg.role === 'assistant') {
      role = 'model';
    }

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: (block.input as Record<string, unknown>) || {},
            },
          });
          role = 'model';
        } else if (block.type === 'tool_result') {
          const raw = block.content;
          const content = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
          // Gemini expects tool results in a "function" role message, separated from user text
          const trParts: GeminiPart[] = [
            {
              functionResponse: {
                name: block.tool_use_id ? 'tool_' + block.tool_use_id.slice(0, 8) : 'unknown',
                response: { content },
              },
            },
          ];
          geminiBody.contents.push({ role: 'function', parts: trParts });
          continue;
        } else if (block.type === 'thinking') {
          parts.push({ thought: block.thinking || '' });
        }
      }
    }

    if (parts.length > 0) {
      geminiBody.contents.push({ role, parts });
    }
  }

  // Tools → tools
  if (anthropicBody.tools && anthropicBody.tools.length > 0) {
    const functionDeclarations: GeminiFunctionDeclaration[] = anthropicBody.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: (t.input_schema as Record<string, unknown>) || { type: 'object', properties: {} },
    }));
    geminiBody.tools = [{ functionDeclarations }];
  }

  // Tool choice → toolConfig
  if (anthropicBody.tool_choice !== undefined) {
    const tc = anthropicBody.tool_choice;
    if (typeof tc === 'string') {
      if (tc === 'auto') geminiBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      else if (tc === 'any') geminiBody.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      else if (tc === 'none') geminiBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (typeof tc === 'object') {
      const obj = tc as { type?: string; name?: string };
      if (obj.type === 'auto') geminiBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      else if (obj.type === 'any')
        geminiBody.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: obj.name ? [obj.name] : undefined,
          },
        };
      else if (obj.type === 'none')
        geminiBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    }
  }

  // Generation config
  const genConfig: GeminiRequestBody['generationConfig'] = {};
  if (anthropicBody.max_tokens !== undefined) genConfig.maxOutputTokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature !== undefined) genConfig.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p !== undefined) genConfig.topP = anthropicBody.top_p;
  if (anthropicBody.stop_sequences && anthropicBody.stop_sequences.length > 0) {
    genConfig.stopSequences = anthropicBody.stop_sequences;
  }
  if (Object.keys(genConfig).length > 0) geminiBody.generationConfig = genConfig;

  // Thinking config
  if (anthropicBody.thinking) {
    const thinkingCfg = anthropicBody.thinking as { type?: string; budget_tokens?: number };
    if (thinkingCfg.type === 'enabled' && thinkingCfg.budget_tokens) {
      geminiBody.thinkingConfig = { thinkingBudget: thinkingCfg.budget_tokens };
    }
  }

  return { geminiBody, model };
}

/**
 * Transform stream that converts Google Gemini SSE events to Anthropic SSE format.
 * Gemini streams accumulate content in each event — the transform diffs against
 * the previous state to produce clean Anthropic deltas.
 */
export function createGeminiToAnthropicStream(): Transform {
  let started = false;
  let finished = false;
  let blockIndex = 0;
  let currentBlockType: 'text' | 'tool_use' | null = null;
  let prevText = '';
  let toolCallName = '';
  let toolCallId = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  const messageId = `msg_${crypto.randomUUID()}`;

  function emit(eventType: string, data: Record<string, unknown>): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function closeBlock(output: string[]): void {
    if (!currentBlockType) return;
    const idx = blockIndex - 1;
    output.push(emit('content_block_stop', { type: 'content_block_stop', index: idx }));
    currentBlockType = null;
  }

  function openBlock(
    type: 'text' | 'tool_use',
    contentBlock: Record<string, unknown>,
    output: string[],
  ): number {
    const idx = blockIndex++;
    currentBlockType = type;
    output.push(
      emit('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: contentBlock,
      }),
    );
    return idx;
  }

  function appendDelta(deltaType: string, delta: Record<string, unknown>, output: string[]): void {
    const idx = blockIndex - 1;
    output.push(
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: deltaType, ...delta },
      }),
    );
  }

  function startStream(output: string[]): void {
    started = true;
    output.push(
      emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: null,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  function finishStream(stopReason: string, output: string[]): void {
    closeBlock(output);
    output.push(
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      }),
    );
    output.push(emit('message_stop', { type: 'message_stop' }));
    finished = true;
  }

  // Map Gemini finishReason to Anthropic stop_reason
  function mapGeminiStopReason(reason?: string): string {
    if (!reason) return 'end_turn';
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
        return 'end_turn';
      case 'RECITATION':
        return 'end_turn';
      case 'MALFORMED_FUNCTION_CALL':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  let buffer = '';

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (finished) {
        callback(null);
        return;
      }

      buffer += chunk.toString();
      const output: string[] = [];

      // Process complete SSE events (delimited by \n\n)
      while (buffer.includes('\n\n')) {
        const idx = buffer.indexOf('\n\n');
        const eventStr = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataMatch = eventStr.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        try {
          const event: GeminiSSEEvent = JSON.parse(dataMatch[1]);
          if (!event.candidates || event.candidates.length === 0) {
            if (event.usageMetadata) {
              usage = {
                input_tokens: event.usageMetadata.promptTokenCount || 0,
                output_tokens: event.usageMetadata.candidatesTokenCount || 0,
              };
            }
            continue;
          }

          const candidate = event.candidates[0];
          const content = candidate.content;

          // Handle finish reason
          if (candidate.finishReason && !finished) {
            if (!started) startStream(output);
            const stopReason = mapGeminiStopReason(candidate.finishReason);
            finishStream(stopReason, output);
            if (event.usageMetadata) {
              usage = {
                input_tokens: event.usageMetadata.promptTokenCount || 0,
                output_tokens: event.usageMetadata.candidatesTokenCount || 0,
              };
            }
            continue;
          }

          if (event.usageMetadata) {
            usage = {
              input_tokens: event.usageMetadata.promptTokenCount || 0,
              output_tokens: event.usageMetadata.candidatesTokenCount || 0,
            };
          }

          if (!content || !Array.isArray(content.parts)) continue;

          for (const part of content.parts) {
            if (part.text !== undefined) {
              if (!started) startStream(output);

              // Gemini streams the FULL accumulated text each event, not deltas.
              // Diff against prevText to produce clean deltas.
              const fullText = part.text;
              const delta = fullText.slice(prevText.length);
              prevText = fullText;

              if (delta.length > 0) {
                if (currentBlockType !== 'text') {
                  closeBlock(output);
                  openBlock('text', { type: 'text', text: '' }, output);
                }
                appendDelta('text_delta', { text: delta }, output);
              }
            } else if (part.functionCall) {
              if (!started) startStream(output);
              closeBlock(output);

              toolCallName = part.functionCall.name;
              toolCallId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

              openBlock(
                'tool_use',
                {
                  type: 'tool_use',
                  id: toolCallId,
                  name: toolCallName,
                  input: {},
                },
                output,
              );
              // Gemini sends the complete functionCall at once — emit full JSON
              const argsJson = JSON.stringify(part.functionCall.args || {});
              appendDelta('input_json_delta', { partial_json: argsJson }, output);
              closeBlock(output);
              prevText = '';
            }
          }
        } catch (_e) {
          // Skip malformed events
        }
      }

      if (output.length > 0) {
        callback(null, output.join(''));
      } else {
        callback(null);
      }
    },
  });
}

/**
 * Convert a Gemini non-streaming response to an Anthropic-format response body.
 * Used for non-streaming requests.
 */
export function translateGeminiResponse(geminiBody: GeminiResponseBody): {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
} {
  const candidate = geminiBody.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content: AnthropicContentBlock[] = [];

  for (const part of parts) {
    if (part.text !== undefined) {
      content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
      });
    }
  }

  const stopReason = (() => {
    switch (candidate?.finishReason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  })();

  const um = geminiBody.usageMetadata || {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  };

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: um.promptTokenCount,
      output_tokens: um.candidatesTokenCount,
    },
  };
}
