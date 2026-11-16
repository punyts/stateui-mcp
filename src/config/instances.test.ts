import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleApp, layInstance } from '@punyts/stateui-app/core';
import type { AppInstance, JsonObject as LibraryJsonObject } from '@punyts/stateui-app/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { loadPartSource } from '../application/partSource.js';
import { ResetInstance } from '../application/use-cases/ResetState.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import { WritePersonaData } from '../application/use-cases/WritePersonaData.js';
import type { JsonObject } from '../domain/JsonValue.js';
import { partReferences } from '../domain/partReferences.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { LOCAL_OWNER_ID } from './createServices.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const { validator } = createStateUiAdapters();
const REPORT = Object.freeze({ info: (): void => undefined });

const NOTE = deepFreeze({ fields: { text: { type: 'string', required: true } } }) as UiPartBodies['models'];

function app(greeting: string): UiPartBodies['apps'] {
    return deepFreeze({
        uses: { data: { notes: { model: 'note', scope: 'persona' } } },
        start: 'main',
        app: { component: 'app' },
        screens: { main: { root: { component: 'text', _text: greeting } } }
    }) as unknown as UiPartBodies['apps'];
}

let dir: string;
let lock: KeyedLock;
let parts: IndexedUiPartRepository;
let instances: FileUiInstanceRepository;
let writePart: WritePart;
let appId: string;

/** Every file under a folder, by relative path, with its bytes */
async function files(root: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        found.set(path.slice(root.length), await readFile(path, 'utf8'));
    }
    return found;
}

/** The view a person sees: the assembled app with the stored instance laid over it */
async function view(): Promise<ReturnType<typeof layInstance>> {
    const part = await parts.findByName('apps', 'notebook');
    if (part === undefined) throw new Error('no app');
    const { document } = assembleApp(part.body, await loadPartSource(parts, partReferences('apps', part.body)));
    const screens = Object.fromEntries(Object.entries(document.screens ?? {}).map(([name, screen]) => [name, screen.root as unknown as LibraryJsonObject]));
    const instance = (await instances.get(appId)).value as unknown as AppInstance;
    return layInstance({ app: document.app as unknown as LibraryJsonObject, screens, data: {} }, { ...instance, app: instance.app ?? {}, screens: instance.screens ?? {} }, document);
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-instance-use-'));
    const folders = new PartFolders(dir);
    lock = new KeyedLock();
    parts = new IndexedUiPartRepository(new FilePartRepository(folders, lock));
    instances = new FileUiInstanceRepository(folders, lock, LOCAL_OWNER_ID);
    writePart = new WritePart(parts, parts, validator, REPORT);
    for (const [kind, name, body] of [
        ['models', 'note', NOTE],
        ['apps', 'notebook', app('Welcome')]
    ] as const) {
        const written = await writePart.execute({ kind, name, body } as never);
        if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
    }
    appId = (await parts.findByName('apps', 'notebook'))?.id as string;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('instances beside owner parts', () => {
    it('should leave every part file byte-identical when the instance is written', async () => {
        // Arrange
        const before = await files(dir);

        // Act
        await instances.write(appId, { data: {} }, { data: { draft: 'Buy milk' } });

        // Assert
        const after = await files(dir);
        const added = [...after.keys()].filter((path) => !before.has(path));
        expect(added).toEqual([new PartFolders(dir).instanceFile(LOCAL_OWNER_ID, appId).slice(dir.length)]);
        for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
    });

    it('should show a definition edit in the next view and leave the instance file byte-identical', async () => {
        // Arrange
        await instances.write(appId, { data: {} }, { data: { draft: 'Buy milk' } });
        const instanceFile = new PartFolders(dir).instanceFile(LOCAL_OWNER_ID, appId);
        const stored = await readFile(instanceFile, 'utf8');

        // Act
        const written = await writePart.execute({ kind: 'apps', name: 'notebook', body: app('Hello'), expectedRevision: 1 });

        // Assert
        expect(written.kind).toBe('written');
        expect(await readFile(instanceFile, 'utf8')).toBe(stored);
        const laid = await view();
        expect(laid.screens?.['main']?.['_text']).toBe('Hello');
        expect(laid.data).toEqual({ draft: 'Buy milk' });
    });

    it('should keep persona records that fit the model and refuse ones that do not, writing no part', async () => {
        // Arrange
        const writeData = new WritePersonaData(parts, instances, validator, REPORT);
        const before = await files(join(dir, 'models'));

        // Act
        const good = await writeData.execute({ app: 'notebook', binding: 'notes', records: { n1: { text: 'Call Ann' } } });
        const bad = await writeData.execute({ app: 'notebook', binding: 'notes', records: { n2: { text: 4 } } as unknown as JsonObject });
        const shared = await writeData.execute({ app: 'notebook', binding: 'other', records: {} });
        const missing = await writeData.execute({ app: 'nothing', binding: 'notes', records: {} });

        // Assert
        expect(good).toEqual({ kind: 'written', app: 'notebook', binding: 'notes' });
        expect(bad.kind === 'invalid' && bad.errors.map((error) => [error.code, error.statePath])).toEqual([['SUI-MODEL-FIELD', '$.records.n2']]);
        expect([shared.kind, missing.kind]).toEqual(['not-persona', 'not-found']);
        expect(await instances.getData(appId, 'notes')).toEqual({ value: { model: 'note', records: { n1: { text: 'Call Ann' } } } });
        expect(await files(join(dir, 'models'))).toEqual(before);
    });

    it('should reset the instance and the persona records to the definition', async () => {
        // Arrange
        const reset = new ResetInstance(parts, instances, REPORT);
        await instances.write(appId, { data: {} }, { data: { draft: 'Buy milk' } });
        await new WritePersonaData(parts, instances, validator, REPORT).execute({ app: 'notebook', binding: 'notes', records: { n1: { text: 'Call Ann' } } });

        // Act
        const result = await reset.execute('notebook');

        // Assert
        expect(result).toEqual({ kind: 'reset', app: 'notebook', revision: 1 });
        expect(await instances.get(appId)).toEqual({ value: {} });
        expect(await instances.getData(appId, 'notes')).toEqual({ value: undefined });
        expect((await view()).data).toEqual({});
        expect(await reset.execute('nothing')).toEqual({ kind: 'not-found', app: 'nothing' });
    });
});
