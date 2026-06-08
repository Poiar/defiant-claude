'use strict';

import {
    buildFriendlyResponse,
    buildFriendlyStreamEvents,
} from '../friendly-error';

describe('buildFriendlyResponse', () => {
    test('returns 200 status', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        expect(resp.status).toBe(200);
    });

    test('body is valid JSON with message structure', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        const body = JSON.parse(resp.body);
        expect(body.type).toBe('message');
        expect(body.role).toBe('assistant');
        expect(Array.isArray(body.content)).toBe(true);
        expect(body.content[0].type).toBe('text');
        expect(body.stop_reason).toBe('end_turn');
    });

    test('includes attempted providers in text', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [
            { providerKey: 'anthropic' },
            { providerKey: 'openai' },
        ]);
        const body = JSON.parse(resp.body);
        expect(body.content[0].text).toContain('anthropic');
        expect(body.content[0].text).toContain('openai');
    });

    test('includes model name', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        const body = JSON.parse(resp.body);
        expect(body.model).toBe('claude-sonnet-4');
    });

    test('includes x-fallback-exhausted header', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        expect(resp.headers['x-fallback-exhausted']).toBe('true');
    });

    test('includes x-attempted-providers header', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', [
            { providerKey: 'anthropic' },
            { providerKey: 'openrouter' },
        ]);
        expect(resp.headers['x-attempted-providers']).toBe('anthropic, openrouter');
    });

    test('handles empty attemptedProviders', () => {
        const resp = buildFriendlyResponse(502, 'claude-sonnet-4', []);
        const body = JSON.parse(resp.body);
        expect(body.content[0].text).toContain('all configured providers');
    });

    test('handles null lastStatus', () => {
        const resp = buildFriendlyResponse(null, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        const body = JSON.parse(resp.body);
        expect(body.content[0].text).toContain('connection failure');
    });
});

describe('buildFriendlyStreamEvents', () => {
    test('returns SSE-formatted string', () => {
        const events = buildFriendlyStreamEvents(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        expect(events).toContain('event: error');
        expect(events).toContain('event: message_stop');
    });

    test('includes error_code E012', () => {
        const events = buildFriendlyStreamEvents(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        expect(events).toContain('E012');
    });

    test('ends with [DONE]', () => {
        const events = buildFriendlyStreamEvents(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        expect(events.trim().endsWith('data: [DONE]')).toBe(true);
    });

    test('includes attempted providers in error message', () => {
        const events = buildFriendlyStreamEvents(502, 'claude-sonnet-4', [
            { providerKey: 'anthropic' },
            { providerKey: 'openai' },
        ]);
        expect(events).toContain('anthropic');
        expect(events).toContain('openai');
    });

    test('has valid JSON in error event data', () => {
        const events = buildFriendlyStreamEvents(502, 'claude-sonnet-4', [{ providerKey: 'anthropic' }]);
        const dataLine = events.match(/data: (.+)/);
        expect(dataLine).not.toBeNull();
        const parsed = JSON.parse(dataLine![1]);
        expect(parsed.type).toBe('exhausted');
        expect(parsed.error_code).toBe('E012');
    });
});
