'use strict';

// Strip Anthropic-specific content and volatile CC harness metadata from the
// system prompt before forwarding to non-Anthropic providers.  The goal is
// cache-prefix stability: DeepSeek's disk cache requires identical prefixes,
// and every byte that varies between turns is a 120× price penalty.
//
// Applied on all three wire-format paths (Anthropic /anthropic, OpenAI, Gemini).

const log = (() => {
  const { createLogger } = require('./log');
  return createLogger('skill-filter');
})();

// Skills that are Anthropic-specific (reference Claude models, Anthropic API,
// Claude Code features that don't apply to other providers).
const ANTHROPIC_ONLY_SKILLS = [
  'claude-api',
  'code-review',
  'security-review',
  'simplify',
  'run',
  'review',
  'init',
  'keybindings-help',
];

// Anthropic model family names and model IDs that appear in system reminders.
const ANTHROPIC_MODEL_PATTERNS = [
  /The most recent Claude models are\b[\s\S]*?important:\s+Also, when/, // model table paragraph
  /claude-fable-\d/g,
  /claude-opus-\d[\d.-]*/g,
  /claude-sonnet-\d[\d.-]*/g,
  /claude-haiku-\d[\d.-]*/g,
  /claude-mythos[-\w]*/g,
  /Fable \d/g,
  /Opus \d[\d.]*/g,
  /Sonnet \d[\d.]*/g,
  /Haiku \d[\d.]*/g,
  /Anthropic SDK/g,
  /Anthropic API/g,
  /Anthropic\b(?! Code)/g, // "Anthropic" (but not "Anthropic Code" as in code block)
];

// Skill names that appear in TRIGGER blocks — these trigger blocks tell the
// model to read SKILL.md files before answering certain queries.
const ANTHROPIC_TRIGGER_SKILLS = ['claude-api'];

// ── Cache-prefix stabilisers ────────────────────────────────────────────
// These patterns strip or normalise CC harness metadata that changes between
// turns or sessions.  Removing them makes the system prompt prefix identical
// request-to-request so DeepSeek's disk cache hits instead of missing.

// currentDate changes daily and appears early in the prompt.  Normalise it
// to a fixed date so the prefix stays identical across days.
const CURRENT_DATE_RE = /^# currentDate\nToday's date is \d{4}-\d{2}-\d{2}\./gm;

// gitStatus block — changes after every commit.  Strip from the opening
// "# gitStatus" heading through the blank line that follows the last file.
const GIT_STATUS_RE = /^gitStatus:[\s\S]*?(?=\n\n(?:Recent commits|Memory|# |<))/gm;

// Memory recall — CC injects relevant memory files as context.  These vary
// between sessions as memories are added/removed.  Strip the entire recall
// block (from the "memory" heading to the next section boundary).
const MEMORY_RECALL_RE = /^\n?# Memory[\s\S]*?(?=\n# [A-Z])/gm;

// <system-reminder> blocks that are pure CC harness metadata — the model
// doesn't need to see agent type listings, gentle reminders, or model
// availability notices.  These change between CC versions and sessions.
const SYSTEM_REMINDER_STRIP_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'agent-types',
    // "Available agent types for the Agent tool:" through closing tag.
    // Agent types change with CC versions; DeepSeek doesn't use them.
    re: /<system-reminder>\s*Available agent types for the Agent tool:[\s\S]*?<\/system-reminder>\n?/g,
  },
  {
    name: 'task-tools-reminder',
    // "The task tools haven't been used recently..." gentle reminder block.
    // Content includes variable task lists.
    re: /<system-reminder>\s*The task tools haven't been used recently[\s\S]*?<\/system-reminder>\n?/g,
  },
  {
    name: 'provider-unavailable',
    // "All AI providers are currently unavailable" / CRITICAL blocks.
    // These appear dynamically when providers go down.
    re: /<system-reminder>\s*(?:CRITICAL:|IMPORTANT:)\s*"All AI providers are currently unavailable"[\s\S]*?<\/system-reminder>\n?/g,
  },
  {
    name: 'context-management',
    // "When the conversation grows long..." context summarization notes.
    // Harness behavior description, not useful for the model.
    re: /<system-reminder>\s*When the conversation grows long[\s\S]*?<\/system-reminder>\n?/g,
  },
  {
    name: 'local-commands',
    // <local-command> blocks carry CC-specific command metadata that is
    // meaningless to non-Anthropic providers (e.g. /slash-command invocations).
    re: /<local-command>[\s\S]*?<\/local-command>\n?/g,
  },
];

// Recent commits section — appears after gitStatus, changes every commit.
// Strip from "Recent commits:" through the blank line after the last entry.
const RECENT_COMMITS_RE = /^Recent commits:[\s\S]*?(?=\n\n(?:# |<))/gm;

// Empty <system-reminder> blocks left after content was stripped from them.
const EMPTY_SYSTEM_REMINDER_RE = /<system-reminder>\s*<\/system-reminder>\n?/g;

export interface FilterStats {
  bytesBefore: number;
  bytesAfter: number;
  skillsStripped: string[];
  modelRefsStripped: number;
}

/** Escape regex special characters in a string for safe RegExp construction. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createStats(bytesBefore: number): FilterStats {
  return {
    bytesBefore,
    bytesAfter: 0,
    skillsStripped: [],
    modelRefsStripped: 0,
  };
}

/**
 * Strip Anthropic-specific and volatile content from a system prompt.
 *
 * Cache-prefix stabilisers (strip / normalise metadata that changes between turns):
 * 1. Normalise `currentDate` to a fixed date
 * 2. Strip gitStatus block
 * 3. Strip memory recall
 * 4. Strip volatile <system-reminder> blocks (agent types, reminders, etc.)
 * 5. Strip "Recent commits:" section
 * 6. Clean up empty <system-reminder> blocks
 *
 * Anthropic-specific removals:
 * 7. Strip model lineup paragraph
 * 8. Strip claude-api TRIGGER block
 * 9. Strip Anthropic-only skill entries
 * 10. Replace scattered model-name references
 *
 * Applied on all three wire-format paths: Anthropic /anthropic, OpenAI, Gemini.
 */
export function stripAnthropicSkills(systemContent: string): string {
  const stats = createStats(systemContent.length);

  if (!systemContent) return systemContent;

  let result = systemContent;

  // ── 1. Normalise currentDate to a fixed value ──
  // Changes daily — the #1 cache-prefix breaker for long-running sessions.
  result = result.replace(CURRENT_DATE_RE, "# currentDate\nToday's date is 2026-06-01.");

  // ── 2. Strip gitStatus block ──
  // Changes after every commit.  Strip the entire section.
  result = result.replace(GIT_STATUS_RE, '');

  // ── 3. Strip memory recall ──
  // CC injects relevant memory files; these vary between sessions.
  result = result.replace(MEMORY_RECALL_RE, '');

  // ── 4. Strip volatile <system-reminder> blocks ──
  // Agent type listings, gentle reminders, provider notices, context
  // management notes — all CC harness metadata that changes between versions
  // or sessions.  The model doesn't need these to function.
  for (const { name, re } of SYSTEM_REMINDER_STRIP_PATTERNS) {
    const before = result;
    result = result.replace(re, '');
    if (result !== before) {
      stats.skillsStripped.push(`sys-reminder:${name}`);
    }
  }

  // ── 5. Strip "Recent commits:" section ──
  // Appears after gitStatus, changes every commit.
  result = result.replace(RECENT_COMMITS_RE, '');

  // ── 6. Clean up empty <system-reminder> blocks ──
  // After stripping content from within system-reminder blocks, empty
  // <system-reminder></system-reminder> pairs may remain.
  result = result.replace(EMPTY_SYSTEM_REMINDER_RE, '');

  // ── 7. Strip "The most recent Claude models are..." paragraph(s) ──
  // These appear in <system-reminder> blocks and describe Anthropic's model
  // lineup, pricing, and capabilities.  Match from "The most recent Claude
  // models" to the closing ")" of the last model-id spec.
  //
  // Three termination cases:
  //   a) Followed by <system-reminder> (next block) → lookahead for opening tag
  //   b) Followed by </system-reminder> (within same block) → lookahead for closing tag
  //   c) End of string → no more content
  result = result.replace(
    /The most recent Claude models are\b[\s\S]*?Model IDs[\s\S]*?'claude-haiku-4-5-20251001'\)[\s\S]*?(?=\n<\/?system-reminder>|$)/g,
    (_match) => {
      stats.modelRefsStripped++;
      return '';
    },
  );

  // ── 8. Strip claude-api TRIGGER block ──
  // Format: "TRIGGER — read BEFORE opening the target file...\n"
  // followed by long paragraph, ending before the next skill entry or
  // double newline or system-reminder.
  for (const skill of ANTHROPIC_TRIGGER_SKILLS) {
    const escapedSkill = escapeRegex(skill);
    const triggerRegex = new RegExp(
      `TRIGGER[ \\u2014-].*?${escapedSkill}[\\s\\S]*?(?=\\n- \\w|\\n\\n(?:The following|Available|If)|\\n<system-reminder>|\\n<local-command|$)`,
      'g',
    );
    result = result.replace(triggerRegex, (_match) => {
      stats.skillsStripped.push(`${skill}:trigger`);
      return '';
    });
  }

  // ── 9. Strip Anthropic-only skill entries from the skills list ──
  // Each skill line: "- skill-name: Description\n"
  // Some skills have multi-line descriptions. Match from the skill name
  // through to the next skill entry or end of skills section.
  for (const skill of ANTHROPIC_ONLY_SKILLS) {
    const escapedSkill = escapeRegex(skill);
    const skillRegex = new RegExp(
      `- ${escapedSkill}:.*?(?=\\n- \\w|\\n\\n(?:The following|Available|<)|$)`,
      'gs',
    );
    const before = result;
    result = result.replace(skillRegex, '');
    if (result !== before) {
      stats.skillsStripped.push(skill);
    }
  }

  // ── 10. Clean up any remaining Anthropic model-name litter ──
  // These are scattered references like "Claude Opus 4.8" or
  // "claude-sonnet-4-6" outside the main model table.
  let modelRefCount = 0;
  for (const pattern of ANTHROPIC_MODEL_PATTERNS) {
    result = result.replace(pattern, () => {
      modelRefCount++;
      return 'model';
    });
  }

  // ── 11. Clean up blank lines left by removals ──
  const modified = result !== systemContent;
  if (modified) {
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.trimEnd() + '\n';
  }

  stats.bytesAfter = result.length;
  if (stats.bytesBefore !== stats.bytesAfter) {
    log.info(
      null,
      `Stripped Anthropic skills from system prompt: ${stats.bytesBefore} → ${stats.bytesAfter} bytes (${stats.skillsStripped.join(', ')}, ${stats.modelRefsStripped + modelRefCount} model refs removed)`,
    );
  }

  return result;
}
