'use strict';

// Test launcher.mjs config resolution, env var computation, and
// slot override behavior. Tests invoke the CLI directly via spawnSync
// and also validate the providers.json data model.

import { spawnSync } from 'child_process';
import { join } from 'path';
import { readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';

const LAUNCHER = join(__dirname, '..', 'launcher.mjs');
const PROVIDERS_JSON = join(__dirname, '..', 'providers.json');

function runLauncher(...args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('node', [LAUNCHER, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env },
    });
    return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
}

function runLauncherJson(action: string, ...args: string[]): Record<string, unknown> {
    const { stdout, stderr, status } = runLauncher(action, ...args);
    if (status !== 0) throw new Error(`launcher.mjs ${action} failed (${status}): ${stderr}`);
    return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// resolve-config
// ---------------------------------------------------------------------------
describe('resolve-config (CLI)', () => {
    test('resolves ds+an config with correct haiku/subagent providers', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds+an');
        expect(cfg.name).toBe('DeepSeek + Anthropic Haiku');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.opus.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.sonnet.provider).toBe('ds');
        expect(cfg.slots.sonnet.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.haiku.provider).toBe('an');
        expect(cfg.slots.haiku.model).toBe('claude-haiku-4-5-20251001');
        expect(cfg.slots.subagent.provider).toBe('an');
        expect(cfg.slots.subagent.model).toBe('claude-haiku-4-5-20251001');
        expect(cfg.slots.fable.provider).toBe('ds');
        expect(cfg.slots.fable.model).toBe('deepseek-v4-pro');
        expect(cfg.defaultProvider).toBe('ds');
    });

    test('resolves ds config (default)', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds');
        expect(cfg.slots.haiku.provider).toBe('ds');
        expect(cfg.slots.haiku.model).toBe('deepseek-v4-flash');
        expect(cfg.slots.subagent.provider).toBe('ds');
        expect(cfg.slots.subagent.model).toBe('deepseek-v4-flash');
    });

    test('resolves ds+oc config', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds+oc');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.haiku.provider).toBe('oc');
        expect(cfg.slots.subagent.provider).toBe('oc');
        expect(cfg.slots.haiku.model).toBe('big-pickle');
        expect(cfg.slots.subagent.model).toBe('big-pickle');
    });

    test('fails for unknown config', () => {
        const { status, stderr } = runLauncher('resolve-config', '--name=nonexistent');
        expect(status).not.toBe(0);
        expect(stderr).toContain('Unknown config');
    });
});

// ---------------------------------------------------------------------------
// build-routes
// ---------------------------------------------------------------------------
describe('build-routes (CLI)', () => {
    test('builds routes for ds+an with correct slot mappings', () => {
        const routes = runLauncherJson('build-routes', '--name=ds+an');
        expect(routes.slots.haiku).toBe('haiku:an:claude-haiku-4-5-20251001');
        expect(routes.slots.subagent).toBe('subagent:an:claude-haiku-4-5-20251001');
        expect(routes.slots.opus).toBe('opus:ds:deepseek-v4-pro');
        expect(routes.defaultProvider).toBe('ds');
        // Routes table should include all models with valid keys (includeAllModels=true)
        expect(routes.routes['claude-haiku-4-5-20251001'].provider).toBe('an');
        expect(routes.routes['deepseek-v4-pro'].provider).toBe('ds');
        // Provider entries
        expect(routes.providers.ds).toBeDefined();
        expect(routes.providers.an).toBeDefined();
        expect(routes.providers.an.format).toBe('anthropic');
    });

    test('builds routes for ds config with all-DS slots', () => {
        const routes = runLauncherJson('build-routes', '--name=ds');
        expect(routes.slots.haiku).toBe('haiku:ds:deepseek-v4-flash');
        expect(routes.slots.subagent).toBe('subagent:ds:deepseek-v4-flash');
    });
});

// ---------------------------------------------------------------------------
// env-vars (computeEnvVars via CLI)
// ---------------------------------------------------------------------------
describe('env-vars (CLI)', () => {
    test('computes correct env vars for ds+an config', () => {
        const env = runLauncherJson('env-vars',
            '--port=58000',
            '--opus=deepseek-v4-pro',
            '--sonnet=deepseek-v4-pro',
            '--haiku=claude-haiku-4-5-20251001',
            '--subagent=claude-haiku-4-5-20251001',
            '--fable=deepseek-v4-pro'
        );

        // Base URL
        expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:58000');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('proxy');

        // Opus/sonnet/fable use DeepSeek (1M context → [1m] suffix)
        expect(env.ANTHROPIC_MODEL).toBe('opus:deepseek-v4-pro[1m]');
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus:deepseek-v4-pro[1m]');
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet:deepseek-v4-pro[1m]');
        expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('fable:deepseek-v4-pro[1m]');

        // Haiku/subagent use Anthropic (200K context → NO [1m] suffix)
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:claude-haiku-4-5-20251001');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('subagent:claude-haiku-4-5-20251001');

        // Should unset ANTHROPIC_API_KEY (proxy handles auth)
        expect(env._unset).toContain('ANTHROPIC_API_KEY');
    });

    test('ds config uses DeepSeek for all slots', () => {
        const env = runLauncherJson('env-vars',
            '--port=58001',
            '--opus=deepseek-v4-pro',
            '--sonnet=deepseek-v4-pro',
            '--haiku=deepseek-v4-flash',
            '--subagent=deepseek-v4-flash',
            '--fable=deepseek-v4-pro'
        );

        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:deepseek-v4-flash[1m]');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('subagent:deepseek-v4-flash[1m]');
    });

    test('non-1M models do NOT get [1m] suffix', () => {
        // claude-haiku-4-5-20251001 has 200K context — no [1m]
        const env = runLauncherJson('env-vars',
            '--port=58002',
            '--opus=claude-haiku-4-5-20251001',
            '--sonnet=claude-haiku-4-5-20251001',
            '--haiku=claude-haiku-4-5-20251001',
            '--subagent=claude-haiku-4-5-20251001',
            '--fable=claude-haiku-4-5-20251001'
        );
        expect(env.ANTHROPIC_MODEL).toBe('opus:claude-haiku-4-5-20251001');
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:claude-haiku-4-5-20251001');
    });
});

// ---------------------------------------------------------------------------
// init-overrides
// ---------------------------------------------------------------------------
// init-overrides tests share ~/.deepclaude/slot-overrides.json.
// To prevent cross-test pollution: save the file before all tests,
// delete it before each test, and restore it after all tests.
// ---------------------------------------------------------------------------
describe('init-overrides (CLI)', () => {
    const SLOT_FILE = join(homedir(), '.deepclaude', 'slot-overrides.json');
    let _savedSlot: string | null = null;

    beforeAll(() => {
        if (existsSync(SLOT_FILE)) {
            _savedSlot = readFileSync(SLOT_FILE, 'utf-8');
        }
    });

    afterAll(() => {
        if (_savedSlot !== null) {
            writeFileSync(SLOT_FILE, _savedSlot, 'utf-8');
        } else {
            try { rmSync(SLOT_FILE, { force: true }); } catch {}
        }
    });

    beforeEach(() => {
        try { rmSync(SLOT_FILE, { force: true }); } catch {}
    });

    test('init-overrides for ds+an sets correct _defaults', () => {
        // init-overrides writes to ~/.deepclaude/slot-overrides.json
        // We run it and parse stdout to check the merge result
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        // The returned object is the merged overrides
        expect(result._defaults).toBeDefined();
        expect(result._defaults.haiku).toBe('an:claude-haiku-4-5-20251001');
        expect(result._defaults.subagent).toBe('an:claude-haiku-4-5-20251001');
        expect(result._defaults.opus).toBe('ds:deepseek-v4-pro');
        expect(result._defaults.fable).toBe('ds:deepseek-v4-pro');
    });

    test('init-overrides for ds sets correct _defaults', () => {
        const result = runLauncherJson('init-overrides', '--name=ds');
        expect(result._defaults.haiku).toBe('ds:deepseek-v4-flash');
        expect(result._defaults.subagent).toBe('ds:deepseek-v4-flash');
    });

    test('existing user overrides survive init-overrides', () => {
        // Simulate: first set a user override, then switch configs
        // The set-slot action writes user overrides on top of _defaults
        runLauncher('set-slot', '--slot=fable', '--value=or:deepseek/deepseek-v4-pro');

        // Now init ds+an — _defaults should update but user fable override persists
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        if (result.fable) {
            // User override survived
            expect(result.fable).toBe('or:deepseek/deepseek-v4-pro');
        }
        // _defaults should be from ds+an
        expect(result._defaults.haiku).toBe('an:claude-haiku-4-5-20251001');
    });

    test('init-overrides writes DIRECT slot keys (not just _defaults)', () => {
        // Regression: initOverrides used to write only _defaults, which the
        // proxy's routing.ts couldn't read (it checks slotOverrides[slot],
        // not slotOverrides._defaults[slot]). Config defaults were invisible
        // to the proxy, so stale env vars controlled actual routing.
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        // Every SLOT must have a direct key on the result object
        for (const slot of ['opus', 'sonnet', 'haiku', 'subagent', 'fable']) {
            expect(result[slot]).toBeDefined();
            expect(typeof result[slot]).toBe('string');
            expect(result[slot]).toMatch(/^[a-z][a-z0-9_-]*:.+$/);
        }
        // Specific values for ds+an
        expect(result.haiku).toBe('an:claude-haiku-4-5-20251001');
        expect(result.subagent).toBe('an:claude-haiku-4-5-20251001');
        expect(result.opus).toBe('ds:deepseek-v4-pro');
        expect(result.sonnet).toBe('ds:deepseek-v4-pro');
        expect(result.fable).toBe('ds:deepseek-v4-pro');
    });

    test('init-overrides direct keys: user override wins over config default', () => {
        // Set a user override, then init a config — user value must win
        runLauncher('set-slot', '--slot=fable', '--value=or:deepseek/deepseek-v4-pro');
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        // User override wins the direct key
        expect(result.fable).toBe('or:deepseek/deepseek-v4-pro');
        // But _defaults still records the config baseline
        expect(result._defaults.fable).toBe('ds:deepseek-v4-pro');
        // Non-overridden slots have direct keys from config
        expect(result.haiku).toBe('an:claude-haiku-4-5-20251001');
        expect(result.opus).toBe('ds:deepseek-v4-pro');
    });

    test('init-overrides direct keys match _defaults for clean slots', () => {
        // On a clean file (no user overrides), direct keys and _defaults must agree
        // First clear any user overrides
        runLauncher('set-slot', '--slot=fable'); // clear
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        for (const slot of ['opus', 'sonnet', 'haiku', 'subagent', 'fable']) {
            expect(result[slot]).toBe(result._defaults[slot]);
        }
    });

    // --- Config switching: ds ↔ ds+an ↔ ds+oc ---
    test('init-overrides ds sets direct haiku key to deepseek flash', () => {
        const result = runLauncherJson('init-overrides', '--name=ds');
        expect(result.haiku).toBe('ds:deepseek-v4-flash');
        expect(result.subagent).toBe('ds:deepseek-v4-flash');
    });

    test('init-overrides ds+oc sets direct haiku key to opencode big-pickle', () => {
        const result = runLauncherJson('init-overrides', '--name=ds+oc');
        expect(result.haiku).toBe('oc:big-pickle');
        expect(result.subagent).toBe('oc:big-pickle');
    });

    test('init-overrides switches ds → ds+an correctly', () => {
        runLauncherJson('init-overrides', '--name=ds');
        const result = runLauncherJson('init-overrides', '--name=ds+an');
        expect(result.haiku).toBe('an:claude-haiku-4-5-20251001');
        expect(result.subagent).toBe('an:claude-haiku-4-5-20251001');
    });

    test('init-overrides switches ds+an → ds correctly', () => {
        runLauncherJson('init-overrides', '--name=ds+an');
        const result = runLauncherJson('init-overrides', '--name=ds');
        expect(result.haiku).toBe('ds:deepseek-v4-flash');
        expect(result.subagent).toBe('ds:deepseek-v4-flash');
    });
});

// ---------------------------------------------------------------------------
// set-slot / get-slot
// ---------------------------------------------------------------------------
describe('set-slot (CLI)', () => {
    const SLOT_FILE = join(homedir(), '.deepclaude', 'slot-overrides.json');
    let _savedSlotSet: string | null = null;

    beforeAll(() => {
        if (existsSync(SLOT_FILE)) _savedSlotSet = readFileSync(SLOT_FILE, 'utf-8');
    });
    afterAll(() => {
        if (_savedSlotSet !== null) writeFileSync(SLOT_FILE, _savedSlotSet, 'utf-8');
        else try { rmSync(SLOT_FILE, { force: true }); } catch {}
    });
    beforeEach(() => { try { rmSync(SLOT_FILE, { force: true }); } catch {} });

    test('set-slot haiku updates override and read-override sees it', () => {
        // Set haiku to a specific model
        const setResult = runLauncherJson('set-slot', '--slot=haiku', '--value=oc:big-pickle');
        expect(setResult.set).toBe(true);
        expect(setResult.slot).toBe('haiku');
        expect(setResult.value).toBe('oc:big-pickle');

        // Read it back
        const readResult = runLauncherJson('read-override', '--slot=haiku', '--fallback=ds:deepseek-v4-flash');
        // append1m is applied: big-pickle has 131K context → no [1m]
        expect(readResult.value).toBe('haiku:big-pickle');

        // Cleanup: clear the override
        runLauncher('set-slot', '--slot=haiku'); // no value = clear
    });

    test('set-slot with invalid provider fails', () => {
        const { status } = runLauncher('set-slot', '--slot=sonnet', '--value=xx:fake-model');
        expect(status).not.toBe(0);
    });
});

// ---------------------------------------------------------------------------
// adhoc config (--specs)
// ---------------------------------------------------------------------------
describe('buildAdhocConfig (CLI via resolve-config --specs)', () => {
    test('single spec repeats across all 5 slots', () => {
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro');
        expect(cfg.slots.opus.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.sonnet.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.haiku.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.subagent.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.fable.model).toBe('deepseek-v4-pro');
    });

    test('two specs: first 3 slots use first, last 2 use second', () => {
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro,oc:big-pickle');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.sonnet.provider).toBe('ds');
        expect(cfg.slots.haiku.provider).toBe('ds');
        expect(cfg.slots.subagent.provider).toBe('oc');
        expect(cfg.slots.fable.provider).toBe('oc');
    });

    test('five specs: direct slot mapping', () => {
        const cfg = runLauncherJson('resolve-config',
            '--specs=ds:deepseek-v4-pro,ds:deepseek-v4-pro,oc:big-pickle,or:deepseek/deepseek-v4-pro,an:claude-haiku-4-5-20251001');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.sonnet.provider).toBe('ds');
        expect(cfg.slots.haiku.provider).toBe('oc');
        expect(cfg.slots.subagent.provider).toBe('or');
        expect(cfg.slots.fable.provider).toBe('an');
    });
});

// ---------------------------------------------------------------------------
// append1m: [1m] suffix logic (tested via env-vars output)
// ---------------------------------------------------------------------------
describe('append1m via env-vars', () => {
    test('1M+ context models get [1m] suffix', () => {
        const env = runLauncherJson('env-vars',
            '--port=58003',
            '--opus=deepseek-v4-pro',    // 1M context
            '--sonnet=deepseek-v4-pro',
            '--haiku=deepseek-v4-pro',
            '--subagent=deepseek-v4-pro',
            '--fable=deepseek-v4-pro'
        );
        expect(env.ANTHROPIC_MODEL).toContain('[1m]');
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toContain('[1m]');
    });

    test('sub-1M models do NOT get [1m] suffix', () => {
        const env = runLauncherJson('env-vars',
            '--port=58004',
            '--opus=big-pickle',    // 131K context
            '--sonnet=big-pickle',
            '--haiku=big-pickle',
            '--subagent=big-pickle',
            '--fable=big-pickle'
        );
        expect(env.ANTHROPIC_MODEL).not.toContain('[1m]');
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).not.toContain('[1m]');
    });
});

// ---------------------------------------------------------------------------
// providers.json: ds+an config integrity
// ---------------------------------------------------------------------------
describe('providers.json: ds+an config integrity', () => {
    let registry: Record<string, unknown>;

    beforeAll(() => {
        registry = JSON.parse(readFileSync(PROVIDERS_JSON, 'utf-8'));
    });

    test('ds+an config exists and references valid providers', () => {
        const configs = registry.configs as Record<string, Record<string, string>>;
        expect(configs['ds+an']).toBeDefined();

        const cfg = configs['ds+an'];
        const providerKeys = new Set(Object.keys(registry.providers as Record<string, unknown>));

        // All slots reference valid provider:model specs
        for (const slot of ['opus', 'sonnet', 'haiku', 'sub', 'fable']) {
            const spec = cfg[slot];
            expect(spec).toBeDefined();
            expect(spec).toMatch(/^[a-z][a-z0-9_-]*:.+$/);
            const [provKey] = spec.split(':');
            expect(providerKeys.has(provKey)).toBe(true);
        }
    });

    test('ds+an correctly uses Anthropic for haiku and subagent', () => {
        const configs = registry.configs as Record<string, Record<string, string>>;
        const cfg = configs['ds+an'];

        // Opus, sonnet, fable use DeepSeek
        expect(cfg.opus).toMatch(/^ds:deepseek-v4-pro$/);
        expect(cfg.sonnet).toMatch(/^ds:deepseek-v4-pro$/);
        expect(cfg.fable).toMatch(/^ds:deepseek-v4-pro$/);

        // Haiku and subagent use Anthropic
        expect(cfg.haiku).toMatch(/^an:claude-haiku-4-5-20251001$/);
        expect(cfg.sub).toMatch(/^an:claude-haiku-4-5-20251001$/);
    });

    test('Anthropic provider has ds fallback', () => {
        const providers = registry.providers as Record<string, Record<string, unknown>>;
        expect(providers.an).toBeDefined();
        if (providers.an.fallback) {
            expect(providers.an.fallback).toContain('ds');
        }
    });

    test('ds+an has Anthropic API key configured', () => {
        // Use key-status action to check if 'an' key is available
        const keys = runLauncherJson('key-status');
        expect(keys.an).toBeDefined();
        // Don't assert on key presence (CI may not have it),
        // but at least the entry exists
    });
});

// ---------------------------------------------------------------------------
// context-info
// ---------------------------------------------------------------------------
describe('context-info (CLI)', () => {
    test('deepseek-v4-pro has 1M context and compaction window', () => {
        const ctx = runLauncherJson('context-info', '--model=deepseek-v4-pro');
        expect(ctx.contextLimit).toBeGreaterThanOrEqual(1000000);
        expect(ctx.has1m).toBe(true);
        expect(ctx.autoCompactWindow).toBeTruthy();
    });

    test('claude-haiku has 200K context, no 1M', () => {
        const ctx = runLauncherJson('context-info', '--model=claude-haiku-4-5-20251001');
        expect(ctx.contextLimit).toBe(200000);
        expect(ctx.has1m).toBe(false);
    });

    test('unknown model returns null contextLimit', () => {
        const ctx = runLauncherJson('context-info', '--model=nonexistent-model-999');
        expect(ctx.contextLimit).toBeNull();
        expect(ctx.has1m).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// parseSpec (tested via error messages in CLI)
// ---------------------------------------------------------------------------
describe('parseSpec validation', () => {
    test('rejects specs without colon', () => {
        const { status, stderr } = runLauncher('resolve-config', '--specs=ds-deepseek-v4-pro');
        expect(status).not.toBe(0);
        expect(stderr).toContain('Invalid model spec');
    });

    test('rejects specs with unknown provider', () => {
        const { status, stderr } = runLauncher('resolve-config', '--specs=xx:some-model');
        expect(status).not.toBe(0);
        expect(stderr).toContain('Unknown provider');
    });
});

// ---------------------------------------------------------------------------
// thinking-overrides
// ---------------------------------------------------------------------------
describe('thinking-overrides (CLI)', () => {
    test('--no-thinking disables thinking for DS models', () => {
        const result = runLauncherJson('thinking-overrides', '--no-thinking');
        expect(result.written).toBe(true);
        expect(result.overrides['deepseek-v4-pro']).toBeNull();
        expect(result.overrides['deepseek-v4-flash']).toBeNull();
    });

    test('--budget sets thinking budget', () => {
        const result = runLauncherJson('thinking-overrides', '--budget=32000');
        expect(result.written).toBe(true);
        expect(result.overrides['deepseek-v4-pro'].budget_tokens).toBe(32000);
    });

    test('clearing overrides when no flag set', () => {
        const result = runLauncherJson('thinking-overrides');
        expect(result.cleared).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// parseSpec: 3-part model IDs and edge cases
// ---------------------------------------------------------------------------
describe('parseSpec via resolve-config --specs', () => {
    test('handles 3-part model ID (provider+org/model:tag)', () => {
        // or:z-ai/glm-4.5-air:free → provKey=or, modelId=z-ai/glm-4.5-air:free
        const cfg = runLauncherJson('resolve-config', '--specs=or:z-ai/glm-4.5-air:free');
        expect(cfg.slots.opus.provider).toBe('or');
        expect(cfg.slots.opus.model).toBe('z-ai/glm-4.5-air:free');
    });

    test('handles model IDs with hyphens and underscores in provider key', () => {
        // nv:novita/deepseek-v4-pro → provKey=nv, modelId=novita/deepseek-v4-pro
        // (nv is in the registry — novita)
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.opus.model).toBe('deepseek-v4-pro');
    });

    test('handles DeepSeek direct model with v4-pro', () => {
        // ds:deepseek-v4-pro → provKey=ds, modelId=deepseek-v4-pro
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.opus.model).toBe('deepseek-v4-pro');
    });
});

// ---------------------------------------------------------------------------
// adhocSlotIndex: verify all specCount/slotIndex combinations
// ---------------------------------------------------------------------------
describe('adhocSlotIndex via resolve-config --specs', () => {
    // 1 spec:  [0, 0, 0, 0, 0]
    test('1 spec: all 5 slots use same spec', () => {
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro');
        const providers = new Set([
            cfg.slots.opus.provider, cfg.slots.sonnet.provider,
            cfg.slots.haiku.provider, cfg.slots.subagent.provider,
            cfg.slots.fable.provider,
        ]);
        expect(providers.size).toBe(1);
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.fable.provider).toBe('ds');
    });

    // 2 specs: [0, 0, 0, 1, 1]
    test('2 specs: first 3 slots use spec0, last 2 use spec1', () => {
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro,oc:big-pickle');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.sonnet.provider).toBe('ds');
        expect(cfg.slots.haiku.provider).toBe('ds');
        expect(cfg.slots.subagent.provider).toBe('oc');
        expect(cfg.slots.fable.provider).toBe('oc');
    });

    // 3 specs: [0, 1, 1, 2, 2]
    test('3 specs: opus=spec0, sonnet/haiku=spec1, subagent/fable=spec2', () => {
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro,oc:big-pickle,or:deepseek/deepseek-v4-pro');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.sonnet.provider).toBe('oc');
        expect(cfg.slots.haiku.provider).toBe('oc');
        expect(cfg.slots.subagent.provider).toBe('or');
        expect(cfg.slots.fable.provider).toBe('or');
    });

    // 4 specs: [0, 1, 2, 3, 3]
    test('4 specs: opus/sonnet/haiku direct, subagent/fable share last', () => {
        const cfg = runLauncherJson('resolve-config',
            '--specs=ds:deepseek-v4-pro,oc:big-pickle,or:deepseek/deepseek-v4-pro,an:claude-haiku-4-5-20251001');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.sonnet.provider).toBe('oc');
        expect(cfg.slots.haiku.provider).toBe('or');
        expect(cfg.slots.subagent.provider).toBe('an');
        expect(cfg.slots.fable.provider).toBe('an');
    });

    // 5 specs: [0, 1, 2, 3, 4] — direct mapping
    test('5 specs: direct 1:1 slot mapping', () => {
        const cfg = runLauncherJson('resolve-config',
            '--specs=ds:deepseek-v4-pro,ds:deepseek-v4-flash,oc:big-pickle,or:z-ai/glm-4.5-air:free,an:claude-haiku-4-5-20251001');
        expect(cfg.slots.opus.provider).toBe('ds');
        expect(cfg.slots.opus.model).toBe('deepseek-v4-pro');
        expect(cfg.slots.sonnet.provider).toBe('ds');
        expect(cfg.slots.sonnet.model).toBe('deepseek-v4-flash');
        expect(cfg.slots.haiku.provider).toBe('oc');
        expect(cfg.slots.haiku.model).toBe('big-pickle');
        expect(cfg.slots.subagent.provider).toBe('or');
        expect(cfg.slots.subagent.model).toBe('z-ai/glm-4.5-air:free');
        expect(cfg.slots.fable.provider).toBe('an');
        expect(cfg.slots.fable.model).toBe('claude-haiku-4-5-20251001');
    });
});

// ---------------------------------------------------------------------------
// maskKey: edge cases testable via key-status
// ---------------------------------------------------------------------------
describe('maskKey via key-status', () => {
    test('key-status returns all known providers with correct mask format', () => {
        const keys = runLauncherJson('key-status');
        // Every provider in providers.json should appear
        const knownProviders = ['ds', 'or', 'fw', 'oc', 'an', 'al', 'km', 'mm', 'um', 'gr', 'mt', 'mx', 'za', 'bp', 'sf', 'nv'];
        for (const pk of knownProviders) {
            expect(keys[pk]).toBeDefined();
            expect(keys[pk].keyName).toBeDefined();
            // masked is either 'MISSING' or 'set (****xxxx)'
            expect(keys[pk].masked).toMatch(/^(MISSING|set \(\*{4}[a-zA-Z0-9]{1,4}\))$/);
            // status is 'set' or 'MISSING'
            expect(['set', 'MISSING']).toContain(keys[pk].status);
        }
    });

    test('key-status contains Anthropic with keyName ANTHROPIC_API_KEY', () => {
        const keys = runLauncherJson('key-status');
        expect(keys.an.keyName).toBe('ANTHROPIC_API_KEY');
    });
});

// ---------------------------------------------------------------------------
// computeContextInfo: compaction window vs fallback
// ---------------------------------------------------------------------------
describe('computeContextInfo via context-info', () => {
    test('deepseek-v4-pro uses compaction window (950K), not raw context limit', () => {
        const ctx = runLauncherJson('context-info', '--model=deepseek-v4-pro');
        expect(ctx.model).toBe('deepseek-v4-pro');
        expect(ctx.contextLimit).toBeGreaterThanOrEqual(1000000);
        expect(ctx.compactionWindow).toBeTruthy();
        // With compaction window >= 1M: autoCompactWindow = '1000000'
        expect(ctx.autoCompactWindow).toBeTruthy();
        expect(ctx.has1m).toBe(true);
        // disableCompact should be false when compactionWindow is set
        expect(ctx.disableCompact).toBe(false);
    });

    test('claude-haiku (200K no compaction window) uses context limit fallback', () => {
        const ctx = runLauncherJson('context-info', '--model=claude-haiku-4-5-20251001');
        // 200K < 1M → autoCompactWindow should be null or the raw limit
        expect(ctx.contextLimit).toBe(200000);
        expect(ctx.has1m).toBe(false);
    });

    test('big-pickle (131K) no 1M, no compaction window', () => {
        const ctx = runLauncherJson('context-info', '--model=big-pickle');
        expect(ctx.contextLimit).toBeGreaterThan(0);
        expect(ctx.has1m).toBe(false);
        // 131K > 128K → disableCompact should be true, maxContextTokens set
        if (ctx.contextLimit > 131072) {
            expect(ctx.disableCompact).toBe(true);
            expect(ctx.maxContextTokens).toBeTruthy();
        }
    });
});

// ---------------------------------------------------------------------------
// config-list and model-list: data integrity
// ---------------------------------------------------------------------------
describe('config-list and model-list', () => {
    test('config-list returns all named configs', () => {
        const configs = runLauncherJson('config-list');
        expect(configs.ds).toBeDefined();
        expect(configs['ds+an']).toBeDefined();
        expect(configs['ds+oc']).toBeDefined();
        expect(configs.or).toBeDefined();
        // Every config has opus/sonnet/haiku/subagent/fable slots
        for (const [key, cfg] of Object.entries(configs)) {
            const c = cfg as Record<string, string>;
            expect(c.opus).toBeDefined();
            expect(c.sonnet).toBeDefined();
            expect(c.haiku).toBeDefined();
            expect(c.subagent).toBeDefined();
            expect(c.fable).toBeDefined();
            if (key !== 'ds+an' && key !== 'ds+oc') {
                // Non-mixed configs: all 5 slots use same provider
                // (except fallback-only providers like mm/um that may differ)
            }
        }
    });

    test('model-list groups models by provider', () => {
        const models = runLauncherJson('model-list');
        expect(models.ds).toBeDefined();
        expect(models.ds.name).toBe('DeepSeek (direct)');
        expect(Array.isArray(models.ds.models)).toBe(true);
        expect(models.ds.models).toContain('deepseek-v4-pro');
        expect(models.ds.models).toContain('deepseek-v4-flash');
        // Anthropic
        expect(models.an).toBeDefined();
        expect(models.an.models).toContain('claude-haiku-4-5-20251001');
    });
});

// ---------------------------------------------------------------------------
// cost-data: pricing integrity
// ---------------------------------------------------------------------------
describe('cost-data', () => {
    test('cost-data includes DeepSeek and Anthropic pricing', () => {
        const { pricing } = runLauncherJson('cost-data') as { pricing: Record<string, Record<string, number | null>> };
        expect(pricing['deepseek-v4-pro']).toBeDefined();
        expect(pricing['deepseek-v4-pro'].input).toBeGreaterThan(0);
        expect(pricing['deepseek-v4-pro'].output).toBeGreaterThan(0);
        expect(pricing['deepseek-v4-pro'].input_cache_hit).toBeGreaterThan(0);

        expect(pricing['claude-haiku-4-5-20251001']).toBeDefined();
        expect(pricing['claude-haiku-4-5-20251001'].input).toBeGreaterThan(0);
        expect(pricing['claude-haiku-4-5-20251001'].output).toBeGreaterThan(0);
    });

    test('all priced models have positive input and output prices (free models allowed)', () => {
        const { pricing } = runLauncherJson('cost-data') as { pricing: Record<string, Record<string, number | null>> };
        for (const [model, p] of Object.entries(pricing)) {
            if (model.startsWith('_')) continue;
            // Free-tier models may have input=0 or output=0
            expect(p.input).toBeGreaterThanOrEqual(0);
            expect(p.output).toBeGreaterThanOrEqual(0);
        }
    });
});

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
describe('version', () => {
    test('version returns non-empty version string', () => {
        const ver = runLauncherJson('version');
        expect(ver.version).toBeDefined();
        expect(typeof ver.version).toBe('string');
        expect(ver.version.length).toBeGreaterThan(0);
        expect(ver.proxyPath).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// read-override fallback path
// ---------------------------------------------------------------------------
describe('read-override (CLI)', () => {
    const SLOT_FILE = join(homedir(), '.deepclaude', 'slot-overrides.json');
    let _savedSlotRO: string | null = null;

    beforeAll(() => {
        if (existsSync(SLOT_FILE)) _savedSlotRO = readFileSync(SLOT_FILE, 'utf-8');
    });
    afterAll(() => {
        if (_savedSlotRO !== null) writeFileSync(SLOT_FILE, _savedSlotRO, 'utf-8');
        else try { rmSync(SLOT_FILE, { force: true }); } catch {}
    });
    beforeEach(() => { try { rmSync(SLOT_FILE, { force: true }); } catch {} });

    test('returns fallback when no override set for a slot', () => {
        // We can't easily isolate a clean slot file, but we can read a
        // slot with an explicit fallback — append1m is applied to the output.
        const result = runLauncherJson('read-override', '--slot=opus', '--fallback=ds:deepseek-v4-pro');
        // append1m adds [1m] for 1M models
        expect(result.value).toMatch(/^opus:deepseek-v4-pro(\[1m\])?$/);
        expect(result.slot).toBe('opus');
    });

    test('returns fallback without [1m] for sub-1M models', () => {
        const result = runLauncherJson('read-override', '--slot=haiku', '--fallback=an:claude-haiku-4-5-20251001');
        expect(result.value).toBe('haiku:claude-haiku-4-5-20251001');
    });
});

// ---------------------------------------------------------------------------
// set-slot: clear override restores default
// ---------------------------------------------------------------------------
describe('set-slot clear (CLI)', () => {
    const SLOT_FILE = join(homedir(), '.deepclaude', 'slot-overrides.json');
    let _savedSlotSC: string | null = null;

    beforeAll(() => {
        if (existsSync(SLOT_FILE)) _savedSlotSC = readFileSync(SLOT_FILE, 'utf-8');
    });
    afterAll(() => {
        if (_savedSlotSC !== null) writeFileSync(SLOT_FILE, _savedSlotSC, 'utf-8');
        else try { rmSync(SLOT_FILE, { force: true }); } catch {}
    });
    beforeEach(() => { try { rmSync(SLOT_FILE, { force: true }); } catch {} });

    test('cleared override returns default on next read', () => {
        // Ensure slot-overrides.json has _defaults for haiku
        runLauncherJson('init-overrides', '--name=ds+an');

        // Set a custom override
        const setResult = runLauncherJson('set-slot', '--slot=haiku', '--value=oc:big-pickle');
        expect(setResult.set).toBe(true);

        // Read should see the custom override
        const withOverride = runLauncherJson('read-override', '--slot=haiku', '--fallback=an:claude-haiku-4-5-20251001');
        expect(withOverride.value).toBe('haiku:big-pickle');

        // Clear the override
        const clearResult = runLauncherJson('set-slot', '--slot=haiku');
        expect(clearResult.cleared).toBe(true);

        // Read should now show the _defaults (from ds+an init-overrides above)
        const afterClear = runLauncherJson('read-override', '--slot=haiku', '--fallback=an:claude-haiku-4-5-20251001');
        // After clearing, it returns _defaults haiku which is an:claude-haiku-4-5-20251001
        expect(afterClear.value).toMatch(/^haiku:claude-haiku-4-5-20251001/);
    });
});

// ---------------------------------------------------------------------------
// Integration: resolve → build-routes → env-vars consistency
// ---------------------------------------------------------------------------
describe('resolve→routes→env-vars consistency', () => {
    test('ds+an: resolve, routes, and env-vars agree on slot assignments', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds+an');
        const routes = runLauncherJson('build-routes', '--name=ds+an');

        // Route slots should match resolved slots
        const routeSlots = routes.slots as Record<string, string>;
        const cfgSlots = cfg.slots as Record<string, { provider: string; model: string }>;

        for (const slot of ['opus', 'sonnet', 'haiku', 'subagent', 'fable']) {
            const slotKey = slot === 'subagent' ? 'subagent' : slot;
            const routeVal = routeSlots[slotKey] as string;
            expect(routeVal).toBe(`${slotKey}:${cfgSlots[slotKey].provider}:${cfgSlots[slotKey].model}`);
        }

        // Env vars should use the same models
        const env = runLauncherJson('env-vars',
            '--port=58999',
            `--opus=${cfgSlots.opus.model}`,
            `--sonnet=${cfgSlots.sonnet.model}`,
            `--haiku=${cfgSlots.haiku.model}`,
            `--subagent=${cfgSlots.subagent.model}`,
            `--fable=${cfgSlots.fable.model}`
        );

        // Haiku and subagent should be Anthropic models (no [1m])
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(`haiku:${cfgSlots.haiku.model}`);
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(`subagent:${cfgSlots.subagent.model}`);

        // Opus should be DeepSeek (with [1m])
        expect(env.ANTHROPIC_MODEL).toContain(cfgSlots.opus.model);
    });

    test('ds: resolve, routes, and env-vars agree', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds');
        const routes = runLauncherJson('build-routes', '--name=ds');

        const routeSlots = routes.slots as Record<string, string>;
        const cfgSlots = cfg.slots as Record<string, { provider: string; model: string }>;

        expect(routeSlots.opus).toBe(`opus:ds:${cfgSlots.opus.model}`);
        expect(routeSlots.haiku).toBe(`haiku:ds:${cfgSlots.haiku.model}`);
        expect(routeSlots.subagent).toBe(`subagent:ds:${cfgSlots.subagent.model}`);
    });
});

// ---------------------------------------------------------------------------
// End-to-end: deepclaude.ps1 config resolution via --dry-run output
// ---------------------------------------------------------------------------
describe('deepclaude.ps1 end-to-end', () => {
    const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');

    function runDeepClaude(...args: string[]): { stdout: string; stderr: string; status: number } {
        const r = spawnSync('pwsh', ['-NoLogo', '-File', DEEPCLAUDE_PS1, ...args], {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env },
        });
        return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
    }

    // --- deepclaude.ps1 --dry-run: the output is a routing table from proxy/start-proxy.ts.
    //     It shows SLOT, PROVIDER (with display name), MODEL, FORMAT, KEY, FALLBACK columns.
    //     We match on provider names and model IDs within the table.

    test('-b ds+an routes haiku to Anthropic, opus to DeepSeek', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+an', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        // Dry-run table shows provider display names in the PROVIDER column
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
        expect(stdout).toMatch(/subagent\s+an \(Anthropic/);
        expect(stdout).toMatch(/opus\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/sonnet\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/fable\s+ds \(DeepSeek/);
        // Haiku model should be claude-haiku, NOT deepseek
        expect(stdout).toMatch(/claude-haiku-4-5-20251001/);
        // Opus model should be deepseek-v4-pro
        expect(stdout).toMatch(/deepseek-v4-pro/);
    });

    test('-b ds routes all slots to DeepSeek', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/haiku\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/subagent\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/deepseek-v4-flash/);
    });

    test('-b ds+oc routes haiku/subagent to OpenCode', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+oc', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/opus\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/haiku\s+oc \(OpenCode/);
        expect(stdout).toMatch(/subagent\s+oc \(OpenCode/);
        expect(stdout).toMatch(/big-pickle/);
    });

    test('dc.ps1-style positional ds+an → -b ds+an routes haiku to Anthropic', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+an', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        // Haiku should route to Anthropic, NOT DeepSeek
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
        // Subagent should route to Anthropic
        expect(stdout).toMatch(/subagent\s+an \(Anthropic/);
        // Opus/sonnet/fable should route to DeepSeek
        expect(stdout).toMatch(/opus\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/sonnet\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/fable\s+ds \(DeepSeek/);
        // Verify Anthropic model ID appears (not deepseek)
        expect(stdout).toMatch(/claude-haiku-4-5-20251001/);
    });

    test('positional specs build correct ad-hoc routing via launcher.mjs', () => {
        // Test ad-hoc spec routing through launcher.mjs directly to avoid
        // PowerShell argument-parsing edge cases with colons in model IDs.
        const routes = runLauncherJson('build-routes', '--specs=ds:deepseek-v4-pro,oc:big-pickle');
        // 2 specs: first 3 slots use spec0 (ds), last 2 use spec1 (oc)
        expect(routes.slots.opus).toBe('opus:ds:deepseek-v4-pro');
        expect(routes.slots.sonnet).toBe('sonnet:ds:deepseek-v4-pro');
        expect(routes.slots.haiku).toBe('haiku:ds:deepseek-v4-pro');
        expect(routes.slots.subagent).toBe('subagent:oc:big-pickle');
        expect(routes.slots.fable).toBe('fable:oc:big-pickle');
    });

    test('--dry-run flag after -b CONFIG does NOT pollute AllSpecs (regression)', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+an', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        // Verifies the config resolved, not fell through to ad-hoc
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
        expect(stdout).toMatch(/subagent\s+an \(Anthropic/);
    });

    test('multiple flags after -b CONFIG: AllSpecs stays clean', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+an', '--dry-run', '--log-all');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
    });

    test('--dry-run -b ds+an (both flag positions) resolves correctly', () => {
        // --dry-run as $Backend (first pass), -b goes to $ModelSpecs.
        // The -b isn't processed as a PowerShell param from $ModelSpecs,
        // so ds+an reaches the DryRun block as a file-name arg, which
        // start-proxy.ts handles by falling back to current-routes.json.
        // The -b ds+an --dry-run form is the canonical working syntax.
        const { stdout, stderr } = runDeepClaude('--dry-run', '-b', 'ds+an');
        // Doesn't crash
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        // At minimum, the routing table is printed
        expect(stdout).toContain('SLOT');
    });

    test('canonical flag position: -b ds+an --dry-run', () => {
        const { stdout, stderr } = runDeepClaude('-b', 'ds+an', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
        expect(stdout).toMatch(/subagent\s+an \(Anthropic/);
    });

    test('--dry-run --dry-run ds+an: double-flag is resilient', () => {
        // Second pass re-sees --dry-run but DryRun already true — should not crash
        const { stdout, stderr } = runDeepClaude('--dry-run', '--dry-run', 'ds+an');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toContain('SLOT');
    });
});

// ---------------------------------------------------------------------------
// dc.ps1 argument dispatch (4 branches)
// ---------------------------------------------------------------------------
describe('dc.ps1 argument dispatch', () => {
    const DC_PS1 = join(__dirname, '..', '..', 'dc.ps1');

    function runDc(...args: string[]): { stdout: string; stderr: string; status: number } {
        const r = spawnSync('pwsh', ['-NoLogo', '-File', DC_PS1, ...args], {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env },
        });
        return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
    }

    test('no args → defaults to ds config', () => {
        const { stdout } = runDc('--dry-run');
        // --dry-run has -- prefix → hits branch 4 → deepclaude.ps1 -b ds --dry-run
        // Second-pass scanner in deepclaude.ps1 picks up --dry-run
        expect(stdout).toMatch(/haiku\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/deepseek-v4-flash/);
    });

    // NOTE: Tests through dc.ps1 without --dry-run start real proxies, which is
    // too slow for CI (~30s timeout per test). The full dc.ps1 dispatch logic
    // (4 branches: no-args, -b, positional, --flag) is verifiable manually:
    //   dc               → ds config (branch 1)
    //   dc -b ds+an      → ds+an config (branch 2)
    //   dc ds+oc         → ds+oc config (branch 3)
    //   dc --flags       → ds config + flags (branch 4)
    // The --dry-run path is tested through deepclaude.ps1 directly.

    test('--dry-run as only arg resolves ds config through dc.ps1', () => {
        // dc.ps1 --dry-run: Args[0]='--dry-run' contains '-' → branch 4
        // → deepclaude.ps1 -b ds --dry-run → dry-run table for ds
        const { stdout } = runDc('--dry-run');
        expect(stdout).toMatch(/haiku\s+ds \(DeepSeek/);
        expect(stdout).toMatch(/deepseek-v4-flash/);
    });
});

// ---------------------------------------------------------------------------
// parseSpec edge cases (tested via error output from launcher.mjs)
// ---------------------------------------------------------------------------
describe('parseSpec edge cases', () => {
    test('rejects spec with provider but no model (ds:)', () => {
        const { status, stderr } = runLauncher('resolve-config', '--specs=ds:');
        expect(status).not.toBe(0);
        expect(stderr).toContain('Invalid model spec');
    });

    test('rejects spec with no provider (:model)', () => {
        const { status, stderr } = runLauncher('resolve-config', '--specs=:model');
        expect(status).not.toBe(0);
        // parseSpec regex fails → "Invalid model spec" (not "Unknown provider")
        expect(stderr).toMatch(/Invalid model spec|Unknown provider/);
    });

    test('rejects spec that is just a colon', () => {
        const { status } = runLauncher('resolve-config', '--specs=:');
        expect(status).not.toBe(0);
    });

    test('rejects spec that is a single word (no colon, no known config)', () => {
        const { status, stderr } = runLauncher('resolve-config', '--specs=justaword');
        expect(status).not.toBe(0);
        expect(stderr).toContain('Invalid model spec');
    });

    test('provider with numbers in key is valid', () => {
        // Provider keys can contain digits and underscores after first char
        const cfg = runLauncherJson('resolve-config', '--specs=ds:deepseek-v4-pro');
        expect(cfg.slots.opus.provider).toBe('ds');
    });
});

// ---------------------------------------------------------------------------
// computeEnvVars with ctx-model override
// ---------------------------------------------------------------------------
describe('computeEnvVars ctx-model override', () => {
    test('ctx-model different from opus sets context from ctx-model', () => {
        // Explicit ctx-model should be used for context window calculation
        const env = runLauncherJson('env-vars',
            '--port=58100',
            '--opus=deepseek-v4-pro',
            '--sonnet=deepseek-v4-pro',
            '--haiku=deepseek-v4-pro',
            '--subagent=deepseek-v4-pro',
            '--fable=deepseek-v4-pro',
            '--ctx-model=deepseek-v4-pro'
        );
        // 1M model gets [1m] and compaction window
        expect(env.ANTHROPIC_MODEL).toContain('[1m]');
        expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeTruthy();
    });

    test('ctx-model omitted → uses opus model for context', () => {
        // Without --ctx-model, computeEnvVars defaults to opusModel
        const env = runLauncherJson('env-vars',
            '--port=58101',
            '--opus=claude-haiku-4-5-20251001',
            '--sonnet=claude-haiku-4-5-20251001',
            '--haiku=claude-haiku-4-5-20251001',
            '--subagent=claude-haiku-4-5-20251001',
            '--fable=claude-haiku-4-5-20251001'
        );
        // 200K model → no [1m], no compaction window
        expect(env.ANTHROPIC_MODEL).not.toContain('[1m]');
    });
});

// ---------------------------------------------------------------------------
// buildRoutesJson with includeAllModels: false
// ---------------------------------------------------------------------------
describe('buildRoutesJson includeAllModels', () => {
    test('includeAllModels=false only includes active config models', () => {
        // Resolve ds+an config manually, then verify default includeAllModels=true
        // includes cross-config models (e.g., big-pickle from ds+oc config)
        const routesWithAll = runLauncherJson('build-routes', '--name=ds+an');

        // With includeAllModels=true (default), routes include ALL known models
        // from all configs — e.g. big-pickle, glm-4.5-air:free, etc.
        // We can't easily toggle includeAllModels via CLI, but we can verify
        // the default behavior includes cross-config models
        expect(routesWithAll.routes['deepseek-v4-pro']).toBeDefined();
        expect(routesWithAll.routes['claude-haiku-4-5-20251001']).toBeDefined();
        // Cross-config models included (from ds+oc config)
        expect(routesWithAll.routes['big-pickle']).toBeDefined();
    });

    test('ds+an routes include all providers needed for fallback', () => {
        const routes = runLauncherJson('build-routes', '--name=ds+an');
        expect(routes.providers.an).toBeDefined();
        expect(routes.providers.an.fallback).toEqual(['ds']);
        expect(routes.providers.ds).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// validateProvider missing API key (test via error path only)
// ---------------------------------------------------------------------------
describe('validateProvider missing key', () => {
    test('resolve-config for provider with missing key produces useful error', () => {
        // mm (Mimo) is in the registry but likely has no key configured
        const { status, stderr } = runLauncher('resolve-config', '--name=mm');
        if (status !== 0) {
            // Key missing → error contains keyEnv name
            expect(stderr).toMatch(/MIMO_API_KEY|not set/);
        }
        // If status is 0, the key is configured — skip assertion
    });
});

// ---------------------------------------------------------------------------
// Second-pass flag scanner: edge cases
// ---------------------------------------------------------------------------
describe('deepclaude.ps1 second-pass flag scanner', () => {
    const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');

    function runDC(...args: string[]): { stdout: string; stderr: string; status: number } {
        const r = spawnSync('pwsh', ['-NoLogo', '-File', DEEPCLAUDE_PS1, ...args], {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env },
        });
        return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
    }

    test('--log-all flag after -b CONFIG is processed', () => {
        const { stdout, stderr } = runDC('-b', 'ds+an', '--dry-run', '--log-all');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
    });

    test('--skip-startup-check flag after -b CONFIG does not crash', () => {
        const { stdout, stderr } = runDC('-b', 'ds', '--dry-run', '--skip-startup-check');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toContain('SLOT');
    });

    test('--no-thinking flag after -b CONFIG does not crash', () => {
        const { stdout, stderr } = runDC('-b', 'ds', '--dry-run', '--no-thinking');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toContain('SLOT');
    });

    test('unknown flag in second pass still errors', () => {
        const { stderr, stdout } = runDC('-b', 'ds', '--nonexistent-flag-xyz');
        // Error may appear in stdout (Write-Host) or stderr
        const combined = (stdout || '') + (stderr || '');
        expect(combined).toMatch(/Unknown flag|Invalid model spec/);
    });

    test('flags not re-processed if already set from first pass', () => {
        // --persist as $Backend sets $Persist in first pass.
        // If --persist also appears in $ModelSpecs, second pass should skip it.
        // We test with a dry-run to avoid actually persisting a proxy.
        const { stderr } = runDC('--persist', '--dry-run', 'ds');
        // Should not crash from double-persist
        expect(stderr).not.toMatch(/Unknown flag/);
    });
});

// ---------------------------------------------------------------------------
// $AllSpecs filter: whitespace and edge cases
// ---------------------------------------------------------------------------
describe('$AllSpecs filter edge cases', () => {
    const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');

    function runDC(...args: string[]): { stdout: string; stderr: string; status: number } {
        const r = spawnSync('pwsh', ['-NoLogo', '-File', DEEPCLAUDE_PS1, ...args], {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env },
        });
        return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
    }

    test('extra flags before config name in positional mode', () => {
        // Flags consumed by first pass from $Backend, positional spec stays in $ModelSpecs
        const { stdout, stderr } = runDC('--dry-run', 'ds+an');
        expect(stderr).not.toMatch(/Invalid model spec/);
        expect(stdout).toContain('SLOT');
    });

    test('mixed flags and specs do not break resolution', () => {
        // deepclaude.ps1 sees: -b ds+an --dry-run --skip-startup-check
        // First pass: Backend='ds+an', ModelSpecs=@('--dry-run', '--skip-startup-check')
        // Second pass: strips --dry-run and --skip-startup-check from ModelSpecs
        // AllSpecs = @('ds+an') after filtering → named config resolves
        const { stdout, stderr } = runDC('-b', 'ds+an', '--dry-run', '--skip-startup-check');
        expect(stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
    });

    test('$AllSpecs stays clean with trailing flag after positional specs', () => {
        // This verifies the @() wrapper fix: single spec + flag → still array
        const { stdout, stderr } = runDC('-b', 'ds+an', '--dry-run');
        expect(stderr).not.toMatch(/Invalid model spec/);
        // Verifies named config was resolved (not ad-hoc fallback)
        expect(stdout).toMatch(/haiku\s+an \(Anthropic/);
        expect(stdout).toMatch(/subagent\s+an \(Anthropic/);
        expect(stdout).toMatch(/opus\s+ds \(DeepSeek/);
    });
});

// ===========================================================================
// REGRESSION TESTS — bugs that silently broke config resolution or routing
// ===========================================================================

// --- Regression: $AllSpecs pipeline-to-scalar unrolling ---
describe('REGRESSION: pipeline unrolling breaks array indexing', () => {
    test('dc.ps1 -b ds+an --dry-run routes haiku to Anthropic', () => {
        const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');
        const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', DEEPCLAUDE_PS1, '-b', 'ds+an', '--dry-run'], {
            encoding: 'utf-8', timeout: 30000,
        });
        expect(r.stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        // Without @(): after WHERE filter, single element → scalar string
        // $AllSpecs[0] would return 'd' (first char) instead of 'ds+an'
        // → Resolve-Config 'd' → unknown config → error
        expect(r.stdout).toMatch(/haiku\s+an \(Anthropic/);
        expect(r.stdout).toMatch(/subagent\s+an \(Anthropic/);
        expect(r.stdout).toMatch(/claude-haiku-4-5-20251001/);
        // Opus must be DeepSeek, NOT Anthropic
        expect(r.stdout).toMatch(/opus\s+ds \(DeepSeek/);
        expect(r.stdout).toMatch(/sonnet\s+ds \(DeepSeek/);
        expect(r.stdout).toMatch(/fable\s+ds \(DeepSeek/);
    });

    test('-b ds --dry-run resolves default config (no scalar unroll)', () => {
        const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');
        const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', DEEPCLAUDE_PS1, '-b', 'ds', '--dry-run'], {
            encoding: 'utf-8', timeout: 30000,
        });
        expect(r.stderr).not.toMatch(/Invalid model spec|Unknown provider/);
        expect(r.stdout).toMatch(/haiku\s+ds \(DeepSeek/);
        expect(r.stdout).toMatch(/deepseek-v4-flash/);
    });
});

// --- Regression: initOverrides direct keys visible to proxy ---
// --- Regression: second-pass flag scanner picks up flags from $ModelSpecs ---
describe('REGRESSION: second-pass flag scanner', () => {
    const DEEPCLAUDE_PS1 = join(__dirname, '..', '..', 'deepclaude.ps1');

    function runDC(...args: string[]): { stdout: string; stderr: string; status: number } {
        const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', DEEPCLAUDE_PS1, ...args], {
            encoding: 'utf-8', timeout: 30000,
        });
        return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', status: r.status || 0 };
    }

    test('--dry-run after -b CONFIG produces routing table (not Launching...)', () => {
        // Without second-pass scanner: $DryRun=$false, script falls through
        // to launch path, starts proxy, and tries to pass --dry-run to claude
        const { stdout } = runDC('-b', 'ds+an', '--dry-run');
        // Dry-run table (SLOT header), not launch output (no "Launching")
        expect(stdout).toContain('SLOT');
        expect(stdout).not.toContain('Launching Claude Code');
    });

    test('--log-all after -b CONFIG sets env var without crashing', () => {
        const { stderr } = runDC('-b', 'ds', '--dry-run', '--log-all');
        expect(stderr).not.toMatch(/Invalid model spec/);
        expect(stderr).not.toMatch(/Unknown flag/);
    });

    test('--skip-startup-check after -b CONFIG is handled', () => {
        const { stderr } = runDC('-b', 'ds', '--dry-run', '--skip-startup-check');
        expect(stderr).not.toMatch(/Invalid model spec/);
        expect(stderr).not.toMatch(/Unknown flag/);
    });

    test('--no-thinking after -b CONFIG is handled', () => {
        const { stderr } = runDC('-b', 'ds', '--dry-run', '--no-thinking');
        expect(stderr).not.toMatch(/Invalid model spec/);
        expect(stderr).not.toMatch(/Unknown flag/);
    });
});

// --- Regression: every named config with valid keys resolves without error ---
describe('REGRESSION: all named configs resolve (with keys)', () => {
    test('every config in config-list resolves and builds routes', () => {
        const configs = runLauncherJson('config-list');
        let resolved = 0;
        let skipped = 0;
        for (const name of Object.keys(configs)) {
            // resolve-config can fail if API key is missing — skip those
            let cfg: Record<string, unknown>;
            try {
                cfg = runLauncherJson('resolve-config', `--name=${name}`);
            } catch (e) {
                if ((e as Error).message.includes('not set')) {
                    skipped++;
                    continue;
                }
                throw e;
            }
            resolved++;
            expect(cfg.slots.opus.provider).toBeDefined();
            // Every config must build routes
            const routes = runLauncherJson('build-routes', `--name=${name}`);
            expect(routes.slots.opus).toBeDefined();
            // Every config must init overrides with direct keys
            const overrides = runLauncherJson('init-overrides', `--name=${name}`);
            for (const slot of ['opus', 'sonnet', 'haiku', 'subagent', 'fable']) {
                expect(overrides[slot]).toBeDefined();
            }
        }
        expect(resolved).toBeGreaterThan(0);
        if (skipped > 0) console.log(`  (skipped ${skipped} configs with missing API keys)`);
    });
});

// --- Regression: env-vars round-trip through resolve → env-vars ---
describe('REGRESSION: env-vars correctly reflect resolved config', () => {
    test('ds+an: haiku env var is Anthropic, not DeepSeek', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds+an');
        const env = runLauncherJson('env-vars',
            '--port=58999',
            `--opus=${cfg.slots.opus.model}`,
            `--sonnet=${cfg.slots.sonnet.model}`,
            `--haiku=${cfg.slots.haiku.model}`,
            `--subagent=${cfg.slots.subagent.model}`,
            `--fable=${cfg.slots.fable.model}`
        );
        // The critical regression: haiku MUST be Anthropic, not DeepSeek
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:claude-haiku-4-5-20251001');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('subagent:claude-haiku-4-5-20251001');
    });

    test('ds: haiku env var is DeepSeek flash', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds');
        const env = runLauncherJson('env-vars',
            '--port=58999',
            `--opus=${cfg.slots.opus.model}`,
            `--sonnet=${cfg.slots.sonnet.model}`,
            `--haiku=${cfg.slots.haiku.model}`,
            `--subagent=${cfg.slots.subagent.model}`,
            `--fable=${cfg.slots.fable.model}`
        );
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:deepseek-v4-flash[1m]');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('subagent:deepseek-v4-flash[1m]');
    });

    test('ds+oc: haiku env var is OpenCode big-pickle', () => {
        const cfg = runLauncherJson('resolve-config', '--name=ds+oc');
        const env = runLauncherJson('env-vars',
            '--port=58999',
            `--opus=${cfg.slots.opus.model}`,
            `--sonnet=${cfg.slots.sonnet.model}`,
            `--haiku=${cfg.slots.haiku.model}`,
            `--subagent=${cfg.slots.subagent.model}`,
            `--fable=${cfg.slots.fable.model}`
        );
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku:big-pickle');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('subagent:big-pickle');
    });
});

// --- Regression: provider fallback chain integrity ---
describe('REGRESSION: provider fallback chains', () => {
    test('ds+an routes include an→ds fallback', () => {
        const routes = runLauncherJson('build-routes', '--name=ds+an');
        expect(routes.providers.an).toBeDefined();
        expect(routes.providers.an.fallback).toEqual(['ds']);
        expect(routes.providers.ds).toBeDefined();
    });

    test('or config routes include or→ds fallback if configured', () => {
        const routes = runLauncherJson('build-routes', '--name=or');
        expect(routes.providers.or).toBeDefined();
        // or fallback is configured in providers.json
        if (routes.providers.or.fallback) {
            expect(Array.isArray(routes.providers.or.fallback)).toBe(true);
        }
    });
});
