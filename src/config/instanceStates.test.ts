import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StoredNamespace } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { SetPartState } from '../application/use-cases/SetState.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import { DEFAULT_PERSONA } from '../domain/InstanceKey.js';
import type { JsonObject } from '../domain/JsonValue.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import { AuthorityInstanceStates } from '../infrastructure/sync/AuthorityInstanceStates.js';
import { InstanceNamespaceStorage, appNamespace } from '../infrastructure/sync/FileNamespaceStorage.js';
import type { InstanceStart } from '../infrastructure/sync/InstanceStart.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const { validator, library } = createStateUiAdapters();
const QUIET = Object.freeze({ info: (): void => undefined });

const PARTS = deepFreeze([
    ['models', 'product', { fields: { name: { type: 'string', required: true }, price: { type: 'number', default: 0 } } }],
    ['models', 'bag-line', { fields: { product: { type: 'string', required: true }, qty: { type: 'integer', required: true }, line: { type: 'number' } } }],
    ['models', 'cart-totals', { fields: { net: { type: 'number', default: 0 }, gross: { type: 'number', default: 0 }, currency: { type: 'string', default: 'USD' } } }],
    ['data', 'catalog', { model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair', price: 90 } } }],
    [
        'logic',
        'cart',
        {
            needs: { bag: { model: 'bag-line' }, totals: { model: 'cart-totals' } },
            params: { taxRate: { type: 'number', default: 0 }, currency: { type: 'string', default: 'USD' } },
            rules: {
                totals: {
                    when: { path: '$.data.bag' },
                    do: [
                        { command: 'set', target: '$.data.totals.net', value: "{{ sum($.data.bag, 'line') }}" },
                        { command: 'set', target: '$.data.totals.gross', value: "{{ round(sum($.data.bag, 'line') * (1 + $params.taxRate) * 100) / 100 }}" },
                        { command: 'set', target: '$.data.totals.currency', value: '$params.currency' }
                    ]
                }
            }
        }
    ]
] as const);

function store(taxRate: number): UiPartBodies['apps'] {
    return deepFreeze({
        uses: {
            data: { products: { dataset: 'catalog' }, bag: { model: 'bag-line', scope: 'persona' }, totals: { model: 'cart-totals', scope: 'persona' } },
            logic: { cart: { params: { taxRate, currency: 'EUR' } } }
        },
        start: 'home',
        app: { component: 'app', toasts: { component: 'toastRegion' } },
        screens: {
            home: { root: { component: 'form', children: { name: { component: 'textField', _label: 'Name' } } } },
            product: { params: { id: { type: 'string', required: true } }, root: { component: 'text', _text: 'Product' } }
        }
    }) as unknown as UiPartBodies['apps'];
}

const LINES = deepFreeze({ l1: { product: 'p1', qty: 2, line: 60 }, l2: { product: 'p2', qty: 1, line: 90 } }) as unknown as JsonObject;

let dir: string;
let folders: PartFolders;
let parts: IndexedUiPartRepository;
let instances: FileUiInstanceRepository;
let writePart: WritePart;
let appId: string;

interface Running {
    authorities: AppAuthorities;
    states: AuthorityInstanceStates;
    setState: SetPartState;
    report: ReturnType<typeof vi.fn>;
}

/** A server's instance side over the data folder: a restart is a new one over the same folder */
function server(): Running {
    const report = vi.fn();
    const authorities = new AppAuthorities(() => undefined, undefined, { library, report: QUIET });
    const states = new AuthorityInstanceStates(parts, instances, authorities, OWNER, report);
    return { authorities, states, setState: new SetPartState(parts, states, validator, QUIET), report };
}

async function app(): Promise<UiPart<'apps'>> {
    const part = await parts.findByName('apps', 'store');
    if (part === undefined) throw new Error('no store');
    return part;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-instance-states-'));
    folders = new PartFolders(dir);
    const lock = new KeyedLock();
    parts = new IndexedUiPartRepository(new FilePartRepository(folders, lock));
    instances = new FileUiInstanceRepository(folders, lock, OWNER);
    writePart = new WritePart(parts, parts, validator, QUIET);
    for (const [kind, name, body] of [...PARTS, ['apps', 'store', store(0.2)]] as const) {
        const written = await writePart.execute({ kind, name, body } as never);
        if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
    }
    appId = (await app()).id;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('running instances of owner apps', () => {
    it('should start from the assembled view: sparse nodes, the start route, the shared copy and the persona defaults', async () => {
        // Arrange
        const { states, authorities } = server();

        // Act
        const state = await states.state(await app());
        await authorities.close();

        // Assert: the cart module's rule derived the totals at start, so the currency is the app's EUR, not the default
        expect(state).toEqual({
            app: {},
            screens: {},
            route: { screen: 'home', params: {} },
            data: { products: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair', price: 90 } }, bag: {}, totals: { net: 0, gross: 0, currency: 'EUR' } }
        });
    });

    it('should run the cart module over the persona bag and keep the derived totals with the persona', async () => {
        // Arrange
        const { states, setState, authorities } = server();

        // Act
        const result = await setState.execute('store', { path: '$.data.bag', value: LINES });
        const state = await states.state(await app());
        await authorities.close();

        // Assert
        expect(result).toEqual({ kind: 'written', app: 'store', revision: 1, path: '$.data.bag', statePath: '$.data.bag' });
        expect(state['data']).toMatchObject({ totals: { net: 150, gross: 180, currency: 'EUR' } });
        expect((await instances.getData(appId, 'bag')).value).toEqual({ model: 'bag-line', records: LINES });
        expect((await instances.getData(appId, 'totals')).value).toEqual({ model: 'cart-totals', records: { net: 150, gross: 180, currency: 'EUR' } });
        expect(await instances.get(appId)).toEqual({ value: {} });
    });

    it('should keep the articulation of the app node and of a screen as the instance, and load it after a restart', async () => {
        // Arrange
        const first = server();

        // Act
        const toasts = await first.setState.execute('store', { path: '$.app.toasts.position', value: 'topEnd' });
        const name = await first.setState.execute('store', { path: '$.screens.home.children.name.value', value: 'Ann' });
        await first.authorities.close();
        const second = server();
        const state = await second.states.state(await app());
        await second.authorities.close();

        // Assert
        expect([toasts.kind, name.kind]).toEqual(['written', 'written']);
        const stored = { app: { toasts: { position: 'topEnd' } }, screens: { home: { children: { name: { value: 'Ann' } } } } };
        expect((await instances.get(appId)).value).toEqual(stored);
        expect(state).toMatchObject(stored);
    });

    it('should refuse paths of the definition and of a shared dataset, and name the tool for the dataset', async () => {
        // Arrange
        const { setState, authorities } = server();

        // Act
        const results = [
            await setState.execute('store', { path: '$.theme.tokens.color.brand', value: '#000000' }),
            await setState.execute('store', { path: '$.data.products.p1.price', value: 1 }),
            await setState.execute('store', { path: '$.screens.home.children.name._label', value: 'Your name' }),
            await setState.execute('store', { path: '$.logic', value: {} }),
            await setState.execute('store', { path: '$.data.nothing', value: 1 }),
            await setState.execute('store', { path: '$.route', value: { screen: 'product' } }),
            await setState.execute('store', { path: '$.screens.nowhere.title', value: 'x' })
        ];
        await authorities.close();

        // Assert
        expect(results.map((result) => (result.kind === 'refused' ? result.reason : result.kind))).toEqual([
            'definition-path',
            'shared-dataset',
            'definition-path',
            'definition-path',
            'unknown-path',
            'unknown-path',
            'unknown-path'
        ]);
        const shared = results[1];
        expect(shared?.kind === 'refused' && shared.message).toBe('$.data.products is a shared dataset, the same records in every app that binds it: change them with ui_data_write');
        const unknown = results[4];
        expect(unknown?.kind === 'refused' && unknown.message).toBe('The app binds no data named "nothing"; it binds: products, bag, totals');
        expect(await instances.get(appId)).toEqual({ value: {} });
    });

    it('should return a conflict for a stale revision and not-found for an app the owner does not have', async () => {
        // Arrange
        const { setState, authorities } = server();

        // Act
        const stale = await setState.execute('store', { path: '$.app.children.menu.open', value: true, expectedRevision: 7 });
        const missing = await setState.execute('nothing', { path: '$.app.children.menu.open', value: true });
        await authorities.close();

        // Assert
        expect(stale).toEqual({ kind: 'conflict', app: 'store', currentRevision: 1 });
        expect(missing).toEqual({ kind: 'not-found', app: 'nothing' });
    });

    it('should run the edited definition after an app write and keep what the persona did', async () => {
        // Arrange
        const { states, setState, authorities } = server();
        await setState.execute('store', { path: '$.app.toasts.position', value: 'topEnd' });

        // Act
        await writePart.execute({ kind: 'apps', name: 'store', body: store(0.05), expectedRevision: 1 });
        await setState.execute('store', { path: '$.data.bag', value: LINES });
        const state = await states.state(await app());
        await authorities.close();

        // Assert
        expect(state['data']).toMatchObject({ totals: { net: 150, gross: 157.5 } });
        expect(state['app']).toEqual({ toasts: { position: 'topEnd' } });
    });

    it('should start from the definition when the instance file is corrupt, and report it', async () => {
        // Arrange
        const path = folders.instanceFile(OWNER, appId);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{"app": ');
        const { states, authorities, report } = server();

        // Act
        const state = await states.state(await app());
        await authorities.close();

        // Assert
        expect(state['app']).toEqual({});
        expect(report).toHaveBeenCalledWith('Instance ignored', { app: appId, reason: `The instance of the app ${appId} was ignored: the file is not valid JSON` });
    });
});

describe('InstanceNamespaceStorage', () => {
    async function start(): Promise<InstanceStart> {
        const { states, authorities } = server();
        const shape = await states.shape(await app());
        await authorities.close();
        return {
            key: { persona: DEFAULT_PERSONA, ownerId: OWNER, appId },
            document: shape.document,
            bindings: { products: { scope: 'shared' }, bag: { scope: 'persona', model: 'bag-line' }, totals: { scope: 'persona', model: 'cart-totals' } }
        };
    }

    it('should save the route whole, unbound data and persona records, and nothing of a shared dataset or $.server', async () => {
        // Arrange
        const begun = await start();
        const storage = new InstanceNamespaceStorage(begun, instances, () => undefined, () => 5000);
        const state = {
            app: {},
            screens: {},
            route: { screen: 'product', params: { id: 'p1' } },
            data: { products: { p1: { name: 'Changed' } }, bag: LINES, totals: { net: 0, gross: 0, currency: 'USD' }, note: 'mine' },
            server: { token: 'secret' }
        } as unknown as StoredNamespace['state'];

        await storage.load(appNamespace(begun.key));

        // Act
        await storage.save(appNamespace(begun.key), { state, revision: 9, log: [], applied: [] });
        const loaded = await new InstanceNamespaceStorage(begun, instances, () => undefined, () => 6000).load(appNamespace(begun.key));

        // Assert
        expect((await instances.get(appId)).value).toEqual({ route: { screen: 'product', params: { id: 'p1' } }, data: { note: 'mine' } });
        expect((await instances.getData(appId, 'bag')).value?.records).toEqual(LINES);
        expect((await instances.getData(appId, 'totals')).value).toBeUndefined();
        expect(loaded.revision).toBe(6000);
        expect(loaded.state['route']).toEqual({ screen: 'product', params: { id: 'p1' } });
        expect(loaded.state['data']).toMatchObject({ products: { p1: { name: 'Lamp', price: 30 } }, bag: LINES, note: 'mine' });
        expect(JSON.stringify(await readFile(folders.instanceFile(OWNER, appId), 'utf8'))).not.toContain('secret');
    });

    it('should drop a stored route to a screen the app no longer has and report it', async () => {
        // Arrange
        const begun = await start();
        await instances.write(appId, {}, { route: { screen: 'gone', params: {} } });
        const report = vi.fn();

        // Act
        const loaded = await new InstanceNamespaceStorage(begun, instances, report).load(appNamespace(begun.key));

        // Assert
        expect(loaded.state['route']).toEqual({ screen: 'home', params: {} });
        expect(report).toHaveBeenCalledWith('Instance value dropped', { app: appId, path: '$.route', code: 'SUI-INSTANCE-STALE' });
    });

    describe('with a theme switch control', () => {
        const SWITCHED = deepFreeze({
            key: { persona: DEFAULT_PERSONA, ownerId: OWNER, appId: '' },
            document: {
                appThemes: { calm: { tokens: {} }, bold: { tokens: {} } },
                app: {
                    component: 'stack',
                    children: {
                        pick: { component: 'segmented', value: 'calm', on: { change: { command: 'set', target: '$.theme.active.theme', from: '.value' } } }
                    }
                }
            },
            bindings: {}
        });

        async function loadWith(stored: JsonObject): Promise<StoredNamespace['state']> {
            const begun = { ...SWITCHED, key: { ...SWITCHED.key, appId } } as unknown as InstanceStart;
            await instances.write(appId, {}, stored);
            return (await new InstanceNamespaceStorage(begun, instances, () => undefined).load(appNamespace(begun.key))).state;
        }

        it('should take the theme from the switch control of an instance saved before the theme choice was kept', async () => {
            // Act
            const state = await loadWith({ app: { children: { pick: { value: 'bold' } } } });

            // Assert
            expect(state['theme']).toEqual({ active: { theme: 'bold' } });
            expect(state['app']).toEqual({ children: { pick: { value: 'bold' } } });
        });

        it('should set the switch control to the kept theme when they disagree', async () => {
            // Act
            const state = await loadWith({ app: { children: { pick: { value: 'calm' } } }, theme: { active: { theme: 'bold' } } });

            // Assert
            expect(state['theme']).toEqual({ active: { theme: 'bold' } });
            expect(state['app']).toEqual({ children: { pick: { value: 'bold' } } });
        });

        it('should give the switch control back its starting value when the kept theme is the starting one', async () => {
            // Act
            const state = await loadWith({ app: { children: { pick: { value: 'bold', open: true } } }, theme: { active: { theme: 'calm' } } });

            // Assert
            expect(state['theme']).toEqual({ active: { theme: 'calm' } });
            expect(state['app']).toEqual({ children: { pick: { open: true } } });
        });

        it('should drop a stale theme in the switch control and show the starting one', async () => {
            // Act
            const state = await loadWith({ app: { children: { pick: { value: 'gone' } } } });

            // Assert
            expect(state['theme']).toBeUndefined();
            expect(state['app']).toEqual({ children: { pick: {} } });
        });

        it('should store nothing for a switch control nobody touched', async () => {
            // Act
            const state = await loadWith({});

            // Assert
            expect(state['theme']).toBeUndefined();
            expect(state['app']).toEqual({});
        });
    });

    it('should refuse a namespace that is not its own', async () => {
        // Arrange
        const storage = new InstanceNamespaceStorage(await start(), instances, () => undefined);

        // Act / Assert
        await expect(storage.load('apps.00000000-0000-4000-8000-000000000001')).rejects.toThrow('is not the namespace of this instance');
    });
});
