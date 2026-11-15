import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

let data: TempData;
let harness: InMemoryHarness;

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

async function write(kind: 'models' | 'apps', name: string, body: unknown): Promise<void> {
    const written = await harness.services.useCases.writePart!.execute({ kind, name, body: body as UiPartBodies['apps'] });
    if (written.kind !== 'written') throw new Error(JSON.stringify(written));
}

async function stateOf(name: string): Promise<Record<string, unknown>> {
    const part = await harness.services.parts.findByName('apps', name);
    const result = (await harness.services.useCases.getPartState.execute(part as never)) as unknown as { state: Record<string, unknown> };
    return result.state;
}

describe('Logic that reads another app', () => {
    it("should show the other app's path at $.external, run the app's logic on its changes, and never store it", async () => {
        // Arrange: a notes app, and a dashboard that reads its notes and copies the latest title into a field
        await write('models', 'note', { fields: { title: { type: 'string' } } });
        await write('apps', 'notes', { uses: { data: { notes: { model: 'note', scope: 'persona' } } }, start: 'home', app: { component: 'app' }, screens: { home: { root: { component: 'text', _text: 'Notes' } } } });
        const notes = await harness.services.parts.findByName('apps', 'notes');
        await write('apps', 'dashboard', {
            uses: { external: { notes: { app: notes?.id, path: '$.data.notes' } } },
            start: 'home',
            app: { component: 'app' },
            screens: { home: { root: { component: 'form', children: { latest: { component: 'textField', _label: 'Latest note' } } } } },
            logic: { rules: { latest: { when: { path: '$.external.notes.{id}.title' }, do: [{ command: 'set', target: '$.screens.home.children.latest.value', value: '$trigger' }] } } }
        });
        await stateOf('dashboard');

        // Act
        const written = await harness.services.useCases.setPartState.execute('notes', { path: '$.data.notes.n1', value: { title: 'Buy milk' } });
        const state = await vi.waitFor(async () => {
            const current = await stateOf('dashboard');
            expect((current['screens'] as { home?: { children?: { latest?: { value?: string } } } })?.home?.children?.latest?.value).toBe('Buy milk');
            return current;
        });

        // Assert
        expect(written).toMatchObject({ kind: expect.not.stringMatching(/refused|invalid/) });
        expect(state['external']).toEqual({ notes: { n1: { title: 'Buy milk' } } });
        // what the dashboard stores of its instance has its own field, and nothing of what it read
        const dashboard = await harness.services.parts.findByName('apps', 'dashboard');
        const file = await vi.waitFor(async () => {
            const found = (await readdir(data.dir, { recursive: true })).find((name) => name.endsWith(`${dashboard?.id}.json`) && name.includes('personas'));
            expect(found).toBeDefined();
            const text = await readFile(join(data.dir, found as string), 'utf8');
            expect(text).toContain('Buy milk');
            return text;
        });
        expect(file).not.toContain('external');
    });
});
