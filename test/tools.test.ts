import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBrowser } from '../src/infrastructure/preview/BrowserPreview.js';
import { BrowserUnavailableError } from '../src/infrastructure/preview/BrowserPreview.js';
import type { ViewMessage } from '../src/infrastructure/preview/PreviewHub.js';
import { FORM_DOCUMENT, call, inMemoryHarness, noBrowser, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let data: TempData;
let harness: InMemoryHarness;
let browser: { [K in keyof PreviewBrowser]: ReturnType<typeof vi.fn> };

function createBrowser(): typeof browser {
    return {
        open: vi.fn(async () => ({ rendered: true })),
        screenshot: vi.fn(async () => ({ png: PNG, width: 1280, height: 800, target: 'page' })),
        interact: vi.fn(async () => ({ results: [{ index: 0, action: 'click', path: '$.app', ok: true }], errors: [], events: [], cursor: 0 })),
        closePage: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined)
    };
}

async function createForm(name = 'form'): Promise<string> {
    const created = await call(harness.client, 'ui_app_create', { name, document: FORM_DOCUMENT });
    return created.body['appId'] as string;
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

/** A sync connection to the app's authority, as a view's socket makes one: it says hello and records what comes back */
async function syncView(appId: string): Promise<{ readonly received: Record<string, unknown>[]; send(message: object): void }> {
    const authority = await harness.services.authorities.authority(appId, FORM_DOCUMENT);
    const received: Record<string, unknown>[] = [];
    const session = authority.connect({ send: (text) => received.push(JSON.parse(text) as Record<string, unknown>), close: () => undefined });
    const send = (message: object): void => session.receive(JSON.stringify(message));
    send({ type: 'hello', namespace: `apps.${appId}`, revision: 0, clientId: 'view-1', protocol: 1 });
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

describe('tool list', () => {
    it('should list the sixteen ui-builder tools and the four new ones', async () => {
        const { tools } = await harness.client.listTools();

        expect(tools.map((tool) => tool.name).sort()).toEqual(
            [
                'ui_components_list',
                'ui_component_get',
                'ui_icons_list',
                'ui_tokens_list',
                'ui_app_create',
                'ui_app_list',
                'ui_app_get',
                'ui_validate',
                'ui_outline',
                'ui_state_get',
                'ui_app_write',
                'ui_state_set',
                'ui_preview',
                'ui_command',
                'ui_file_read',
                'ui_app_delete',
                'ui_screenshot',
                'ui_interact',
                'ui_events_read',
                'ui_call_answer'
            ].sort()
        );
    });

    it('should mark the read tools read-only and only the delete tool destructive', async () => {
        const { tools } = await harness.client.listTools();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));

        const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
        const destructive = tools.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name);

        expect(readOnly.sort()).toEqual(
            ['ui_components_list', 'ui_component_get', 'ui_icons_list', 'ui_tokens_list', 'ui_app_list', 'ui_app_get', 'ui_validate', 'ui_outline', 'ui_state_get', 'ui_file_read', 'ui_events_read'].sort()
        );
        expect(destructive).toEqual(['ui_app_delete']);
        expect(byName.get('ui_app_create')?.annotations?.readOnlyHint).toBe(false);
    });

    it('should carry the working loop in the server instructions and the first tool descriptions', async () => {
        const instructions = harness.client.getInstructions() ?? '';
        const { tools } = await harness.client.listTools();

        expect(instructions).toContain('Write loop');
        expect(instructions).toContain('Icon names come from ui_icons_list');
        expect(instructions).toContain('no preview is open; the command was not delivered');
        expect(instructions).toContain('ui_events_read');
        expect(tools.find((tool) => tool.name === 'ui_app_create')?.description).toContain('Start of the working loop');
        expect(tools.find((tool) => tool.name === 'ui_components_list')?.description).toContain('Start of the working loop');
    });
});

describe('catalog tools', () => {
    it('should list components filtered by query and tier', async () => {
        const result = await call(harness.client, 'ui_components_list', { query: 'button' });

        expect(result.isError).toBe(false);
        expect((result.body['components'] as { name: string }[]).map((component) => component.name)).toContain('button');
        expect(result.body['count']).toBe((result.body['components'] as unknown[]).length);
    });

    it('should return the full entry of a component', async () => {
        const result = await call(harness.client, 'ui_component_get', { name: 'button' });

        expect(result.isError).toBe(false);
        expect(result.body['name']).toBe('button');
        expect(result.body['events']).toContain('press');
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

describe('app tools', () => {
    it('should create an app, list it and read it', async () => {
        const appId = await createForm();

        const list = await call(harness.client, 'ui_app_list');
        const get = await call(harness.client, 'ui_app_get', { appId, path: 'app.children.form.children.save' });

        expect(list.body['count']).toBe(1);
        expect((list.body['apps'] as { name: string; ownerId?: unknown }[])[0]).toMatchObject({ name: 'form', revision: 1 });
        expect((list.body['apps'] as Record<string, unknown>[])[0]).not.toHaveProperty('ownerId');
        expect(get.body['revision']).toBe(1);
        expect(get.body['value']).toMatchObject({ component: 'button', _title: 'Save' });
    });

    it('should refuse an invalid document with the state path, a blank name and a duplicate name', async () => {
        await createForm();

        const invalid = await call(harness.client, 'ui_app_create', { name: 'bad', document: { app: { component: 'nope' } } });
        const blank = await call(harness.client, 'ui_app_create', { name: '  ' });
        const duplicate = await call(harness.client, 'ui_app_create', { name: 'form' });

        expect(invalid.body['error']).toBe('invalid-document');
        expect(JSON.stringify(invalid.body['errors'])).toContain('$.app');
        expect(blank.body['error']).toBe('invalid-argument');
        expect(duplicate.body['error']).toBe('duplicate-name');
    });

    it('should report where a path stops existing', async () => {
        const appId = await createForm();

        const missing = await call(harness.client, 'ui_app_get', { appId, path: 'app.children.form.children.nope.children.x' });

        expect(missing.body['error']).toBe('missing-path');
        expect(missing.body['missingAt']).toBe('app.children.form.children.nope');
    });

    it('should validate and outline the stored app', async () => {
        const appId = await createForm();

        const validated = await call(harness.client, 'ui_validate', { appId });
        const outline = await call(harness.client, 'ui_outline', { appId });

        expect(validated.body['valid']).toBe(true);
        expect((validated.body['preview'] as { attached: boolean }).attached).toBe(false);
        expect(String(outline.body['text'])).toContain('textField email');
        expect(String(outline.body['text'])).toContain('button save "Save"');
    });

    it('should answer an unknown app with not-found and a non-UUID id with invalid-argument', async () => {
        const unknown = await call(harness.client, 'ui_validate', { appId: '11111111-1111-4111-8111-111111111111' });
        const malformed = await call(harness.client, 'ui_validate', { appId: '../etc' });
        const extra = await call(harness.client, 'ui_app_list', { workspaceId: 'w' });

        expect(unknown.body['error']).toBe('not-found');
        expect(malformed.body['error']).toBe('invalid-argument');
        expect(extra.body['error']).toBe('invalid-argument');
    });
});

describe('write tools', () => {
    it('should write, raise the revision and keep the key order', async () => {
        const appId = await createForm();

        const written = await call(harness.client, 'ui_app_write', {
            appId,
            operations: [{ op: 'set', path: 'app.children.footer', value: { component: 'toolbar' } }],
            expectedRevision: 1
        });
        const get = await call(harness.client, 'ui_app_get', { appId, path: 'app.children' });

        expect(written.body).toMatchObject({ appId, revision: 2, warnings: [] });
        expect(Object.keys(get.body['value'] as object)).toEqual(['form', 'footer']);
    });

    it('should return a conflict with the current revision for a stale write', async () => {
        const appId = await createForm();
        await call(harness.client, 'ui_app_write', { appId, operations: [{ op: 'set', path: 'app._title', value: 'A' }], expectedRevision: 1 });

        const stale = await call(harness.client, 'ui_app_write', { appId, operations: [{ op: 'set', path: 'app._title', value: 'B' }], expectedRevision: 1 });

        expect(stale.body['error']).toBe('conflict');
        expect(stale.body['currentRevision']).toBe(2);
    });

    it('should reject an operation through a missing parent with its index, and a result with blocking errors in full', async () => {
        const appId = await createForm();

        const operation = await call(harness.client, 'ui_app_write', { appId, operations: [{ op: 'set', path: 'composed.x', value: {} }] });
        const document = await call(harness.client, 'ui_app_write', { appId, operations: [{ op: 'set', path: 'app.children.form.component', value: 'nope' }] });
        const stored = await call(harness.client, 'ui_app_get', { appId, path: 'app.children.form.component' });

        expect(operation.body['error']).toBe('invalid-operation');
        expect(operation.body['index']).toBe(0);
        expect(document.body['error']).toBe('invalid-document');
        expect(JSON.stringify(document.body['errors'])).toContain('SUI-NODE-UNKNOWN');
        expect(stored.body['value']).toBe('panel');
    });

    it('should move a keyed entry with its key', async () => {
        const appId = await createForm();

        const moved = await call(harness.client, 'ui_app_write', {
            appId,
            operations: [{ op: 'move', path: 'app.children.form.children.save', before: 'email' }]
        });
        const get = await call(harness.client, 'ui_app_get', { appId, path: 'app.children.form.children' });

        expect(moved.isError).toBe(false);
        expect(Object.keys(get.body['value'] as object)).toEqual(['save', 'email']);
    });

    it('should set a data path in the state without raising the revision and refuse $.runtime and a stale revision', async () => {
        const appId = await createForm();

        const set = await call(harness.client, 'ui_state_set', { appId, path: '$.data.name', value: 'Ada' });
        const runtime = await call(harness.client, 'ui_state_set', { appId, path: '$.runtime.x', value: 1 });
        const stale = await call(harness.client, 'ui_state_set', { appId, path: '$.data.name', value: 'B', expectedRevision: 2 });
        const state = await call(harness.client, 'ui_state_get', { appId });

        expect(set.body).toMatchObject({ revision: 1, path: '$.data.name' });
        expect(runtime.body['error']).toBe('runtime-path');
        expect(stale.body['error']).toBe('conflict');
        expect(state.body['state']).toEqual({ data: { name: 'Ada' }, app: {} });
    });

    it('should refuse a value a guard rule of the logic refuses, and run the other rules', async () => {
        // Arrange
        const document = {
            data: { tasks: {}, stats: { tasks: 0 } },
            app: { component: 'page' },
            logic: {
                rules: {
                    count: { when: { path: '$.data.tasks' }, do: [{ command: 'set', target: '$.data.stats.tasks', value: '{{ size($.data.tasks) }}' }] },
                    titled: { when: { path: '$.data.tasks.{id}', if: "$trigger.title == ''" }, do: [{ command: 'reject', reason: 'A task needs a title' }] }
                }
            }
        };
        const created = await call(harness.client, 'ui_app_create', { name: 'Guarded tasks', document });
        const appId = created.body['appId'] as string;

        // Act
        const accepted = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t1', value: { title: 'first' } });
        const refused = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t2', value: { title: '' } });
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(accepted.isError).toBe(false);
        expect(refused.body).toMatchObject({ error: 'logic-guard', message: `A guard rule of the app's logic refused the value: A task needs a title` });
        expect((state.body['state'] as { data: unknown }).data).toEqual({ tasks: { t1: { title: 'first' } }, stats: { tasks: 1 } });
    });

    it('should queue a logic call for the agent and give the machine the answer from ui_call_answer', async () => {
        // Arrange
        const document = {
            data: { phase: 'idle' },
            app: { component: 'page' },
            logic: {
                machines: {
                    lookup: {
                        state: '$.data.phase',
                        initial: 'idle',
                        transitions: [
                            { from: 'idle', when: { path: '$.data.query' }, do: [{ command: 'call', target: 'findCompany', value: { name: '$trigger' }, as: 'found' }], to: 'waiting' },
                            { from: 'waiting', when: { result: 'found', is: 'accepted' }, do: [{ command: 'set', target: '$.data.company', value: '$result.value' }], to: 'idle' }
                        ]
                    }
                }
            }
        };
        const created = await call(harness.client, 'ui_app_create', { name: 'Company lookup', document });
        const appId = created.body['appId'] as string;
        await call(harness.client, 'ui_state_set', { appId, path: '$.data.query', value: 'Acme' });

        // Act
        const read = await call(harness.client, 'ui_events_read', { appId });
        const event = (read.body['events'] as { name: string; payload: { id: string; name: string; payload: unknown } }[]).find((item) => item.name === 'logic.call');
        const answered = await call(harness.client, 'ui_call_answer', { appId, id: event?.payload.id, status: 'accepted', value: { id: 'k1', name: 'Acme BV' } });
        const again = await call(harness.client, 'ui_call_answer', { appId, id: event?.payload.id, status: 'accepted' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(event?.payload).toMatchObject({ name: 'findCompany', payload: { name: 'Acme' } });
        expect(answered.body).toEqual({ appId, id: event?.payload.id, answered: true });
        expect(again.body['error']).toBe('not-waiting');
        expect((state.body['state'] as { data: unknown }).data).toMatchObject({ phase: 'idle', company: { id: 'k1', name: 'Acme BV' } });
    });

    it('should remove a record under $.data with remove and refuse a missing entry, $.data itself and value with remove', async () => {
        // Arrange
        const appId = await createForm();
        await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks', value: { t1: { title: 'first' }, t2: { title: 'second' } } });

        // Act
        const removed = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t1', remove: true });
        const missing = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t9', remove: true });
        const root = await call(harness.client, 'ui_state_set', { appId, path: '$.data', remove: true });
        const both = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t2', remove: true, value: 1 });
        const neither = await call(harness.client, 'ui_state_set', { appId, path: '$.data.tasks.t2' });
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(removed.isError).toBe(false);
        expect(removed.body).toMatchObject({ revision: 1, path: '$.data.tasks.t1' });
        expect(missing.body['error']).toBe('unknown-path');
        expect(root.body['error']).toBe('unknown-path');
        expect(both.body['error']).toBe('invalid-argument');
        expect(neither.body['error']).toBe('invalid-argument');
        expect((state.body['state'] as { data: unknown }).data).toEqual({ tasks: { t2: { title: 'second' } } });
    });

    it('should push a document write to the open views and a state write to the synced views', async () => {
        // Arrange
        const appId = await createForm();
        const received = openView(appId);
        const synced = await syncView(appId);

        // Act
        await call(harness.client, 'ui_app_write', { appId, operations: [{ op: 'set', path: 'app._title', value: 'Hi' }] });
        await call(harness.client, 'ui_state_set', { appId, path: '$.app.children.form.children.email.value', value: 'a@b.c' });

        // Assert
        const apps = received.filter((message) => message.type === 'app');
        expect(apps.map((message) => (message.type === 'app' ? [message.reason, message.revision] : []))).toEqual([['document', 2]]);
        expect(synced.received.at(-1)).toMatchObject({
            type: 'changes',
            changes: [{ path: '$.app.children.form.children.email.value', op: 'set', value: 'a@b.c', revision: 1 }]
        });
    });
});

describe('live tools', () => {
    it('should read the state a view changed over its sync connection, below a parent the state did not have', async () => {
        // Arrange
        const appId = await createForm();
        openView(appId);
        const synced = await syncView(appId);

        // Act
        synced.send({ type: 'change', change: { id: 'c1', path: '$.app.children.form.children.email.value', op: 'set', value: 'typed', base: 0 } });
        const state = await call(harness.client, 'ui_state_get', { appId });

        // Assert
        expect(synced.received.at(-1)).toEqual({ type: 'ack', id: 'c1', result: 'applied', revision: 1 });
        expect(state.body['state']).toEqual({ data: {}, app: { children: { form: { children: { email: { value: 'typed' } } } } } });
        expect((state.body['preview'] as { attached: boolean }).attached).toBe(true);
    });

    it('should queue the emits of a synced view for ui_events_read', async () => {
        const appId = await createForm();
        openView(appId);
        const synced = await syncView(appId);

        synced.send({ type: 'emit', name: 'form.saved', value: 'ok' });
        const events = await call(harness.client, 'ui_events_read', { appId });

        expect((events.body['events'] as { name: string; payload: unknown }[]).map((event) => [event.name, event.payload])).toEqual([['form.saved', 'ok']]);
    });

    it('should open the headless page and return the url a person can open', async () => {
        const appId = await createForm();

        const preview = await call(harness.client, 'ui_preview', { appId });

        expect(browser['open']).toHaveBeenCalledWith(appId, 1);
        expect(preview.body).toMatchObject({ appId, revision: 1, url: `http://127.0.0.1:4100/apps/${appId}`, rendered: true, errors: [] });
    });

    it('should still return the url, with a note, when Chromium is not installed', async () => {
        const appId = await createForm();
        browser['open']?.mockRejectedValueOnce(new BrowserUnavailableError('missing'));

        const preview = await call(harness.client, 'ui_preview', { appId });

        expect(preview.isError).toBe(false);
        expect(preview.body['rendered']).toBe(false);
        expect(String(preview.body['note'])).toContain('npx playwright install chromium');
    });

    it('should include the runtime errors the views reported in the preview result', async () => {
        const appId = await createForm();
        await harness.services.useCases.recordPreviewErrors.execute(appId, [{ code: 'SUI-RUN-BINDING', message: 'boom' }]);

        const preview = await call(harness.client, 'ui_preview', { appId });

        expect(preview.body['errors']).toEqual([{ code: 'SUI-RUN-BINDING', message: 'boom' }]);
    });

    it('should return the screenshot as an MCP image next to a short summary', async () => {
        const appId = await createForm();

        const shot = await call(harness.client, 'ui_screenshot', { appId, path: '$.app.children.form', width: 800, height: 600, mode: 'dark' });

        expect(browser['screenshot']).toHaveBeenCalledWith(appId, 1, { path: '$.app.children.form', width: 800, height: 600, mode: 'dark' });
        expect(shot.images).toEqual([{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
        expect(shot.body).toMatchObject({ appId, revision: 1, target: 'page', mode: 'dark' });
    });

    it('should say how to install Chromium when a screenshot cannot be taken', async () => {
        const appId = await createForm();
        browser['screenshot']?.mockRejectedValueOnce(new BrowserUnavailableError('missing'));

        const shot = await call(harness.client, 'ui_screenshot', { appId });

        expect(shot.isError).toBe(true);
        expect(shot.body['error']).toBe('browser-unavailable');
    });

    it('should run the actions and return the results, errors and emits', async () => {
        const appId = await createForm();
        browser['interact']?.mockResolvedValueOnce({
            results: [{ index: 0, action: 'click', path: '$.app.children.form.children.save', ok: true }],
            errors: [],
            events: [{ cursor: 1, name: 'form.saved', payload: 'ok', at: 'now', view: 'headless' }],
            cursor: 1
        });

        const result = await call(harness.client, 'ui_interact', { appId, actions: [{ action: 'click', path: '$.app.children.form.children.save' }] });

        expect(browser['interact']).toHaveBeenCalledWith(appId, 1, [{ action: 'click', path: '$.app.children.form.children.save' }]);
        expect(result.isError).toBe(false);
        expect(result.body['emits']).toEqual([{ cursor: 1, name: 'form.saved', payload: 'ok', at: 'now', view: 'headless' }]);
    });

    it('should mark the call as an error when an action failed and keep the results', async () => {
        const appId = await createForm();
        browser['interact']?.mockResolvedValueOnce({
            results: [{ index: 0, action: 'click', path: '$.app.x', ok: false, error: 'Nothing is rendered' }],
            errors: [],
            events: [],
            cursor: 0
        });

        const result = await call(harness.client, 'ui_interact', { appId, actions: [{ action: 'click', path: '$.app.x' }] });

        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('action-failed');
        expect((result.body['results'] as { ok: boolean }[])[0]?.ok).toBe(false);
    });

    it('should refuse an action that is not click, fill, press, hover or select', async () => {
        const appId = await createForm();

        const result = await call(harness.client, 'ui_interact', { appId, actions: [{ action: 'drag', path: '$.app' }] });

        expect(result.body['error']).toBe('invalid-argument');
        expect(browser['interact']).not.toHaveBeenCalled();
    });

    it('should read the queued emit events after a cursor', async () => {
        const appId = await createForm();
        openView(appId);
        harness.services.hub.recordEvent(appId, 'browser-view', 'one', { n: 1 });
        const first = await call(harness.client, 'ui_events_read', { appId });
        harness.services.hub.recordEvent(appId, 'browser-view', 'two', undefined);

        const next = await call(harness.client, 'ui_events_read', { appId, since: first.body['cursor'] });

        expect((first.body['events'] as { name: string }[]).map((event) => event.name)).toEqual(['one']);
        expect((next.body['events'] as { name: string }[]).map((event) => event.name)).toEqual(['two']);
        expect(next.body['cursor']).toBe(2);
    });

    it('should keep at most 500 events per app', async () => {
        const appId = await createForm();
        for (let n = 0; n < 510; n++) harness.services.hub.recordEvent(appId, 'v', `e${n}`, n);

        const result = await call(harness.client, 'ui_events_read', { appId });

        const events = result.body['events'] as { name: string }[];
        expect(events).toHaveLength(500);
        expect(events[0]?.name).toBe('e10');
    });

    it('should say no preview is open when a command has no view to go to', async () => {
        const appId = await call(harness.client, 'ui_app_create', {
            name: 'toasts',
            document: { app: { component: 'page', children: { toasts: { component: 'toastRegion', messages: { saved: { _text: 'Saved' } } } } } }
        }).then((created) => created.body['appId'] as string);

        const result = await call(harness.client, 'ui_command', { appId, target: 'app.children.toasts', command: 'show', value: 'saved' });

        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ previewAttached: false, message: 'no preview is open; the command was not delivered' });
    });

    it('should deliver a command to every open view, the headless page included', async () => {
        const appId = await call(harness.client, 'ui_app_create', {
            name: 'toasts',
            document: { app: { component: 'page', children: { toasts: { component: 'toastRegion', messages: { saved: { _text: 'Saved' } } } } } }
        }).then((created) => created.body['appId'] as string);
        const person = openView(appId, 'browser');
        const headless = openView(appId, 'headless');

        const result = await call(harness.client, 'ui_command', { appId, target: 'app.children.toasts', command: 'show', value: 'saved' });

        expect(result.body).toMatchObject({ previewAttached: true, message: 'delivered to 2 open views' });
        for (const received of [person, headless]) {
            expect(received.filter((message) => message.type === 'command')).toMatchObject([{ target: 'app.children.toasts', command: 'show', value: 'saved' }]);
        }
    });

    it('should refuse an undeclared command with the declared ones', async () => {
        const appId = await createForm();

        const result = await call(harness.client, 'ui_command', { appId, target: 'app.children.form.children.save', command: 'explode' });

        expect(result.body['error']).toBe('unknown-command');
        expect(result.body['declared']).toEqual(['focus']);
    });
});

describe('file and delete tools', () => {
    async function* bytes(text: string): AsyncIterable<Uint8Array> {
        yield Buffer.from(text);
    }

    it('should read an uploaded text file and return null text for an image', async () => {
        const appId = await createForm();
        const text = await harness.services.useCases.uploadFile.execute(appId, { name: 'notes.txt', content: bytes('hello') });
        const image = await harness.services.useCases.uploadFile.execute(appId, {
            name: 'pic.png',
            content: (async function* () {
                yield Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
            })()
        });
        if (text.kind !== 'uploaded' || image.kind !== 'uploaded') throw new Error('upload failed');

        const readText = await call(harness.client, 'ui_file_read', { appId, fileId: text.file.id });
        const readImage = await call(harness.client, 'ui_file_read', { appId, fileId: image.file.id });
        const missing = await call(harness.client, 'ui_file_read', { appId, fileId: '11111111-1111-4111-8111-111111111111' });

        expect(readText.body).toMatchObject({ file: { name: 'notes.txt', type: 'text/plain', size: 5 }, text: 'hello', truncated: false });
        expect(readImage.body).toMatchObject({ file: { type: 'image/png' }, text: null });
        expect(missing.body['error']).toBe('not-found');
    });

    it('should delete only at the expected revision, close the views and forget the app', async () => {
        const appId = await createForm();
        const received = openView(appId);

        const stale = await call(harness.client, 'ui_app_delete', { appId, expectedRevision: 9 });
        const deleted = await call(harness.client, 'ui_app_delete', { appId, expectedRevision: 1 });
        const again = await call(harness.client, 'ui_app_delete', { appId, expectedRevision: 1 });

        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(deleted.body).toEqual({ appId, revision: 1 });
        expect(again.body['error']).toBe('not-found');
        expect(received.some((message) => message.type === 'deleted')).toBe(true);
        expect(browser['closePage']).toHaveBeenCalledWith(appId);
        expect((await call(harness.client, 'ui_app_list')).body['count']).toBe(0);
    });

    it('should require expectedRevision for a delete', async () => {
        const appId = await createForm();

        const result = await call(harness.client, 'ui_app_delete', { appId });

        expect(result.body['error']).toBe('invalid-argument');
    });
});

describe('unknown tool', () => {
    it('should answer an unknown tool name with a typed error', async () => {
        const result = await call(harness.client, 'ui_nothing');

        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('unknown-tool');
        expect(noBrowser).toBeDefined();
    });
});
