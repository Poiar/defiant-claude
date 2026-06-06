'use strict';

const { Transform } = require('stream');
const crypto = require('crypto');

function mapFinishReason(reason) {
  const map = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'content_filter' };
  return map[reason] || 'end_turn';
}

function stringifyContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b.type === 'text' ? b.text : '')).join('\n');
  }
  return String(content);
}

// --- Request translation ---

function translateRequest(anthropicBody) {
  const model = anthropicBody.model;
  const openaiBody = {
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
        .filter(b => b.type === 'text')
        .map(b => b.text)
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
  if (anthropicBody.stop_sequences && anthropicBody.stop_sequences.length) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }
  if (anthropicBody.tool_choice !== undefined) {
    openaiBody.tool_choice = translateToolChoice(anthropicBody.tool_choice);
  }

  return { openaiBody, model };
}

function convertMessage(msg) {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }
    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    const textBlocks = msg.content.filter(b => b.type === 'text' && b.text);
    if (toolResults.length > 0) {
      const result = toolResults.map(block => ({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: stringifyContent(block.content),
      }));
      if (textBlocks.length > 0) {
        result.push({ role: 'user', content: textBlocks.map(b => b.text).join('\n') });
      }
      return result;
    }
    const hasImage = msg.content.some(b => b.type === 'image');
    if (hasImage) {
      const content = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'image' && block.source) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      return { role: 'user', content };
    }
    return {
      role: 'user',
      content: msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    };
  }

  if (msg.role === 'assistant') {
    if (typeof msg.content === 'string') {
      return { role: 'assistant', content: msg.content };
    }
    const textParts = [];
    const toolCalls = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
    const result = { role: 'assistant' };
    result.content = textParts.length ? textParts.join('\n') : null;
    if (toolCalls.length) result.tool_calls = toolCalls;
    return result;
  }

  return msg;
}

function translateToolChoice(tc) {
  if (tc === 'auto' || tc === 'any') {
    return tc === 'any' ? 'required' : 'auto';
  }
  if (tc && tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return 'auto';
}

// --- Response translation ---

function translateResponse(openaiBody, model) {
  const choice = openaiBody.choices && openaiBody.choices[0];
  const message = choice ? choice.message : {};
  const finishReason = choice ? choice.finish_reason : null;
  const usage = openaiBody.usage || {};

  const content = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
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

function createStreamTransformer(model) {
  const state = {
    started: false,
    finished: false,
    blockIndex: 0,
    currentBlockType: null,
    messageId: `msg_${crypto.randomUUID()}`,
    model,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  function emit(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function closeBlock() {
    if (!state.currentBlockType) return '';
    const idx = state.blockIndex - 1;
    state.currentBlockType = null;
    return emit('content_block_stop', { type: 'content_block_stop', index: idx });
  }

  function openBlock(type, contentBlock) {
    const idx = state.blockIndex++;
    state.currentBlockType = type;
    return emit('content_block_start', {
      type: 'content_block_start', index: idx, content_block: contentBlock,
    });
  }

  function appendBlock(deltaType, delta) {
    const idx = state.blockIndex - 1;
    return emit('content_block_delta', {
      type: 'content_block_delta', index: idx,
      delta: { type: deltaType, ...delta },
    });
  }

  function finishStream(stopReason) {
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

  function processEvent(eventBlock) {
    const dataMatch = eventBlock.match(/^data: (.+)$/m);
    if (!dataMatch) return '';
    const payload = dataMatch[1];

    if (payload === '[DONE]') {
      return finishStream('end_turn');
    }

    let parsed;
    try { parsed = JSON.parse(payload); } catch { return ''; }

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
          output += openBlock('tool_use', {
            type: 'tool_use', id: tc.id, name: tc.function.name, input: {},
          });
        }
        if (tc.function && tc.function.arguments) {
          output += appendBlock('input_json_delta', { partial_json: tc.function.arguments });
        }
      }
    }

    if (choice.finish_reason) {
      output += finishStream(mapFinishReason(choice.finish_reason));
    }

    return output;
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      this._buf = (this._buf || '') + chunk.toString();
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
    },
    flush(callback) {
      let output = '';
      if (this._buf && this._buf.trim()) {
        if (!state.finished) output += processEvent(this._buf.trim());
      }
      if (!state.finished) {
        output += finishStream('end_turn');
      }
      callback(null, output);
    },
  });
}

module.exports = { translateRequest, translateResponse, createStreamTransformer };
