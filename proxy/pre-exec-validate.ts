'use strict';

/**
 * Validate a pre-execution response body has the fields CC requires
 * to display "Did N searches" correctly.
 *
 * Returns null if valid, or an error message string if invalid.
 *
 * CC requires:
 * - model starts with "claude-" (trusted model name)
 * - content contains web_search_tool_result blocks (CC counts these for "Did N")
 * - Each web_search_tool_result block has tool_use_id, caller, and content array
 * - Each content entry is a web_search_result block (url, title, encrypted_content)
 * - usage.server_tool_use with web_search_requests ≥ 1
 *
 * Multi-search: validates ALL content blocks (not just content[0]).
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

  const blocks = body.content as Array<Record<string, unknown>>;

  // Validate every content block
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const prefix = 'content[' + bi + ']: ';

    // Accept text blocks as fallback (for non-web-search responses)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        return prefix + 'text block missing text field';
      }
      continue;
    }

    if (block.type !== 'web_search_tool_result') {
      return (
        prefix +
        'unexpected content block type: ' +
        block.type +
        ' (expected web_search_tool_result or text)'
      );
    }

    // Validate web_search_tool_result has required fields
    if (typeof block.tool_use_id !== 'string') {
      return prefix + 'web_search_tool_result missing tool_use_id';
    }
    if (!block.caller || typeof block.caller !== 'object') {
      return prefix + 'web_search_tool_result missing caller';
    }
    const caller = block.caller as Record<string, unknown>;
    if (typeof caller.type !== 'string') {
      return prefix + 'web_search_tool_result caller missing type';
    }
    if (
      !block.content ||
      !Array.isArray(block.content) ||
      (block.content as unknown[]).length === 0
    ) {
      return prefix + 'web_search_tool_result missing or empty content array';
    }

    // Validate each web_search_result sub-block
    const results = block.content as Array<Record<string, unknown>>;
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri];
      if (r.type !== 'web_search_result') {
        return (
          prefix +
          'sub-block[' +
          ri +
          ']: unexpected sub-block type: ' +
          r.type +
          ' (expected web_search_result)'
        );
      }
      if (typeof r.url !== 'string') {
        return prefix + 'sub-block[' + ri + ']: missing url';
      }
      if (typeof r.title !== 'string') {
        return prefix + 'sub-block[' + ri + ']: missing title';
      }
      if (typeof r.encrypted_content !== 'string') {
        return prefix + 'sub-block[' + ri + ']: missing encrypted_content';
      }
    }
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
