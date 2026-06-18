'use strict';

// Strip Anthropic-specific skill descriptions, TRIGGER blocks, and model
// reference paragraphs from the system prompt. Applied unconditionally in the
// OpenAI and Gemini translation paths since translateRequest/translateRequestToGemini
// are only called for non-Anthropic upstream providers.

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
 * Strip Anthropic-specific content from a Claude Code system prompt.
 *
 * Targets:
 * 1. The "The most recent Claude models are..." paragraph with model table
 * 2. Anthropic-only skill entries from the skills list (claude-api, etc.)
 * 3. TRIGGER blocks for Anthropic-only skills
 * 4. Scattered Anthropic model name references
 *
 * Only the OpenAI/Gemini translation paths call this — Anthropic-format
 * providers (DeepSeek /anthropic, Fireworks) pass through unchanged.
 */
export function stripAnthropicSkills(systemContent: string): string {
  const stats = createStats(systemContent.length);

  if (!systemContent) return systemContent;

  let result = systemContent;

  // ── 1. Strip "The most recent Claude models are..." paragraph(s) ──
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

  // ── 2. Strip claude-api TRIGGER block ──
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

  // ── 3. Strip Anthropic-only skill entries from the skills list ──
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

  // ── 4. Clean up any remaining Anthropic model-name litter ──
  // These are scattered references like "Claude Opus 4.8" or
  // "claude-sonnet-4-6" outside the main model table.
  let modelRefCount = 0;
  for (const pattern of ANTHROPIC_MODEL_PATTERNS) {
    result = result.replace(pattern, () => {
      modelRefCount++;
      return 'model';
    });
  }

  // ── 5. Clean up blank lines left by removals ──
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
