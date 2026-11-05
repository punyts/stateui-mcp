import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBrowser } from '../src/infrastructure/preview/BrowserPreview.js';
import { BrowserUnavailableError } from '../src/infrastructure/preview/BrowserPreview.js';
import type { ViewMessage } from '../src/infrastructure/preview/PreviewHub.js';
import { call, createApp, inMemoryHarness, noBrowser, shellOf, tempData } from './helpers.js';
import type { CreatedApp, InMemoryHarness, TempData } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const EMAIL = '$.app.children.form.children.email.value';

let data: TempData;
let harness: InMemoryHarness;
let browser: { [K in keyof PreviewBrowser]: ReturnType<typeof vi.fn> };

function createBrowser(): typeof browser {
    return {
        open: vi.fn(async () => ({ rendered: true })),
        screenshot: vi.fn(async () => ({ png: PNG, width: 1280, height: 800, target: 'page' })),
        interact: vi.fn(async () => ({ results: [{ index: 0, action: 'click', path: '$.app', ok: true }], errors: [], events: [], cursor: 0 })),
        rendered: vi.fn(async () => []),
        closePage: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined)
    };
}

async function createForm(name = 'form'): Promise<CreatedApp> {
    return createApp(harness.client, name);
}

/** A view that is open: it records what the server sends */
function openView(appId: string, kind: 'browser' | 'headless' = 'browser'): ViewMessage[] {
    const received: ViewMessage[] = [];
    harness.services.hub.attach(appId, {
        id: `${kind}-view`,
        kind,
        send: (message) => {
            received.push(message);
        }
    });
    harness.services.hub.touch(appId, `${kind}-view`, { ready: true, revision: 1 });
    return received;
}

/** A sync connection to the app's instance, as a view's socket makes one: it says hello and records what comes back */
async function syncView(app: CreatedApp): Promise<{ readonly received: Record<string, unknown>[]; send(message: object): void }> {
    const found = await harness.services.useCases.findPartApp.execute(app.name);
    if (found.kind !== 'found') throw new Error('the app is stored');
    const authority = await harness.services.instanceViews.authority(found.part);
    const received: Record<string, unknown>[] = [];
    const session = authority.connect({ send: (text) => received.push(JSON.parse(text) as Record<string, unknown>), close: () => undefined });
    const send = (message: object): void => session.receive(JSON.stringify(message));
    send({ type: 'hello', namespace: harness.services.instanceViews.namespace(found.part), revision: 0, clientId: 'view-1', protocol: 1 });
    return { received, send };
}

beforeEach(async () => {
    data = await tempData();
    browser = createBrowser();
    harness = await inMemoryHarness(data.dir, browser as unknown as PreviewBrowser);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('catalog tools', () => {
    it('should find a component by a need in plain words, with the matched phrase and an example', async () => {
        const result = await call(harness.client, 'ui_components_search', { need: 'pick a date range' });
        const results = result.body['results'] as { name: string; matched: string[]; example: object }[];

        expect(result.isError).toBe(false);
        expect(result.body['weak']).toBe(false);
        expect(results[0]?.name).toBe('dateRangeField');
        expect(results[0]?.matched).toContain('pick a date range');
        expect(results.every((hit) => typeof hit.example === 'object')).toBe(true);
    });

    it('should narrow by category and cap the limit at 20', async () => {
        const forms = await call(harness.client, 'ui_components_search', { need: 'enter text', category: 'forms', limit: 50 });
        const all = await call(harness.client, 'ui_components_search', { need: 'show', limit: 50 });

        expect((forms.body['results'] as { category: string }[]).every((hit) => hit.category === 'forms')).toBe(true);
        expect((all.body['results'] as unknown[]).length).toBeLessThanOrEqual(20);
    });

    it('should answer a need that matches nothing with the weak result and the category index', async () => {
        const nonsense = await call(harness.client, 'ui_components_search', { need: 'xyzzy' });
        const blank = await call(harness.client, 'ui_components_search', { need: '   ' });

        expect(nonsense.isError).toBe(false);
        expect(nonsense.body['weak']).toBe(true);
        expect((nonsense.body['categories'] as unknown[]).length).toBeGreaterThan(0);
        expect((nonsense.body['results'] as unknown[]).length).toBeGreaterThan(0);
        expect(blank.body['weak']).toBe(true);
    });

    it('should refuse an absent need, an unknown category and an unknown tier', async () => {
        const absent = await call(harness.client, 'ui_components_search', {});
        const category = await call(harness.client, 'ui_components_search', { need: 'x', category: 'widgets' });
        const tier = await call(harness.client, 'ui_components_search', { need: 'x', tier: 'atom' });

        expect(absent.body['error']).toBe('invalid-argument');
        expect(category.body['error']).toBe('invalid-argument');
        expect(category.body['allowed']).toContain('forms');
        expect(tier.body['error']).toBe('invalid-argument');
        expect(tier.body['allowed']).toEqual(['composed', 'root']);
    });


    it('should return the compact entry of a component', async () => {
        const result = await call(harness.client, 'ui_component_get', { name: 'button' });

        expect(result.isError).toBe(false);
        expect(result.body['name']).toBe('button');
        expect(result.body['events']).toContain('press');
        expect(result.body).not.toHaveProperty('shape');
        expect(result.body).not.toHaveProperty('purposes');
        expect(JSON.stringify(result.body['properties'])).not.toContain('"reflect"');
    });

    it('should answer an unknown component with the nearest names', async () => {
        const result = await call(harness.client, 'ui_component_get', { name: 'buton' });

        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('unknown-component');
        expect(result.body['nearest']).toContain('button');
    });

    it('should search icons and report how many more matched', async () => {
        const result = await call(harness.client, 'ui_icons_list', { query: 'trash', limit: 3 });

        expect(result.isError).toBe(false);
        expect((result.body['icons'] as unknown[]).length).toBeLessThanOrEqual(3);
        expect(result.body['total']).toBeGreaterThan(0);
    });

    it('should list theme tokens and overlays, and name the groups for an unknown group', async () => {
        const tokens = await call(harness.client, 'ui_tokens_list', { group: 'color', includeOverlays: true });
        const unknown = await call(harness.client, 'ui_tokens_list', { group: 'nope' });

        expect(tokens.isError).toBe(false);
        expect(tokens.body['count']).toBeGreaterThan(0);
        expect(tokens.body['overlays']).toBeDefined();
        expect(unknown.body['error']).toBe('unknown-group');
        expect(unknown.body['groups']).toContain('color');
    });
});

describe('live tools', () => {
    it('should read the state a view changed over its sync connection, below a parent the state did not have', async () => {
        // Arrange
        const app = await createForm();
        openView(app.id);
        const synced = await syncView(app);

        // Act
        synced.send({ type: 'change', change: { id: 'c1', path: EMAIL, op: 'set', value: 'typed', base: 0 } });
        const state = await call(harness.client, 'ui_state_get', { app: app.name, path: '$.app.children.form' });

        // Assert
        expect(synced.received.at(-1)).toMatchObject({ type: 'ack', id: 'c1', result: 'applied' });
        expect(state.body).toMatchObject({ source: 'instance', value: { children: { email: { value: 'typed' } } } });
        expect((state.body['preview'] as { attached: boolean }).attached).toBe(true);
    });

    it('should queue the emits of a synced view for ui_events_read', async () => {
        const app = await createForm();
        openView(app.id);
        const synced = await syncView(app);

        synced.send({ type: 'emit', name: 'form.saved', value: 'ok' });
        const events = await call(harness.client, 'ui_events_read', { app: app.name });

        expect((events.body['events'] as { name: string; payload: unknown }[]).map((event) => [event.name, event.payload])).toEqual([['form.saved', 'ok']]);
    });

    it('should open the headless page and return the url a person can open', async () => {
        const app = await createForm();

        const preview = await call(harness.client, 'ui_preview', { app: app.name });

        expect(browser['open']).toHaveBeenCalledWith(app.id, 1, undefined);
        expect(preview.body).toMatchObject({ app: app.name, revision: 1, url: `http://127.0.0.1:4100/apps/${app.id}`, rendered: true, errors: [] });
    });

    it('should still return the url, with a note, when Chromium is not installed', async () => {
        const app = await createForm();
        browser['open']?.mockRejectedValueOnce(new BrowserUnavailableError('missing'));

        const preview = await call(harness.client, 'ui_preview', { app: app.name });

        expect(preview.isError).toBe(false);
        expect(preview.body['rendered']).toBe(false);
        expect(String(preview.body['note'])).toContain('npx playwright install chromium');
    });

    it('should include the runtime errors the views reported in the preview result', async () => {
        const app = await createForm();
        await harness.services.useCases.recordPreviewErrors.execute(app.id, [{ code: 'SUI-RUN-BINDING', message: 'boom' }]);

        const preview = await call(harness.client, 'ui_preview', { app: app.name });

        expect(preview.body['errors']).toEqual([{ code: 'SUI-RUN-BINDING', message: 'boom' }]);
    });

    it('should return the screenshot as an MCP image next to a short summary', async () => {
        const app = await createForm();

        const shot = await call(harness.client, 'ui_screenshot', { app: app.name, path: '$.app.children.form', width: 800, height: 600, mode: 'dark' });

        expect(browser['screenshot']).toHaveBeenCalledWith(app.id, 1, { path: '$.app.children.form', width: 800, height: 600, mode: 'dark' });
        expect(shot.images).toEqual([{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
        expect(shot.body).toMatchObject({ app: app.name, revision: 1, target: 'page', mode: 'dark' });
    });

    it('should say how to install Chromium when a screenshot cannot be taken', async () => {
        const app = await createForm();
        browser['screenshot']?.mockRejectedValueOnce(new BrowserUnavailableError('missing'));

        const shot = await call(harness.client, 'ui_screenshot', { app: app.name });

        expect(shot.isError).toBe(true);
        expect(shot.body['error']).toBe('browser-unavailable');
    });

    it('should run the actions and return the results, errors and emits', async () => {
        const app = await createForm();
        browser['interact']?.mockResolvedValueOnce({
            results: [{ index: 0, action: 'click', path: '$.app.children.form.children.save', ok: true }],
            errors: [],
            events: [{ cursor: 1, name: 'form.saved', payload: 'ok', at: 'now', view: 'headless' }],
            cursor: 1
        });

        const result = await call(harness.client, 'ui_interact', { app: app.name, actions: [{ action: 'click', path: '$.app.children.form.children.save' }] });

        expect(browser['interact']).toHaveBeenCalledWith(app.id, 1, [{ action: 'click', path: '$.app.children.form.children.save' }]);
        expect(result.isError).toBe(false);
        expect(result.body['emits']).toEqual([{ cursor: 1, name: 'form.saved', payload: 'ok', at: 'now', view: 'headless' }]);
    });

    it('should mark the call as an error when an action failed and keep the results', async () => {
        const app = await createForm();
        browser['interact']?.mockResolvedValueOnce({
            results: [{ index: 0, action: 'click', path: '$.app.x', ok: false, error: 'Nothing is rendered' }],
            errors: [],
            events: [],
            cursor: 0
        });

        const result = await call(harness.client, 'ui_interact', { app: app.name, actions: [{ action: 'click', path: '$.app.x' }] });

        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('action-failed');
        expect((result.body['results'] as { ok: boolean }[])[0]?.ok).toBe(false);
    });

    it('should refuse an action it does not know', async () => {
        const app = await createForm();

        const result = await call(harness.client, 'ui_interact', { app: app.name, actions: [{ action: 'swipe', path: '$.app' }] });

        expect(result.body['error']).toBe('invalid-argument');
        expect(browser['interact']).not.toHaveBeenCalled();
    });

    it('should refuse an action other than key that has no path', async () => {
        const app = await createForm();

        const result = await call(harness.client, 'ui_interact', { app: app.name, actions: [{ action: 'key', value: 'Space' }, { action: 'click' }] });

        expect(result.body['error']).toBe('invalid-argument');
        expect(browser['interact']).not.toHaveBeenCalled();
    });

    it('should read the queued emit events after a cursor', async () => {
        const app = await createForm();
        openView(app.id);
        harness.services.hub.recordEvent(app.id, 'browser-view', 'one', { n: 1 });
        const first = await call(harness.client, 'ui_events_read', { app: app.name });
        harness.services.hub.recordEvent(app.id, 'browser-view', 'two', undefined);

        const next = await call(harness.client, 'ui_events_read', { app: app.name, since: first.body['cursor'] });

        expect((first.body['events'] as { name: string }[]).map((event) => event.name)).toEqual(['one']);
        expect((next.body['events'] as { name: string }[]).map((event) => event.name)).toEqual(['two']);
        expect(next.body['cursor']).toBe(2);
    });

    it('should accept cursor as the since of ui_events_read', async () => {
        const app = await createForm();
        openView(app.id);
        harness.services.hub.recordEvent(app.id, 'browser-view', 'one', 1);
        harness.services.hub.recordEvent(app.id, 'browser-view', 'two', 2);

        const result = await call(harness.client, 'ui_events_read', { app: app.name, cursor: 1 });

        expect((result.body['events'] as { name: string }[]).map((event) => event.name)).toEqual(['two']);
    });

    it('should keep at most 500 events per app', async () => {
        const app = await createForm();
        for (let n = 0; n < 510; n++) harness.services.hub.recordEvent(app.id, 'v', `e${n}`, n);

        const result = await call(harness.client, 'ui_events_read', { app: app.name });

        const events = result.body['events'] as { name: string }[];
        expect(events).toHaveLength(500);
        expect(events[0]?.name).toBe('e10');
    });

    it('should say no preview is open when a command has no view to go to', async () => {
        const app = await createApp(harness.client, 'toasts', shellOf({ toasts: { component: 'toastRegion', messages: { saved: { _text: 'Saved' } } } }));

        const result = await call(harness.client, 'ui_command', { app: app.name, target: 'app.children.toasts', command: 'show', value: 'saved' });

        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ previewAttached: false, message: 'no preview is open; the command was not delivered' });
    });

    it('should deliver a command to every open view, the headless page included', async () => {
        const app = await createApp(harness.client, 'toasts', shellOf({ toasts: { component: 'toastRegion', messages: { saved: { _text: 'Saved' } } } }));
        const person = openView(app.id, 'browser');
        const headless = openView(app.id, 'headless');

        const result = await call(harness.client, 'ui_command', { app: app.name, target: 'app.children.toasts', command: 'show', value: 'saved' });

        expect(result.body).toMatchObject({ previewAttached: true, message: 'delivered to 2 open views' });
        for (const received of [person, headless]) {
            expect(received.filter((message) => message.type === 'command')).toMatchObject([{ target: 'app.children.toasts', command: 'show', value: 'saved' }]);
        }
    });

    it('should refuse an undeclared command with the declared ones', async () => {
        const app = await createForm();

        const result = await call(harness.client, 'ui_command', { app: app.name, target: 'app.children.form.children.save', command: 'explode' });

        expect(result.body['error']).toBe('unknown-command');
        expect(result.body['declared']).toEqual(['focus']);
    });
});

describe('file tool', () => {
    async function* bytes(text: string): AsyncIterable<Uint8Array> {
        yield Buffer.from(text);
    }

    it('should read an uploaded text file and return null text for an image', async () => {
        const app = await createForm();
        const text = await harness.services.useCases.uploadFile.execute(app.id, { name: 'notes.txt', content: bytes('hello') });
        const image = await harness.services.useCases.uploadFile.execute(app.id, {
            name: 'pic.png',
            content: (async function* () {
                yield Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
            })()
        });
        if (text.kind !== 'uploaded' || image.kind !== 'uploaded') throw new Error('upload failed');

        const readText = await call(harness.client, 'ui_file_read', { app: app.name, fileId: text.file.id });
        const readImage = await call(harness.client, 'ui_file_read', { app: app.name, fileId: image.file.id });
        const missing = await call(harness.client, 'ui_file_read', { app: app.name, fileId: '11111111-1111-4111-8111-111111111111' });

        expect(readText.body).toMatchObject({ file: { name: 'notes.txt', type: 'text/plain', size: 5 }, text: 'hello', truncated: false });
        expect(readImage.body).toMatchObject({ file: { type: 'image/png' }, text: null });
        expect(missing.body['error']).toBe('not-found');
    });
});

describe('tool-call log', () => {
    it('should log a failed call with its error code and a successful call as ok, with no argument text', async () => {
        // Arrange
        const file = join(data.dir, 'calls.jsonl');
        const logged = await inMemoryHarness(data.dir, noBrowser, file);
        const read = async (): Promise<Record<string, unknown>[]> =>
            (await readFile(file, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);

        try {
            // Act
            await call(logged.client, 'ui_component_get', { name: 'buton' });
            await call(logged.client, 'ui_component_get', { name: 'button' });
            await call(logged.client, 'ui_nothing', { app: 'a1' });

            // Assert
            await vi.waitFor(async () => expect(await read()).toHaveLength(3));
            const [failed, ok, unknown] = await read();
            expect(failed).toMatchObject({ tool: 'ui_component_get', ok: false, errorCode: 'unknown-component', requestChars: JSON.stringify({ name: 'buton' }).length });
            expect(ok).toMatchObject({ tool: 'ui_component_get', ok: true });
            expect(ok?.['errorCode']).toBeUndefined();
            expect(ok?.['responseChars']).toBeGreaterThan(100);
            expect(unknown).toMatchObject({ tool: 'ui_nothing', ok: false, errorCode: 'unknown-tool', target: 'a1' });
            expect(await readFile(file, 'utf8')).not.toContain('buton');
        } finally {
            await logged.close();
        }
    });

    it('should log the app as the target and count the errors and warnings of a validation', async () => {
        // Arrange
        const file = join(data.dir, 'calls.jsonl');
        const logged = await inMemoryHarness(data.dir, noBrowser, file);
        try {
            const created = await createApp(logged.client, 'logged');

            // Act
            const validated = await call(logged.client, 'ui_validate', { app: created.name });

            // Assert
            await vi.waitFor(async () => expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2));
            const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(lines[0]).toMatchObject({ tool: 'ui_app_create', ok: true });
            expect(lines[0]).not.toHaveProperty('target');
            expect(lines[1]).toMatchObject({ tool: 'ui_validate', target: created.name });
            expect(lines[1]?.['errorCount']).toBe((validated.body['errors'] as unknown[]).length);
            expect(lines[1]?.['warningCount']).toBe((validated.body['warnings'] as unknown[]).length);
        } finally {
            await logged.close();
        }
    });

    it('should write no file when no log is configured', async () => {
        // Act
        await call(harness.client, 'ui_component_get', { name: 'button' });

        // Assert
        await expect(readFile(join(data.dir, 'calls.jsonl'), 'utf8')).rejects.toThrow();
    });
});
