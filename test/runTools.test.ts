import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartKind } from '../src/domain/partName.js';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import type { PreviewBrowser } from '../src/infrastructure/preview/BrowserPreview.js';
import { call, inMemoryHarness, noBrowser, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const RUN_TIME_TOOLS = Object.freeze([
    'ui_state_get',
    'ui_state_set',
    'ui_state_reset',
    'ui_preview',
    'ui_screenshot',
    'ui_interact',
    'ui_command',
    'ui_events_read',
    'ui_call_answer',
    'ui_effect_answer',
    'ui_logic_trace',
    'ui_file_read'
]);

const PRODUCT = deepFreeze({ fields: { name: { type: 'string', required: true } } }) as unknown as UiPartBodies['models'];
const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp' } } }) as unknown as UiPartBodies['data'];

/** A shop with a search field on its home screen, a shared catalog and two screens */
const SHOP = deepFreeze({
    uses: { data: { products: { dataset: 'catalog' } } },
    start: 'home',
    app: { component: 'app' },
    screens: {
        home: { root: { component: 'panel', children: { search: { component: 'textField', _label: 'Search' }, welcome: { component: 'text', _text: 'Welcome home' } } } },
        about: { root: { component: 'text', _text: 'About the shop' } }
    }
}) as unknown as UiPartBodies['apps'];

const SEARCH = '$.screens.home.children.search.value';

let data: TempData;
let harness: InMemoryHarness;
let open: ReturnType<typeof vi.fn<PreviewBrowser['open']>>;

async function write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K]): Promise<void> {
    const result = await harness.services.useCases.writePart!.execute({ kind, name, body });
    if (result.kind !== 'written') throw new Error(`${kind} ${name}: ${JSON.stringify(result)}`);
}

async function partRevision(): Promise<unknown> {
    return (await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' })).body['revision'];
}

beforeEach(async () => {
    data = await tempData();
    open = vi.fn<PreviewBrowser['open']>(async () => ({ rendered: true }));
    const browser: PreviewBrowser = { ...noBrowser, open };
    harness = await inMemoryHarness(data.dir, browser);
    await write('models', 'product', PRODUCT);
    await write('data', 'catalog', CATALOG);
    await write('apps', 'shop', SHOP);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('the run-time tools', () => {
    it('should start every description with "Run time:"', async () => {
        // Act
        const { tools } = await harness.client.listTools();
        const described = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));

        // Assert
        for (const name of RUN_TIME_TOOLS) expect(described.get(name), name).toMatch(/^Run time: /);
    });

    it('should need an app, refuse other personas and name the nearest apps', async () => {
        // Act
        const neither = await call(harness.client, 'ui_state_get', {});
        const byId = await call(harness.client, 'ui_state_get', { appId: '00000000-0000-4000-8000-0000000000aa' });
        const persona = await call(harness.client, 'ui_events_read', { app: 'shop', persona: 'guest' });
        const missing = await call(harness.client, 'ui_events_read', { app: 'shp' });
        const events = await call(harness.client, 'ui_events_read', { app: 'shop', persona: 'default' });

        // Assert
        expect(neither.body).toMatchObject({ error: 'invalid-argument' });
        expect(byId.body).toMatchObject({ error: 'invalid-argument' });
        expect(persona.body).toMatchObject({ error: 'invalid-argument', argument: 'persona', personas: ['default'] });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['shop'] });
        expect(events.body).toEqual({ app: 'shop', events: [], cursor: 0 });
    });
});

describe('ui_state_set, ui_state_get and ui_state_reset on an instance', () => {
    it('should set a value in the instance and leave the part revision as it is', async () => {
        // Act
        const set = await call(harness.client, 'ui_state_set', { app: 'shop', path: SEARCH, value: 'lamp' });
        const read = await call(harness.client, 'ui_state_get', { app: 'shop', path: SEARCH });

        // Assert
        expect(set.body).toEqual({ app: 'shop', revision: 1, path: SEARCH });
        expect(read.body).toMatchObject({ app: 'shop', revision: 1, source: 'instance', path: SEARCH, value: 'lamp' });
        expect(await partRevision()).toBe(1);
    });

    it('should refuse a definition path and a shared dataset', async () => {
        // Act
        const theme = await call(harness.client, 'ui_state_set', { app: 'shop', path: '$.theme', value: {} });
        const shared = await call(harness.client, 'ui_state_set', { app: 'shop', path: '$.data.products.p1.name', value: 'Desk' });

        // Assert
        expect(theme.body).toMatchObject({ error: 'definition-path', app: 'shop' });
        expect(shared.body).toMatchObject({ error: 'shared-dataset', app: 'shop' });
        expect(shared.body['message']).toContain('ui_data_write');
    });

    it('should reset the instance to the definition', async () => {
        // Arrange
        await call(harness.client, 'ui_state_set', { app: 'shop', path: SEARCH, value: 'lamp' });

        // Act
        const stale = await call(harness.client, 'ui_state_reset', { app: 'shop', expectedRevision: 2 });
        const reset = await call(harness.client, 'ui_state_reset', { app: 'shop', expectedRevision: 1 });
        const read = await call(harness.client, 'ui_state_get', { app: 'shop' });

        // Assert
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(reset.body).toEqual({ app: 'shop', revision: 1 });
        expect(JSON.stringify(read.body['state'])).not.toContain('lamp');
        expect(await partRevision()).toBe(1);
    });
});

describe('ui_file_read on an instance', () => {
    it('should read a file uploaded to an app part by the app name', async () => {
        // Arrange
        const appId = (await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' })).body['id'] as string;
        async function* content(): AsyncIterable<Uint8Array> {
            yield new TextEncoder().encode('lamp, 30');
        }
        const uploaded = await harness.services.useCases.uploadFile.execute(appId, { name: 'prices.csv', content: content() });
        if (uploaded.kind !== 'uploaded') throw new Error(JSON.stringify(uploaded));

        // Act
        const read = await call(harness.client, 'ui_file_read', { app: 'shop', fileId: uploaded.file.id });
        const missing = await call(harness.client, 'ui_file_read', { app: 'shop', fileId: '00000000-0000-4000-8000-0000000000aa' });

        // Assert
        expect(read.body).toMatchObject({ file: { name: 'prices.csv' }, text: 'lamp, 30', truncated: false });
        expect(missing.body).toMatchObject({ error: 'not-found', app: 'shop' });
    });
});

describe('ui_preview and ui_command on an instance', () => {
    it('should open the part id at a screen, and refuse an unknown screen with the screen names', async () => {
        // Arrange
        const appId = (await call(harness.client, 'ui_get', { kind: 'apps', name: 'shop' })).body['id'];

        // Act
        const shown = await call(harness.client, 'ui_preview', { app: 'shop', screen: 'about', params: { from: 'test' } });
        const unknown = await call(harness.client, 'ui_preview', { app: 'shop', screen: 'abuot' });
        const loose = await call(harness.client, 'ui_preview', { app: 'shop', params: {} });

        // Assert
        expect(shown.body).toMatchObject({ app: 'shop', revision: 1, rendered: true, url: `http://127.0.0.1:4100/apps/${appId}` });
        expect(open).toHaveBeenCalledWith(appId, expect.any(Number), { screen: 'about', params: { from: 'test' } });
        expect(unknown.body).toMatchObject({ error: 'invalid-argument', argument: 'screen', screens: ['home', 'about'] });
        expect(loose.body).toMatchObject({ error: 'invalid-argument', argument: 'params' });
    });

    it('should check a navigate against the screens the instance runs', async () => {
        // Act
        const navigate = await call(harness.client, 'ui_command', { app: 'shop', target: 'about', command: 'navigate' });
        const unknown = await call(harness.client, 'ui_command', { app: 'shop', target: 'contact', command: 'navigate' });

        // Assert
        expect(navigate.body).toMatchObject({ app: 'shop', revision: 1, previewAttached: false, command: { command: 'navigate', target: 'about' } });
        expect(unknown.body).toMatchObject({ error: 'unknown-screen', app: 'shop', screens: ['home', 'about'] });
    });

    it('should answer that no logic runs for an instance without logic', async () => {
        // Act
        const trace = await call(harness.client, 'ui_logic_trace', { app: 'shop' });

        // Assert
        expect(trace.body).toMatchObject({ error: 'no-logic', app: 'shop' });
    });
});
