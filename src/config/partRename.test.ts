import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { RenamePart } from '../application/use-cases/RenamePart.js';
import type { PartKind } from '../domain/partName.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import type { FilePartRepositoryOptions } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const REPORT = Object.freeze({ info: (): void => undefined });
const OWNER = '00000000-0000-4000-8000-0000000000aa';

/** A model `product` named by a dataset, a logic module and two apps: five files for a rename of the model */
const STORED = deepFreeze([
    ['models', 'product', { fields: { name: { type: 'string' } } }],
    ['models', 'order', { fields: { total: { type: 'number' } } }],
    ['themes', 'store', { tokens: { color: { accent: { base: '#204080' } } } }],
    ['data', 'stock', { model: 'product', records: { p1: { name: 'Lamp' } } }],
    ['logic', 'cart', { needs: { lines: { model: 'product' }, orders: { model: 'order' } } }],
    ['components', 'hero', { tree: { component: 'text', _text: 'Welcome' }, exposes: [] }],
    [
        'apps',
        'shop',
        {
            uses: { themes: ['store'], data: { stock: { dataset: 'stock' }, wishes: { model: 'product' } }, logic: { cart: {} } },
            start: 'home',
            shell: { component: 'page', children: { main: { component: 'outlet' } } },
            screens: {
                home: { root: { component: 'hero', on: { click: [{ command: 'navigate', target: 'about' }] } } },
                about: { root: { component: 'text', _text: 'About' } }
            }
        }
    ],
    ['apps', 'kiosk', { uses: { themes: ['store'], data: { picks: { model: 'product' } } }, shell: { component: 'hero' } }]
] as const);

let dir: string;
let folders: PartFolders;

function repository(options: FilePartRepositoryOptions = {}): { files: FilePartRepository; parts: IndexedUiPartRepository; rename: RenamePart } {
    const files = new FilePartRepository(folders, new KeyedLock(), options);
    const parts = new IndexedUiPartRepository(files);
    return { files, parts, rename: new RenamePart(parts, parts, REPORT) };
}

/** Every file under the data directory with its content and modification time, by path */
async function snapshot(): Promise<Record<string, { text: string; modified: number }>> {
    const files: Record<string, { text: string; modified: number }> = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files[relative(dir, path).split('\\').join('/')] = { text: await readFile(path, 'utf8'), modified: (await stat(path)).mtimeMs };
    }
    return files;
}

async function body(parts: IndexedUiPartRepository, kind: PartKind, name: string): Promise<unknown> {
    return (await parts.findByName(kind, name))?.body;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-rename-'));
    folders = new PartFolders(dir);
    const { parts } = repository();
    for (const [kind, name, partBody] of STORED) {
        const created = await parts.create({ kind, name, body: partBody as unknown as UiPartBodies[typeof kind] } as never);
        if (created.kind !== 'created') throw new Error(`${name}: ${JSON.stringify(created)}`);
    }
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('RenamePart over part files', () => {
    it('should rename a model across five files, keep its id and raise every revision', async () => {
        // Arrange
        const { parts, rename } = repository();
        const id = (await parts.findByName('models', 'product'))?.id;

        // Act
        const result = await rename.execute({ kind: 'models', name: 'product', to: 'item' });

        // Assert
        expect(result).toEqual({
            kind: 'renamed',
            revision: 2,
            rewritten: [
                { kind: 'apps', name: 'kiosk', revision: 2 },
                { kind: 'apps', name: 'shop', revision: 2 },
                { kind: 'logic', name: 'cart', revision: 2 },
                { kind: 'data', name: 'stock', revision: 2 }
            ]
        });
        expect((await parts.findByName('models', 'item'))?.id).toBe(id);
        expect(await body(parts, 'data', 'stock')).toEqual({ model: 'item', records: { p1: { name: 'Lamp' } } });
        expect(await body(parts, 'logic', 'cart')).toEqual({ needs: { lines: { model: 'item' }, orders: { model: 'order' } } });
        expect((await body(parts, 'apps', 'shop')) as { uses: unknown }).toMatchObject({ uses: { data: { stock: { dataset: 'stock' }, wishes: { model: 'item' } } } });
        expect((await body(parts, 'apps', 'kiosk')) as { uses: unknown }).toMatchObject({ uses: { data: { picks: { model: 'item' } } } });
        expect((await parts.usage()).usedBy('models', 'item').map((ref) => ref.name)).toEqual(['kiosk', 'shop', 'cart', 'stock']);
        expect((await parts.usage()).usedBy('models', 'product')).toEqual([]);
        expect(await readdir(dir)).not.toContain('rename.pending.json');
    });

    it('should rename a theme, a logic module and a component in place, keeping key order', async () => {
        // Arrange
        const { parts, rename } = repository();

        // Act
        const results = [
            await rename.execute({ kind: 'themes', name: 'store', to: 'brand' }),
            await rename.execute({ kind: 'logic', name: 'cart', to: 'basket' }),
            await rename.execute({ kind: 'components', name: 'hero', to: 'banner' })
        ];

        // Assert
        expect(results.map((result) => result.kind)).toEqual(['renamed', 'renamed', 'renamed']);
        const shop = (await body(parts, 'apps', 'shop')) as { uses: { themes: string[]; logic: object }; screens: { home: { root: { component: string } } } };
        expect(shop.uses.themes).toEqual(['brand']);
        expect(Object.keys(shop.uses)).toEqual(['themes', 'data', 'logic']);
        expect(shop.uses.logic).toEqual({ basket: {} });
        expect(shop.screens.home.root.component).toBe('banner');
        expect(((await body(parts, 'apps', 'kiosk')) as { shell: unknown }).shell).toEqual({ component: 'banner' });
    });

    it('should finish a rename stopped after its second file when a new repository recovers, and a second recovery changes nothing', async () => {
        // Arrange
        let partWrites = 0;
        const crashing = repository({
            afterRenameWrite: (path) => {
                if (!path.endsWith('.json') || path === folders.renameJournal() || path === folders.namesFile()) return;
                partWrites += 1;
                if (partWrites === 2) throw new Error('the process stopped');
            }
        });
        await expect(crashing.rename.execute({ kind: 'models', name: 'product', to: 'item' })).rejects.toThrow('the process stopped');
        const journal = await readFile(folders.renameJournal(), 'utf8');

        // Act
        const restarted = repository();
        const recovered = await restarted.files.recover();
        const afterFirst = await snapshot();
        const again = await restarted.files.recover();
        await writeFile(folders.renameJournal(), journal);
        const replayed = await restarted.files.recover();
        const afterReplay = await snapshot();

        // Assert
        expect([recovered, again, replayed]).toEqual([true, false, true]);
        expect(afterReplay).toEqual(afterFirst);
        const { parts } = restarted;
        expect(await parts.findByName('models', 'product')).toBeUndefined();
        expect((await parts.findByName('models', 'item'))?.revision).toBe(2);
        for (const [kind, name] of [['data', 'stock'], ['logic', 'cart'], ['apps', 'shop'], ['apps', 'kiosk']] as const) {
            expect(JSON.stringify(await body(parts, kind, name))).not.toContain('"product"');
            expect((await parts.findByName(kind, name))?.revision).toBe(2);
        }
        expect((JSON.parse(afterFirst['names.json']?.text ?? '{}') as { models: object }).models).toHaveProperty('item');
        expect((await parts.usage()).usedBy('models', 'item')).toHaveLength(4);
    });

    it('should write only the part and names.json when nothing names the part', async () => {
        // Arrange
        const { parts, rename } = repository();
        const order = await parts.findByName('logic', 'cart');
        await parts.write('logic', 'cart', { needs: {} } as never, order?.revision ?? 1);
        const before = await snapshot();
        const id = (await parts.findByName('models', 'order'))?.id ?? '';
        const written: string[] = [];
        const watched = repository({ afterRenameWrite: (path) => written.push(relative(dir, path).split('\\').join('/')) });

        // Act
        const result = await watched.rename.execute({ kind: 'models', name: 'order', to: 'purchase' });
        const after = await snapshot();

        // Assert
        expect(result).toEqual({ kind: 'renamed', revision: 2, rewritten: [] });
        expect(written).toEqual([`models/${id}.json`, 'names.json']);
        const changed = Object.keys(after).filter((path) => after[path]?.text !== before[path]?.text);
        expect(changed.sort()).toEqual([`models/${id}.json`, 'names.json']);
    });

    it('should load the instance of a renamed app, which is kept by the app id', async () => {
        // Arrange
        const { parts, rename } = repository();
        const instances = new FileUiInstanceRepository(folders, new KeyedLock(), OWNER);
        const shop = await parts.findByName('apps', 'shop');
        const appId = shop?.id ?? '';
        await instances.write(appId, { screens: { about: { _text: 'About' } } }, { screens: { about: { _text: 'Our story' } } });

        // Act
        const result = await rename.execute({ kind: 'apps', name: 'shop', to: 'store-front' });
        const renamed = await parts.findByName('apps', 'store-front');
        const instance = await instances.get(renamed?.id ?? '');

        // Assert
        expect(result).toEqual({ kind: 'renamed', revision: 2, rewritten: [] });
        expect(renamed?.id).toBe(appId);
        expect(instance.value).toEqual({ screens: { about: { _text: 'Our story' } } });
    });

    it('should refuse a name that is taken or not a slug, and change no file', async () => {
        // Arrange
        const { rename } = repository();
        const before = await snapshot();

        // Act
        const taken = await rename.execute({ kind: 'models', name: 'product', to: 'order' });
        const notSlug = await rename.execute({ kind: 'models', name: 'product', to: 'New Item' });
        const missing = await rename.execute({ kind: 'models', name: 'nothing', to: 'item' });

        // Assert
        expect(taken).toEqual({ kind: 'duplicate-name' });
        expect(notSlug.kind).toBe('invalid');
        expect(missing).toEqual({ kind: 'not-found' });
        expect(await snapshot()).toEqual(before);
    });

    it('should rename a screen with the app revision: the key in place, start and navigate targets', async () => {
        // Arrange
        const { parts, rename } = repository();
        const before = await snapshot();

        // Act
        const stale = await rename.execute({ kind: 'screens', app: 'shop', name: 'about', to: 'story', expectedRevision: 5 });
        const unchanged = await snapshot();
        const taken = await rename.execute({ kind: 'screens', app: 'shop', name: 'about', to: 'home', expectedRevision: 1 });
        const renamedAbout = await rename.execute({ kind: 'screens', app: 'shop', name: 'about', to: 'story', expectedRevision: 1 });
        const renamedHome = await rename.execute({ kind: 'screens', app: 'shop', name: 'home', to: 'welcome', expectedRevision: 2 });

        // Assert
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 1 });
        expect(unchanged).toEqual(before);
        expect(taken).toEqual({ kind: 'duplicate-name' });
        expect(renamedAbout).toEqual({ kind: 'renamed', revision: 2, rewritten: [] });
        expect(renamedHome).toEqual({ kind: 'renamed', revision: 3, rewritten: [] });
        const shop = (await body(parts, 'apps', 'shop')) as { start: string; screens: Record<string, { root: { on?: unknown } }> };
        expect(shop.start).toBe('welcome');
        expect(Object.keys(shop.screens)).toEqual(['welcome', 'story']);
        expect(shop.screens['welcome']?.root.on).toEqual({ click: [{ command: 'navigate', target: 'story' }] });
    });
});
