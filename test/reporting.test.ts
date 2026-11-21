import { addListener, clearListeners, report, setCategories } from '@punyts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenToLibraries, reportCategories } from '../src/config/reporter.js';
import { call, createApp, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

interface Line {
    readonly category: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
}

const SECRET = 'secret@value.test';
const EMAIL = '$.screens.home.children.form.children.email.value';

let data: TempData;
let harness: InMemoryHarness;
let lines: Line[];

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    lines = [];
    setCategories(['stateui-mcp.*']);
    addListener((_timestamp, category, message, details) => lines.push({ category, message, details: details as Record<string, unknown> }), ['stateui-mcp.*']);
});

afterEach(async () => {
    setCategories(['info', 'error', 'stack']);
    clearListeners();
    await harness.close();
    await data.cleanup();
});

describe('reporting', () => {
    it('should report tool calls, use cases, storage and views under stateui-mcp.*, with names and durations and no value', async () => {
        // Arrange
        const app = await createApp(harness.client, 'form');

        // Act
        const set = await call(harness.client, 'ui_state_set', { app: app.name, path: EMAIL, value: SECRET });
        const refused = await call(harness.client, 'ui_get', { kind: 'apps', name: 'missing' });
        harness.services.hub.attach(app.id, { id: 'view-1', kind: 'browser', send: () => undefined })();

        // Assert
        expect(set.isError).toBe(false);
        expect(refused.isError).toBe(true);
        const tools = lines.filter((line) => line.category === 'stateui-mcp.tool');
        expect(tools).toContainEqual({ category: 'stateui-mcp.tool', message: 'Tool call', details: { tool: 'ui_app_create', ms: expect.any(Number), outcome: 'ok' } });
        expect(tools).toContainEqual({ category: 'stateui-mcp.tool', message: 'Tool call', details: { tool: 'ui_state_set', ms: expect.any(Number), outcome: 'ok' } });
        expect(tools).toContainEqual({ category: 'stateui-mcp.tool', message: 'Tool call', details: { tool: 'ui_get', ms: expect.any(Number), outcome: 'refused', code: refused.body['error'] } });
        expect(lines).toContainEqual({ category: 'stateui-mcp.usecase', message: 'Use case run', details: { useCase: 'setPartState', ms: expect.any(Number), outcome: 'written' } });
        expect(lines).toContainEqual({ category: 'stateui-mcp.storage', message: 'Part created', details: { kind: 'apps', id: app.id, revision: 1 } });
        expect(lines).toContainEqual({ category: 'stateui-mcp.preview', message: 'View attached', details: { appId: app.id, viewId: 'view-1', viewKind: 'browser', views: 1 } });
        expect(lines).toContainEqual({ category: 'stateui-mcp.preview', message: 'View detached', details: { appId: app.id, viewId: 'view-1', views: 0 } });
        expect(JSON.stringify(lines)).not.toContain(SECRET);
    });

    it('should write warnings, errors and the PUNYTS_REPORT categories of the default reporter to stderr, and nothing else', () => {
        // Arrange
        clearListeners();
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stop = listenToLibraries({ PUNYTS_REPORT: ' stateui-mcp.tool , state-sync.* ' });

        // Act
        report('stateui-mcp.tool', 'Tool call', { tool: 'ui_get', ms: 1.5, outcome: 'ok' });
        report('state-sync.client', 'Connected');
        report('stateui-mcp.storage', 'Part read', { kind: 'apps' });
        report.warning('A library warning', { path: '$.app' });
        stop();
        report.warning('After stopping');
        const written = write.mock.calls.map(([text]) => String(text));
        write.mockRestore();

        // Assert
        expect(reportCategories({ PUNYTS_REPORT: ' stateui-mcp.tool , state-sync.* ' })).toEqual(['stateui-mcp.tool', 'state-sync.*']);
        expect(written).toEqual([
            '[stateui-mcp] stateui-mcp.tool Tool call {"tool":"ui_get","ms":1.5,"outcome":"ok"}\n',
            '[stateui-mcp] state-sync.client Connected\n',
            '[stateui-mcp] warning A library warning {"path":"$.app"}\n'
        ]);
    });
});
