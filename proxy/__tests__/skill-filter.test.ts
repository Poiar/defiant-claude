'use strict';

import { stripAnthropicSkills } from '../skill-filter';

describe('stripAnthropicSkills', () => {
  test('passes through content without Anthropic references unchanged', () => {
    const input = 'Be concise.\nBe accurate.';
    expect(stripAnthropicSkills(input)).toBe(input);
  });

  test('strips "The most recent Claude models are..." paragraph', () => {
    const input = `System prompt header.
The most recent Claude models are Fable 5 and the Claude 4.X family. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'.
<system-reminder>
Next section.`;
    const result = stripAnthropicSkills(input);
    expect(result).not.toContain('Fable 5');
    expect(result).not.toContain('claude-fable-5');
    expect(result).not.toContain('claude-opus-4-8');
    expect(result).toContain('<system-reminder>');
    expect(result).toContain('Next section.');
  });

  test('strips claude-api skill from skills list', () => {
    const input = `The following skills are available for use with the Skill tool:
- deep-research: Deep research harness
- update-config: Configure Claude Code
- claude-api: Reference for the Claude API / Anthropic SDK — model ids, pricing, params
- loop: Run a prompt on a recurring interval`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('deep-research');
    expect(result).toContain('update-config');
    expect(result).not.toContain('claude-api');
    expect(result).toContain('- loop:');
  });

  test('strips claude-api TRIGGER block', () => {
    const input = `- claude-api: Reference for Claude API
TRIGGER — read BEFORE opening the target file; don't skip because it "looks like a one-liner" — whenever: the prompt names Claude/Anthropic
in any form (Claude, Anthropic, Fable, Opus, Sonnet, Haiku...)
- next-skill: Something else`;
    const result = stripAnthropicSkills(input);
    expect(result).not.toContain('claude-api');
    expect(result).not.toContain('TRIGGER');
    expect(result).toContain('next-skill');
  });

  test('strips multiple Anthropic-only skills', () => {
    const input = `Skills:
- deep-research: research stuff
- claude-api: anthropic api ref
- verify: verify changes
- code-review: review code
- loop: recurring tasks
- update-config: config stuff`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('deep-research');
    expect(result).toContain('loop');
    expect(result).toContain('update-config');
    expect(result).not.toContain('claude-api');
    expect(result).not.toContain('code-review');
  });

  test('cleans up blank lines after removals', () => {
    const input = `Header.
The most recent Claude models are Fable 5 and the Claude 4.X family. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'.
Footer.`;
    const result = stripAnthropicSkills(input);
    expect(result).not.toContain('Fable 5');
    expect(result).not.toContain('claude');
    // Should not have triple blank lines
    expect(result).not.toMatch(/\n{3,}/);
  });

  test('empty string passes through', () => {
    expect(stripAnthropicSkills('')).toBe('');
  });

  test('strips code-review, security-review, simplify, run, review, init, keybindings-help', () => {
    const input = `Available skills:
- code-review: Review code
- security-review: Security review
- simplify: Simplify code
- run: Run app
- review: Review PR
- init: Init CLAUDE.md
- keybindings-help: Keybindings
- loop: Recurring tasks
- deep-research: Research`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('loop');
    expect(result).toContain('deep-research');
    // All Anthropic-only should be stripped
    for (const skill of [
      'claude-api',
      'code-review',
      'security-review',
      'simplify',
      'run',
      'review',
      'init',
      'keybindings-help',
    ]) {
      expect(result).not.toContain(skill);
    }
  });

  test('replaces scattered Anthropic model references with "model"', () => {
    const input = `You are Claude Code. The model lineup includes Claude Opus 4.8.
Use the Anthropic SDK for integration. Anthropic API is REST-based.
You can access Anthropic for advanced reasoning.
Current models: Fable 5, claude-opus-4-8, claude-sonnet-4-6.`;
    const result = stripAnthropicSkills(input);
    expect(result).not.toMatch(/Fable \d/);
    expect(result).not.toMatch(/claude-opus/);
    expect(result).not.toMatch(/claude-sonnet/);
    expect(result).not.toMatch(/Anthropic SDK/);
    expect(result).not.toMatch(/Anthropic API/);
    // Standalone "Anthropic" (not followed by " Code") replaced with "model"
    expect(result).not.toMatch(/\bAnthropic\b/);
    // Verify replacement text is present
    expect(result).toContain('model');
    // "Claude Code" should NOT be stripped (it's the product name, not model family)
    expect(result).toContain('Claude Code');
  });

  test('preserves "Anthropic Code" but replaces standalone "Anthropic"', () => {
    const input = 'The Anthropic Code reference should stay. But Anthropic alone should go.';
    const result = stripAnthropicSkills(input);
    // "Anthropic Code" preserved (negative lookahead excludes it)
    expect(result).toContain('Anthropic Code');
    // Standalone "Anthropic" replaced
    expect(result).toContain('model alone');
    expect(result).not.toMatch(/\bAnthropic\b(?! Code)/);
  });

  test('strips skill with multi-line description', () => {
    const input = `Available skills:
- deep-research: Deep research harness.
- claude-api: Reference for the Claude API.
  Second line of description.
  Third line with more details.
- loop: Recurring tasks.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('deep-research');
    expect(result).toContain('loop');
    expect(result).not.toContain('claude-api');
    expect(result).not.toContain('Second line');
    expect(result).not.toContain('Third line');
  });

  test('strips skill at end of input (no delimiter after)', () => {
    const input = '- deep-research: Research stuff\n- claude-api: API reference';
    const result = stripAnthropicSkills(input);
    expect(result).toContain('deep-research');
    expect(result).not.toContain('claude-api');
  });

  test('strips all Anthropic content from realistic system prompt fragment', () => {
    const input = `You are Claude Code, Anthropic's official CLI.
The most recent Claude models are Fable 5 and the Claude 4.X family. Model IDs — Fable 5: 'claude-fable-5', Opus 4.8: 'claude-opus-4-8', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'.
<system-reminder>
The following skills are available:
- deep-research: Research harness
- claude-api: Reference for Claude API
TRIGGER — read BEFORE opening the target file when the prompt names Claude/Anthropic in any form.
- loop: Recurring tasks
- code-review: Review code
- verify: Verify changes`;
    const result = stripAnthropicSkills(input);
    // Model-agnostic skills kept
    expect(result).toContain('deep-research');
    expect(result).toContain('loop');
    expect(result).toContain('verify');
    // Anthropic-specific stripped
    expect(result).not.toContain('claude-api');
    expect(result).not.toContain('code-review');
    expect(result).not.toContain('TRIGGER');
    // Model references stripped
    expect(result).not.toContain('Fable 5');
    expect(result).not.toContain('claude-opus-4-8');
    // Cleanup: no triple blank lines
    expect(result).not.toMatch(/\n{3,}/);
  });

  test('returns identical string reference when nothing stripped', () => {
    const input = 'Be helpful.\nBe concise.\nUse tools when needed.';
    // Same reference means the function detected no changes and skipped mutation
    expect(stripAnthropicSkills(input)).toBe(input);
  });

  test('strips Anthropic references from Gemini-style system array block', () => {
    // Gemini path receives individual text blocks from system array
    const input =
      "You are Claude Code, Anthropic's official CLI for Claude.\nThe most recent Claude models are Fable 5.";
    const result = stripAnthropicSkills(input);
    expect(result).not.toContain('Fable 5');
    expect(result).not.toMatch(/\bAnthropic\b/);
    expect(result).toContain('Claude Code');
  });

  // ── Cache-prefix stabilisers ──────────────────────────────────────────

  test('normalises currentDate to a fixed date', () => {
    const input = "# currentDate\nToday's date is 2026-06-19.\nSome content after.";
    const result = stripAnthropicSkills(input);
    expect(result).toContain("Today's date is 2026-06-01.");
    expect(result).not.toContain('2026-06-19');
    expect(result).toContain('Some content after.');
  });

  test('strips gitStatus block', () => {
    const input = `Some prefix.
gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot...
M proxy/skill-filter.ts
?? proxy/new-file.ts

Recent commits:
abc1234 fix: something`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Some prefix.');
    expect(result).toContain('Recent commits:');
    expect(result).not.toContain('gitStatus');
    expect(result).not.toContain('M proxy/skill-filter.ts');
  });

  test('strips memory recall block', () => {
    const input = `# Project context

# Memory
Some recalled memory content.
Another line of memory.

# Instructions
Be helpful.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('# Project context');
    expect(result).toContain('# Instructions');
    expect(result).toContain('Be helpful.');
    expect(result).not.toContain('Some recalled memory');
    expect(result).not.toContain('Another line of memory');
  });

  test('strips all three cache-prefix breakers together', () => {
    const input = `You are a helpful assistant.
# currentDate
Today's date is 2026-06-19.
# Environment
Platform: win32
gitStatus: M file1.ts
?? file2.ts

# Memory
Remember this: important context.
Also this.
# Project instructions
Write good code.`;
    const result = stripAnthropicSkills(input);
    // currentDate normalised
    expect(result).toContain('2026-06-01');
    expect(result).not.toContain('2026-06-19');
    // gitStatus stripped
    expect(result).not.toContain('M file1.ts');
    expect(result).not.toContain('?? file2.ts');
    // Memory stripped
    expect(result).not.toContain('Remember this');
    expect(result).not.toContain('Also this');
    // Important content kept
    expect(result).toContain('You are a helpful assistant');
    expect(result).toContain('Platform: win32');
    expect(result).toContain('# Project instructions');
    expect(result).toContain('Write good code.');
  });

  // ── <system-reminder> block stripping ──────────────────────────────────

  test('strips Available agent types system-reminder block', () => {
    const input = `Core prompt.
<system-reminder>
Available agent types for the Agent tool:
- claude: Catch-all agent
- Explore: Read-only search agent
</system-reminder>
More content.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Core prompt.');
    expect(result).toContain('More content.');
    expect(result).not.toContain('Available agent types');
    expect(result).not.toContain('claude: Catch-all');
    expect(result).not.toContain('<system-reminder>');
  });

  test('strips task tools reminder system-reminder block', () => {
    const input = `Header.
<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate.
Here are the existing tasks:

#1. [in_progress] Some task
</system-reminder>
Footer.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Header.');
    expect(result).toContain('Footer.');
    expect(result).not.toContain('TaskCreate');
    expect(result).not.toContain('in_progress');
  });

  test('strips provider unavailable CRITICAL system-reminder', () => {
    const input = `Before.
<system-reminder>
CRITICAL: "All AI providers are currently unavailable" is a system-reminder — NOT a blocker.
The harness retries automatically.
</system-reminder>
After.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
    expect(result).not.toContain('CRITICAL');
    expect(result).not.toContain('unavailable');
  });

  test('strips context management system-reminder block', () => {
    const input = `Start.
<system-reminder>
When the conversation grows long, some or all of the current context is summarized;
the summary is provided in the next context window so work can continue.
</system-reminder>
End.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Start.');
    expect(result).toContain('End.');
    expect(result).not.toContain('conversation grows long');
  });

  test('strips Recent commits section', () => {
    const input = `Some content.

Recent commits:
abc1234 fix: something
def5678 feat: another thing

# Next section
More content.`;
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Some content.');
    expect(result).toContain('# Next section');
    expect(result).toContain('More content.');
    expect(result).not.toContain('abc1234');
    expect(result).not.toContain('def5678');
  });

  test('cleans up empty <system-reminder> blocks', () => {
    // After stripping volatile blocks, empty <system-reminder></system-reminder>
    // pairs may remain. These should be cleaned up.
    const input = 'Text.\n<system-reminder>\n</system-reminder>\nMore text.';
    const result = stripAnthropicSkills(input);
    expect(result).toContain('Text.');
    expect(result).toContain('More text.');
    expect(result).not.toContain('<system-reminder>');
    expect(result).not.toContain('</system-reminder>');
  });

  test('preserves CLAUDE.md content while stripping surrounding metadata', () => {
    // The claudeMd system-reminder should survive because it doesn't match
    // any of the volatile block patterns (it starts with "# claudeMd" not
    // "Available agent types" etc.)
    const input = `You are an assistant.
<system-reminder>
# claudeMd
Project: DeepClaude
Language: TypeScript
</system-reminder>
<system-reminder>
Available agent types for the Agent tool:
- claude: General agent
</system-reminder>
<system-reminder>
The task tools haven't been used recently.
</system-reminder>
End of prompt.`;
    const result = stripAnthropicSkills(input);
    // claudeMd preserved
    expect(result).toContain('Project: DeepClaude');
    expect(result).toContain('Language: TypeScript');
    // Volatile system-reminders stripped
    expect(result).not.toContain('Available agent types');
    expect(result).not.toContain('TaskCreate');
    // Structural: claudeMd system-reminder tags still present
    // (we strip volatile blocks but keep non-matching ones)
    expect(result).toContain('# claudeMd');
  });
});
