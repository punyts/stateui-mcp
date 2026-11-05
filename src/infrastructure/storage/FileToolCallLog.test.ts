import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallEntry } from '../../application/ports/ToolCallLog.js';
import { FileToolCallLog } from './FileToolCallLog.js';

const ENTRY: ToolCallEntry = Object.freeze({
    at: '2026-11-04T10:00:00.000Z',
    tool: 'ui_nodes_write',
    ok: false,
    errorCode: 'invalid-document',
    requestChars: 120,
    responseChars: 340,
    target: 'app-1',
    errorCount: 2,
    warningCount: 1
});

describe('FileToolCallLog', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stateui-tool-log-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('should append one JSON line per call, in call order', async () => {
        // Arrange
        const file = join(dir, 'calls.jsonl');
        const log = new FileToolCallLog(file, { info: vi.fn() });

        // Act
        void log.record(ENTRY);
        await log.record({ ...ENTRY, tool: 'ui_validate', ok: true });

        // Assert
        const lines = (await readFile(file, 'utf8')).split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[2]).toBe('');
        expect(JSON.parse(lines[0] as string)).toEqual(ENTRY);
        expect(JSON.parse(lines[1] as string)).toMatchObject({ tool: 'ui_validate', ok: true });
    });

    it('should write only the known fields, never extra ones', async () => {
        // Arrange
        const file = join(dir, 'calls.jsonl');
        const log = new FileToolCallLog(file, { info: vi.fn() });
        const smuggled = { ...ENTRY, arguments: { document: 'secret text' }, body: 'response body' } as ToolCallEntry;

        // Act
        await log.record(smuggled);

        // Assert
        const text = await readFile(file, 'utf8');
        expect(text).not.toContain('secret text');
        expect(text).not.toContain('response body');
        expect(Object.keys(JSON.parse(text) as object)).toEqual(['at', 'tool', 'ok', 'errorCode', 'requestChars', 'responseChars', 'target', 'errorCount', 'warningCount']);
    });

    it('should leave out the optional fields a call does not have', async () => {
        // Arrange
        const file = join(dir, 'calls.jsonl');
        const log = new FileToolCallLog(file, { info: vi.fn() });

        // Act
        await log.record({ at: ENTRY.at, tool: 'ui_components_search', ok: true, requestChars: 2, responseChars: 50 });

        // Assert
        expect(JSON.parse(await readFile(file, 'utf8')) as object).toEqual({ at: ENTRY.at, tool: 'ui_components_search', ok: true, requestChars: 2, responseChars: 50 });
    });

    it('should not throw when the write fails, and report it once', async () => {
        // Arrange
        const info = vi.fn();
        const log = new FileToolCallLog(join(dir, 'missing-folder', 'calls.jsonl'), { info });

        // Act
        await log.record(ENTRY);
        await log.record(ENTRY);

        // Assert
        expect(info).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith('Tool call log write failed', expect.objectContaining({ file: join(dir, 'missing-folder', 'calls.jsonl') }));
    });
});
