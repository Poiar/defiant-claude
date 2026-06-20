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
 *
 * Updated 2026-06-16 with new Anthropic API blocks: search_result, compaction,
 * fallback, mid_conv_system, web_search_tool_result, web_fetch_tool_result.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string; citations?: TextCitation[] }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      caller?: { type: 'direct' };
    }
  | { type: 'tool_result'; tool_use_id?: string; content?: string | AnthropicContentBlock[] }
  | { type: 'image'; source: ImageSource }
  | {
      type: 'document';
      source: DocumentSource;
      title?: string;
      file_name?: string;
      context?: string;
    }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'web_search_tool_result';
      tool_use_id?: string;
      caller?: { type: 'direct' };
      content?: string | AnthropicContentBlock[];
    }
  | {
      type: 'web_fetch_tool_result';
      tool_use_id?: string;
      caller?: { type: 'direct' };
      content?: string | AnthropicContentBlock[];
    }
  | {
      type: 'web_search_result';
      url: string;
      title: string;
      encrypted_content: string;
      page_age: string | null;
    }
  | { type: 'search_result'; source: string; title: string; content: AnthropicContentBlock[] }
  | { type: 'compaction'; content?: string; encrypted_content?: string }
  | { type: 'mid_conv_system'; content: { type: 'text'; text: string }[] }
  | { type: 'fallback'; from: { model: string }; to?: { model: string } };

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
  /** Anthropic-only: cache creation token count (legacy flat field). */
  cache_creation_input_tokens?: number;
  /** New granular cache creation breakdown (2026 API). */
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  /** Geographic region where inference was served. */
  inference_geo?: string;
  /** Service tier that processed the request (auto, standard, scaled). */
  service_tier?: 'auto' | 'standard' | 'scaled' | string;
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
  stop_details: Record<string, unknown> | null;
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

/** Citation within a text block. */
export interface TextCitation {
  type:
    | 'char_location'
    | 'page_location'
    | 'content_block_location'
    | 'web_search_result_location'
    | 'search_result_location';
  cited_text: string;
  document_index?: number;
  document_title?: string | null;
  start_char_index?: number;
  end_char_index?: number;
  start_page_number?: number;
  end_page_number?: number;
  start_block_index?: number;
  end_block_index?: number;
  file_id?: string | null;
  url?: string;
  title?: string;
  encrypted_index?: string;
}

/** Delta variants in content_block_delta events. */
export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string; estimated_tokens?: number }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'citations_delta'; citation: TextCitation }
  | { type: 'compaction_delta'; content: string; encrypted_content: string };

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
    stripFields: ['metadata'],
    noAutoFallback: false,
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
    stripFields: ['metadata'],
    noAutoFallback: false,
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
    noAutoFallback: false,
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

  // --- OpenAI (direct) ---
  oa: {
    key: 'oa',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- xAI / Grok ---
  xa: {
    key: 'xa',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
  },

  // --- Ollama (local) ---
  lo: {
    key: 'lo',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
    noAutoFallback: true,
  },

  // --- LM Studio (local) ---
  ls: {
    key: 'ls',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
    noAutoFallback: true,
  },

  // --- llama.cpp (local) ---
  lc: {
    key: 'lc',
    format: 'openai',
    nativeServerTools: false,
    nativeServerToolUse: false,
    requiresModelRewrite: true,
    forbidsToolChoiceWithThinking: false,
    requiresThinkingEcho: false,
    thinkingFormat: null,
    stripFields: ['top_k', 'metadata'],
    noAutoFallback: true,
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

/**
 * When true, the provider speaks native Anthropic with full server-tool support
 * — no tool conversion, no protocol translation, no server_tool_use injection
 * needed. The proxy forwards Anthropic-format requests and responses byte-for-byte
 * (with only additive mutations: thinking-block caching, spend tracking).
 *
 * Currently only true for Anthropic direct ("an"). Every other provider requires
 * some level of translation or field injection.
 *
 * Used consistently across start-proxy.ts (preprocessing gate), forward.ts
 * (response handling), and server-tools.ts (tool conversion decisions) so the
 * "passthrough" concept is a single checkable predicate, not scattered inline
 * comparisons.
 */
export function isPassthroughProvider(constraints: ProviderConstraints): boolean {
  return constraints.nativeServerTools && constraints.nativeServerToolUse;
}

/** @deprecated Use isPassthroughProvider instead. */
export function isAnthropicProvider(constraints: ProviderConstraints): boolean {
  return constraints.nativeServerTools;
}

/**
 * Strip provider-unsupported fields from the request body.
 * Keeps the request body identical across sessions so disk caches
 * recognize the prefix regardless of session-specific metadata.
 * Returns true if any fields were stripped.
 */
export function stripProviderFields(
  body: Record<string, unknown>,
  constraints: ProviderConstraints,
): boolean {
  if (!constraints.stripFields || constraints.stripFields.length === 0) return false;
  let stripped = false;
  for (const field of constraints.stripFields) {
    if (field in body) {
      delete body[field];
      stripped = true;
    }
  }
  return stripped;
}

/**
 * Strip the x-anthropic-billing-header text block from the system prompt.
 * Claude Code injects this as `system[0]` — it contains a `cch` hash that
 * changes every request (119 unique values in 125 dumps) and a `cc_version`
 * that varies across CC auto-updates. It is Anthropic billing metadata with
 * no meaning outside Anthropic's API. Stripping it entirely keeps the
 * upstream body stable for DeepSeek's disk cache.
 *
 * Returns true if the billing header was stripped.
 */
export function stripSystemBillingHeader(body: Record<string, unknown>): boolean {
  const system = body.system;
  if (!Array.isArray(system)) return false;
  for (let i = 0; i < system.length; i++) {
    const block = system[i];
    if (
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string' &&
      ((block as Record<string, unknown>).text as string).includes('x-anthropic-billing-header')
    ) {
      system.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Strip Anthropic prompt-caching `cache_control` from all content blocks.
 * CC tags the last turn's tool_result with `cache_control: {type:"ephemeral"}`
 * to mark it for Anthropic's prompt cache. Non-Anthropic providers don't
 * implement this — the field is dead weight that adds per-request variance
 * (which message is "last" changes every turn).
 *
 * Returns true if any cache_control blocks were stripped.
 */
export function stripCacheControl(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let stripped = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete (block as Record<string, unknown>).cache_control;
        stripped = true;
      }
    }
  }
  return stripped;
}

// --- Message deduplication --------------------------------------------------

/**
 * Deep-compare two values for structural equality.  Handles primitives,
 * arrays, and plain objects (recursively).  Does not handle Set, Map,
 * Date, or RegExp — those are treated as unequal unless they share a
 * reference (which won't happen across JSON parse boundaries).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in bObj)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Strip exact-duplicate consecutive messages from the messages array.
 * Claude Code sometimes resends the same tool_result block when retrying
 * a tool call.  Consecutive identical messages add zero information but
 * consume cache-miss tokens at $0.14–0.435/M.
 *
 * Returns true if any messages were stripped.
 */
export function stripDuplicateMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 2) return false;

  let stripped = false;
  let i = 1;
  while (i < messages.length) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev &&
      curr &&
      typeof prev === 'object' &&
      typeof curr === 'object' &&
      (prev as Record<string, unknown>).role === (curr as Record<string, unknown>).role &&
      deepEqual(
        (prev as Record<string, unknown>).content,
        (curr as Record<string, unknown>).content,
      )
    ) {
      messages.splice(i, 1);
      stripped = true;
      // Don't increment — check the next message against the same prev
    } else {
      i++;
    }
  }
  return stripped;
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

// =========================================================================
// Runtime Protocol Conformance — validates unknown JSON against known types
// and reports unrecognized fields. Used by the proxy to auto-detect when
// Anthropic or upstream providers add new fields to the API.
// =========================================================================

/** Known top-level fields in AnthropicResponseBody */
const KNOWN_RESPONSE_FIELDS = new Set([
  'id',
  'type',
  'role',
  'content',
  'model',
  'stop_reason',
  'stop_sequence',
  'stop_details',
  'usage',
]);

/** Known usage sub-fields in AnthropicUsage */
const KNOWN_USAGE_FIELDS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_creation',
  'inference_geo',
  'service_tier',
  'server_tool_use',
]);

/** Known content block types */
const KNOWN_CONTENT_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'image',
  'document',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'web_search_result',
  'search_result',
  'compaction',
  'mid_conv_system',
  'fallback',
]);

/** Known delta types in content_block_delta events */
const KNOWN_DELTA_TYPES = new Set([
  'text_delta',
  'thinking_delta',
  'signature_delta',
  'input_json_delta',
  'citations_delta',
  'compaction_delta',
]);

/** Known SSE event types */
const KNOWN_SSE_EVENT_TYPES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'error',
  'ping',
]);

export interface ConformanceResult {
  valid: boolean;
  unrecognizedFields: string[];
  unrecognizedContentBlockTypes: string[];
  unrecognizedDeltaTypes: string[];
  unrecognizedUsageFields: string[];
}

/**
 * Validate an Anthropic response body against the known type schema.
 * Reports any unrecognized fields so operators can update the types.
 */
export function validateResponseConformance(body: Record<string, unknown>): ConformanceResult {
  const result: ConformanceResult = {
    valid: true,
    unrecognizedFields: [],
    unrecognizedContentBlockTypes: [],
    unrecognizedDeltaTypes: [],
    unrecognizedUsageFields: [],
  };

  // Check top-level fields
  for (const key of Object.keys(body)) {
    if (!KNOWN_RESPONSE_FIELDS.has(key)) {
      result.unrecognizedFields.push('response.' + key);
      result.valid = false;
    }
  }

  // Check content blocks
  if (Array.isArray(body.content)) {
    for (let i = 0; i < (body.content as unknown[]).length; i++) {
      const block = (body.content as Record<string, unknown>[])[i];
      if (block && typeof block === 'object') {
        if (typeof block.type === 'string' && !KNOWN_CONTENT_BLOCK_TYPES.has(block.type)) {
          result.unrecognizedContentBlockTypes.push('content[' + i + '].type=' + block.type);
          result.valid = false;
        }
      }
    }
  }

  // Check usage fields
  if (body.usage && typeof body.usage === 'object') {
    for (const key of Object.keys(body.usage as Record<string, unknown>)) {
      if (!KNOWN_USAGE_FIELDS.has(key)) {
        result.unrecognizedUsageFields.push('usage.' + key);
        result.valid = false;
      }
    }
  }

  return result;
}

/**
 * Validate an Anthropic SSE event against the known event type and delta schema.
 */
export function validateStreamEventConformance(
  eventType: string,
  data: Record<string, unknown>,
): ConformanceResult {
  const result: ConformanceResult = {
    valid: true,
    unrecognizedFields: [],
    unrecognizedContentBlockTypes: [],
    unrecognizedDeltaTypes: [],
    unrecognizedUsageFields: [],
  };

  if (!KNOWN_SSE_EVENT_TYPES.has(eventType)) {
    result.unrecognizedFields.push('event.type=' + eventType);
    result.valid = false;
  }

  if (eventType === 'content_block_start' && data.content_block) {
    const block = data.content_block as Record<string, unknown>;
    if (typeof block.type === 'string' && !KNOWN_CONTENT_BLOCK_TYPES.has(block.type)) {
      result.unrecognizedContentBlockTypes.push('block.type=' + block.type);
      result.valid = false;
    }
  }

  if (eventType === 'content_block_delta' && data.delta) {
    const delta = data.delta as Record<string, unknown>;
    if (typeof delta.type === 'string' && !KNOWN_DELTA_TYPES.has(delta.type)) {
      result.unrecognizedDeltaTypes.push('delta.type=' + delta.type);
      result.valid = false;
    }
  }

  if (eventType === 'message_delta' && data.usage) {
    for (const key of Object.keys(data.usage as Record<string, unknown>)) {
      if (!KNOWN_USAGE_FIELDS.has(key)) {
        result.unrecognizedUsageFields.push('usage.' + key);
        result.valid = false;
      }
    }
  }

  return result;
}
