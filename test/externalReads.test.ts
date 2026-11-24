import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { createServices } from '../src/config/createServices.js';
import type { SharedData, SharedDataListener } from '../src/index.js';
import { inMemoryHarness, silentReport, tempData } from './helpers.js';
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
        await write('apps', 'notes', { uses: { data: { notes: { model: 'note', scope: 'person' } } }, start: 'home', app: { component: 'app' }, screens: { home: { root: { component: 'text', _text: 'Notes' } } } });
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
            const found = (await readdir(data.dir, { recursive: true })).find((name) => name.endsWith(`${dashboard?.id}.json`) && name.includes('people'));
            expect(found).toBeDefined();
            const text = await readFile(join(data.dir, found as string), 'utf8');
            expect(text).toContain('Buy milk');
            return text;
        });
        expect(file).not.toContain('external');
    });
});

describe("Logic that reads another owner's shared dataset", () => {
    const OWNER = '0f8fad5b-d9cb-469f-a165-70867728950e';

    it('should show its records at $.external, run the logic on their changes, refuse a write there and clear them when the share ends', async () => {
        // Arrange: a shared dataset this test plays the owner of, read by an app through sharedData
        const listeners: SharedDataListener[] = [];
        const opened: string[] = [];
        let closed = 0;
        const sharedData: SharedData = {
            open: (owner, dataset, listener) => {
                opened.push(`${owner}/${dataset}`);
                listeners.push(listener);
                listener.records({ p1: { name: 'Tea', price: 3 } });
                return { close: () => void (closed += 1) };
            }
        };
        const services = createServices({ dataDir: data.dir + '-shared', report: silentReport, origin: () => 'http://127.0.0.1:4100', sharedData });
        try {
            const written = await services.useCases.writePart!.execute({
                kind: 'apps',
                name: 'menu',
                body: {
                    uses: { external: { prices: { owner: OWNER, dataset: 'price-list' } } },
                    start: 'home',
                    app: { component: 'app' },
                    screens: { home: { root: { component: 'form', children: { last: { component: 'textField', _label: 'Last price' } } } } },
                    logic: { rules: { last: { when: { path: '$.external.prices.{id}.name' }, do: [{ command: 'set', target: '$.screens.home.children.last.value', value: '$trigger' }] } } }
                } as unknown as UiPartBodies['apps']
            });
            expect(written.kind).toBe('written');
            const menu = await services.parts.findByName('apps', 'menu');
            const state = async (): Promise<Record<string, unknown>> => ((await services.useCases.getPartState.execute(menu as never)) as unknown as { state: Record<string, unknown> }).state;
            await state();

            // Act: the owner changes a record
            listeners[0]?.records({ p1: { name: 'Tea', price: 3 }, p2: { name: 'Coffee', price: 4 } });

            // Assert: the records show, the logic ran on the change, and a write there is refused
            const shown = await vi.waitFor(async () => {
                const current = await state();
                expect((current['external'] as { prices?: object } | undefined)?.prices).toEqual({ p1: { name: 'Tea', price: 3 }, p2: { name: 'Coffee', price: 4 } });
                return current;
            });
            expect(opened).toEqual([`${OWNER}/price-list`]);
            expect((shown['screens'] as { home: { children: { last: { value?: string } } } }).home.children.last.value).toBe('Coffee');
            const refused = await services.useCases.setPartState.execute('menu', { path: '$.external.prices.p3', value: { name: 'Juice' } });
            expect(refused).toMatchObject({ kind: 'refused' });

            // Act: the share ends
            listeners[0]?.ended('revoked');

            // Assert: nothing of it is left
            await vi.waitFor(async () => expect((await state())['external'] ?? {}).toEqual({}));
        } finally {
            await services.authorities.close();
        }
        expect(closed).toBe(1);
    });
});
