'use strict';

/**
 * Validate a pre-execution response body has the fields CC requires
 * to display "Did N searches" correctly.
 *
 * Returns null if valid, or an error message string if invalid.
 *
 * CC requires:
 * - model starts with "claude-" (trusted model name)
 * - content contains web_search_tool_result blocks (CC counts these)
 * - usage.server_tool_use with web_search_requests ≥ 1
 */
export function validatePreExecResponse(body: Record<string, unknown>): string | null {
  if (!body.model || typeof body.model !== 'string') {
    return 'missing model field';
  }
  if (!(body.model as string).startsWith('claude-')) {
    return 'model does not start with claude-: ' + body.model;
  }
  if (!body.content || !Array.isArray(body.content) || body.content.length === 0) {
    return 'missing or empty content array';
  }
  const block = (body.content as Array<Record<string, unknown>>)[0];
  if (block.type !== 'web_search_tool_result' && block.type !== 'text') {
    return 'unexpected content block type: ' + block.type + ' (expected web_search_tool_result)';
  }
  const usage = body.usage as Record<string, unknown> | undefined;
  if (!usage) return 'missing usage';
  const stu = usage.server_tool_use as Record<string, unknown> | undefined;
  if (!stu) return 'missing usage.server_tool_use';
  if (typeof stu.web_search_requests !== 'number' || stu.web_search_requests < 1) {
    return 'web_search_requests missing or < 1';
  }
  return null;
}
