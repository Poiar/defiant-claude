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

export interface FilterStats {
  bytesBefore: number;
  bytesAfter: number;
  skillsStripped: string[];
  modelRefsStripped: number;
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
 * 1. Normalise `currentDate` to a fixed date (changes daily)
 * 2. Strip gitStatus block (changes after every commit)
 * 3. Strip memory recall (varies between sessions)
 *
 * Anthropic-specific removals:
 * 4. Strip "The most recent Claude models are..." paragraph + model table
 * 5. Strip claude-api TRIGGER block
 * 6. Strip Anthropic-only skill entries (claude-api, code-review, etc.)
 * 7. Replace scattered model-name references (Fable 5, claude-opus-4-8, etc.)
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

  // ── 4. Strip "The most recent Claude models are..." paragraph(s) ──
  // These appear in <system-reminder> blocks and describe Anthropic's model
  // lineup, pricing, and capabilities.  Match from "The most recent Claude
  // models" to the closing ")" of the last model-id spec, then consume any
  // trailing whitespace/newlines up to the next <system-reminder> tag.
  result = result.replace(
    /The most recent Claude models are\b[\s\S]*?Model IDs[\s\S]*?'claude-haiku-4-5-20251001'\)[\s\S]*?(?=\n<system-reminder>)/g,
    (_match) => {
      stats.modelRefsStripped++;
      return '';
    },
  );

  // ── 5. Strip claude-api TRIGGER block ──
  // Format: "TRIGGER — read BEFORE opening the target file...\n"
  // followed by long paragraph, ending before the next skill entry or
  // double newline or system-reminder.
  for (const skill of ANTHROPIC_TRIGGER_SKILLS) {
    const triggerRegex = new RegExp(
      `TRIGGER[ \\u2014-].*?${skill}[\\s\\S]*?(?=\\n- \\w|\\n\\n(?:The following|Available|If)|\\n<system-reminder>|\\n<local-command|$)`,
      'g',
    );
    result = result.replace(triggerRegex, (_match) => {
      stats.skillsStripped.push(`${skill}:trigger`);
      return '';
    });
  }

  // ── 6. Strip Anthropic-only skill entries from the skills list ──
  // Each skill line: "- skill-name: Description\n"
  // Some skills have multi-line descriptions. Match from the skill name
  // through to the next skill entry or end of skills section.
  for (const skill of ANTHROPIC_ONLY_SKILLS) {
    const skillRegex = new RegExp(
      `- ${skill}:.*?(?=\\n- \\w|\\n\\n(?:The following|Available|<)|$)`,
      'gs',
    );
    const before = result;
    result = result.replace(skillRegex, '');
    if (result !== before) {
      stats.skillsStripped.push(skill);
    }
  }

  // ── 7. Clean up any remaining Anthropic model-name litter ──
  // These are scattered references like "Claude Opus 4.8" or
  // "claude-sonnet-4-6" outside the main model table.
  let modelRefCount = 0;
  for (const pattern of ANTHROPIC_MODEL_PATTERNS) {
    result = result.replace(pattern, () => {
      modelRefCount++;
      return 'model';
    });
  }

  // ── 8. Clean up blank lines left by removals ──
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
