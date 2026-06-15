'use strict';

// =========================================================================
// Protocol Types — Central type registry for Anthropic, OpenAI, and Gemini.
//
// These types encode the EXACT wire formats used by:
//   - Anthropic Messages API (request, response, SSE events)
//   - OpenAI Chat Completions API (request, response, SSE chunks)
//   - Google Gemini API (generateContent, streamGenerateContent)
//
// Also includes ProviderConstraints — a per-provider ruleset that encodes
// behavioral quirks currently scattered as inline comments and ad-hoc mutations
// across start-proxy.ts, forward.ts, and server-tools.ts.
// =========================================================================

// --- Helpers ---------------------------------------------------------------

/** All SSE event types CC expects in an Anthropic-format stream. */
export const SSE_EVENT_TYPES = [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'error',
  'ping',
] as const;
export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

/** Finish reasons from OpenAI mapped to Anthropic stop_reason values. */
export const OPENAI_FINISH_REASONS = ['stop', 'tool_calls', 'length', 'content_filter'] as const;
export type OpenAIFinishReason = (typeof OPENAI_FINISH_REASONS)[number];

export const ANTHROPIC_STOP_REASONS = [
  'end_turn',
  'tool_use',
  'max_tokens',
  'content_filter',
] as const;
export type AnthropicStopReason = (typeof ANTHROPIC_STOP_REASONS)[number];

// --- Content Blocks (Anthropic format) ------------------------------------

export interface ImageSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

export interface DocumentSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

/**
 * Discriminated union of all Anthropic content block types.
 * CC sends these in requests; the proxy reconstructs them in responses.
 *
 * Note: tool_result.content is a recursive type (can contain nested blocks).
 * We use `AnthropicContentBlock[]` for the structured form.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string | AnthropicContentBlock[] }
  | { type: 'image'; source: ImageSource }
  | { type: 'document'; source: DocumentSource; title?: string; file_name?: string }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Legacy alias for backward compatibility with existing code. */
export type ContentBlock = AnthropicContentBlock;

// --- Messages --------------------------------------------------------------

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

// --- Tools -----------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** CC sends tool_choice as either a string or an object. */
export type AnthropicToolChoice =
  | 'auto'
  | 'any'
  | 'none'
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name?: string }
  | { type: 'none' };

// --- Anthropic Request Body ------------------------------------------------

export interface AnthropicThinkingParam {
  type: 'enabled';
  budget_tokens: number;
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  stream?: boolean;
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  /** Anthropic-only. Must be stripped for OpenAI-format providers. */
  top_k?: number;
  stop_sequences?: string[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingParam;
  /** Anthropic-only. Must be stripped for OpenAI-format providers. */
  metadata?: Record<string, unknown>;
}

// --- Anthropic Response (non-streaming) ------------------------------------

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  /** Anthropic-only: cache read token count. */
  cache_read_input_tokens?: number;
  /** Anthropic-only: cache creation token count. */
  cache_creation_input_tokens?: number;
  /** CC reads this to show "Did N searches" in the UI. Must be injected for non-Anthropic providers. */
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
}

export interface AnthropicResponseBody {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// --- Anthropic SSE Events (outbound, what CC consumes) ---------------------

export interface MessageStartPayload {
  id: string;
  type: 'message';
  role: 'assistant';
  content: [];
  model: string;
  stop_reason: null;
  stop_sequence: null;
  usage: { input_tokens: 0; output_tokens: 0 };
}

/** Delta variants in content_block_delta events. */
export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string };

/**
 * Full discriminated union of Anthropic-format SSE events.
 * These are what CC expects to receive from its upstream provider.
 */
export type AnthropicSSEEvent =
  | { type: 'message_start'; message: MessageStartPayload }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: AnthropicStopReason; stop_sequence: null };
      usage: AnthropicUsage;
    }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } }
  | { type: 'ping' };

// --- OpenAI Request Body ---------------------------------------------------

export interface OpenAIMessageContent {
  type: 'text';
  text: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | OpenAIMessageContent[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

export interface OpenAIThinkingParam {
  type: 'enabled';
  reasoning_effort: 'low' | 'medium' | 'high';
}

export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAIFunctionDef[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tool_choice?: OpenAIToolChoice;
  thinking?: OpenAIThinkingParam;
}

// --- OpenAI Response (non-streaming) ---------------------------------------

export interface OpenAIResponseChoice {
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
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
  };
}

export interface OpenAIResponseBody {
  id?: string;
  choices?: OpenAIResponseChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

// --- OpenAI Streaming Chunk (upstream SSE data) ----------------------------

/**
 * Extended usage fields that some providers return in streaming chunks.
 * These are non-standard extensions — accessed via a typed interface rather
 * than type assertions.
 */
export interface ExtendedOpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Non-standard: some providers include cache hit/miss counts. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface OpenAIStreamChunk {
  error?: { type?: string; message?: string };
  choices?: OpenAIResponseChoice[];
  usage?: ExtendedOpenAIUsage;
}

// --- Google Gemini API types ------------------------------------------------

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: unknown } };
  inlineData?: { mimeType: string; data: string };
  thought?: string;
}

export interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: GeminiTool[];
  toolConfig?: {
    functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] };
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
  thinkingConfig?: {
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  safetyRatings?: unknown[];
}

export interface GeminiResponseBody {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface GeminiSSEEvent {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// --- Provider Constraints --------------------------------------------------

/**
 * Encodes per-provider behavioral rules that were previously implicit
 * (scattered as comments and ad-hoc field deletions).
 */
export interface ProviderConstraints {
  /** Provider key in routes.json (ds, or, fw, an, oc, etc.) */
  readonly key: string;
  /** Wire format used by this provider */
  readonly format: 'anthropic' | 'openai' | 'gemini';
  /** Provider natively executes web_search_* / web_fetch_* as server-side tools.
   *  Only true for Anthropic direct. */
  readonly nativeServerTools: boolean;
  /** Provider returns usage.server_tool_use natively (only Anthropic direct). */
  readonly nativeServerToolUse: boolean;
  /** Model name must be rewritten to start with 'claude-' for CC tool trust. */
  readonly requiresModelRewrite: boolean;
  /** Provider rejects tool_choice when thinking mode is enabled.
   *  DeepSeek: "Thinking mode does not support this tool_choice". */
  readonly forbidsToolChoiceWithThinking: boolean;
  /** Thinking blocks must be echoed back in subsequent tool-use turns.
   *  DeepSeek Anthropic endpoint requires this; failure → 400. */
  readonly requiresThinkingEcho: boolean;
  /** How thinking/reasoning is expressed in the wire format.
   *  - 'anthropic': {type, budget_tokens} in request body
   *  - 'openai': {type, reasoning_effort} in request body
   *  - null: provider doesn't support thinking */
  readonly thinkingFormat: 'anthropic' | 'openai' | null;
  /** Fields to strip before forwarding (Anthropic-specific in OpenAI endpoints). */
  readonly stripFields: readonly string[];
  /** Provider doesn't participate in auto-fallback chains. */
  readonly noAutoFallback?: boolean;
}

/**
 * Registry of provider constraints keyed by provider identifier.
 * Extends from providers.json but encodes behavioral rules.
 */
export const PROVIDER_CONSTRAINTS: Record<string, ProviderConstraints> = {
  // --- Anthropic (direct) ---
  an: {
    key: 'an',
    format: 'anthropic',
    nativeServerTools: true,
    nativeServerToolUse: true,
    requiresModelRewrite: false,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'anthropic',
    stripFields: [],
    noAutoFallback: true,
  },

  // --- DeepSeek (direct, /anthropic endpoint) ---
  ds: {
    key: 'ds',
    format: 'anthropic',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: true,
    requiresThinkingEcho: true,
    thinkingFormat: 'anthropic',
    stripFields: [],
    noAutoFallback: true,
  },

  // --- OpenRouter ---
  or: {
    key: 'or',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Fireworks AI ---
  fw: {
    key: 'fw',
    format: 'anthropic',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'anthropic',
    stripFields: [],
  },

  // --- OpenCode Zen ---
  oc: {
    key: 'oc',
    format: 'anthropic',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: true,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: [],
    noAutoFallback: true,
  },

  // --- Alibaba/DashScope ---
  al: {
    key: 'al',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Kimi/Moonshot ---
  km: {
    key: 'km',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Xiaomi Mimo ---
  mm: {
    key: 'mm',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Umans AI ---
  um: {
    key: 'um',
    format: 'anthropic',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: [],
    noAutoFallback: true,
  },

  // --- Groq ---
  gr: {
    key: 'gr',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- Mistral ---
  mt: {
    key: 'mt',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- MiniMax ---
  mx: {
    key: 'mx',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- Z.ai / GLM ---
  za: {
    key: 'za',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- BytePlus/Doubao ---
  bp: {
    key: 'bp',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- SiliconFlow ---
  sf: {
    key: 'sf',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Novita ---
  nv: {
    key: 'nv',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: 'openai',
    stripFields: ['top_k', 'metadata'],
  },

  // --- Google Gemini ---
  gm: {
    key: 'gm',
    format: 'gemini',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata', 'stop_sequences'],
    noAutoFallback: true,
  },
} as const satisfies Record<string, ProviderConstraints>;

/** Resolve constraints for a provider key. Defaults to conservative settings. */
export function getConstraints(key: string): ProviderConstraints {
  const c = PROVIDER_CONSTRAINTS[key];
  if (c) return c;
  // Unknown providers: assume OpenAI format, no native server tools,
  // require model rewrite, strip Anthropic-specific fields.
  return {
    key,
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  };
}

/** Whether this provider key corresponds to the Anthropic API. */
export function isAnthropicProvider(constraints: ProviderConstraints): boolean {
  return constraints.nativeServerTools;
}

// --- SSE Serialization Helpers ---------------------------------------------

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Serialize an Anthropic SSE event to the wire format. */
export function serializeSSEEvent(ev: AnthropicSSEEvent): string {
  switch (ev.type) {
    case 'message_start':
      return sseLine('message_start', ev.message);
    case 'content_block_start':
      return sseLine('content_block_start', {
        index: ev.index,
        content_block: ev.content_block,
      });
    case 'content_block_delta':
      return sseLine('content_block_delta', { index: ev.index, delta: ev.delta });
    case 'content_block_stop':
      return sseLine('content_block_stop', { index: ev.index });
    case 'message_delta':
      return sseLine('message_delta', ev);
    case 'message_stop':
      return sseLine('message_stop', {});
    case 'error':
      return sseLine('error', { error: ev.error });
    case 'ping':
      return sseLine('ping', {});
  }
}

/**
 * Parse a single SSE data line into a typed AnthropicSSEEvent.
 * The `eventType` comes from the `event:` line; `dataStr` from the `data:` line.
 * Returns null if the event type is unrecognized or the JSON is malformed.
 */
export function parseSSEEventData(eventType: string, dataStr: string): AnthropicSSEEvent | null {
  try {
    const parsed = JSON.parse(dataStr);
    switch (eventType) {
      case 'message_start':
        return { type: 'message_start', message: parsed as MessageStartPayload };
      case 'content_block_start':
        return {
          type: 'content_block_start',
          index: parsed.index ?? 0,
          content_block: parsed.content_block as AnthropicContentBlock,
        };
      case 'content_block_delta':
        return {
          type: 'content_block_delta',
          index: parsed.index ?? 0,
          delta: parsed.delta as AnthropicDelta,
        };
      case 'content_block_stop':
        return { type: 'content_block_stop', index: parsed.index ?? 0 };
      case 'message_delta':
        return {
          type: 'message_delta',
          delta: parsed.delta as { stop_reason: AnthropicStopReason; stop_sequence: null },
          usage: parsed.usage as AnthropicUsage,
        };
      case 'message_stop':
        return { type: 'message_stop' };
      case 'error':
        return { type: 'error', error: parsed.error as { type: string; message: string } };
      case 'ping':
        return { type: 'ping' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Extract event type and data from a raw SSE event string.
 * Format: "event: <type>\ndata: <json>"
 */
export function parseSSEEventRaw(raw: string): { eventType: string; dataStr: string } | null {
  // Use regex to extract event and data lines
  const evMatch = raw.match(/^event:\s*(\S+)/m);
  const dataMatch = raw.match(/^data:\s*(.+)/m);
  if (!evMatch || !dataMatch) return null;
  return { eventType: evMatch[1], dataStr: dataMatch[1] };
}

// --- Finish Reason Mapping -------------------------------------------------

const FINISH_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'content_filter',
};

export function mapFinishReason(reason: string | null | undefined): AnthropicStopReason {
  return (reason && FINISH_REASON_MAP[reason]) || 'end_turn';
}

// --- Tool Choice Translation -----------------------------------------------

export function translateToolChoice(tc: AnthropicToolChoice): OpenAIToolChoice {
  // Handle string forms
  if (typeof tc === 'string') {
    if (tc === 'any') return 'required';
    if (tc === 'auto' || tc === 'none') return tc;
    return 'auto';
  }
  // Handle object forms
  const obj = tc as { type?: string; name?: string };
  if (obj.type === 'any') return 'required';
  if (obj.type === 'tool' && obj.name) {
    return { type: 'function', function: { name: obj.name } };
  }
  if (obj.type === 'none') return 'none';
  // Default fallback
  return 'auto';
}
