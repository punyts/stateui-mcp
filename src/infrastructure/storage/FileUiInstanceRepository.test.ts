import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../domain/JsonValue.js';
import { FileUiInstanceRepository } from './FileUiInstanceRepository.js';
import { KeyedLock } from './KeyedLock.js';
import { PartFolders } from './PartFolders.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const APP = '00000000-0000-4000-8000-000000000001';

const DEFINITION = deepFreeze({ app: { children: { body: { open: false, label: 'Menu' } } }, screens: { main: { query: '' } }, data: {} }) as unknown as JsonObject;
const USED = deepFreeze({ app: { children: { body: { open: true, label: 'Menu' } } }, screens: { main: { query: 'lamp' } }, data: {} }) as unknown as JsonObject;
const NOTES = deepFreeze({ model: 'note', records: { n1: { text: 'Call Ann' } } });

let dir: string;
let folders: PartFolders;
let instances: FileUiInstanceRepository;

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false
    );
}

async function plant(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-instances-'));
    folders = new PartFolders(dir);
    instances = new FileUiInstanceRepository(folders, new KeyedLock(), OWNER);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('FileUiInstanceRepository', () => {
    it('should read an app the persona has not used as an empty diff, with no problem', async () => {
        // Act
        const read = await instances.get(APP);

        // Assert
        expect(read).toEqual({ value: {} });
    });

    it('should store only the paths that differ from the definition, under the owner and the app id', async () => {
        // Act
        const diff = await instances.write(APP, DEFINITION, USED);

        // Assert
        const expected = { app: { children: { body: { open: true } } }, screens: { main: { query: 'lamp' } } };
        expect(diff).toEqual(expected);
        const path = join(dir, 'personas', 'default', 'apps', OWNER, `${APP}.json`);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(expected);
        expect(await instances.get(APP)).toEqual({ value: expected });
    });

    it('should remove the file when the state is the definition again', async () => {
        // Arrange
        await instances.write(APP, DEFINITION, USED);

        // Act
        const diff = await instances.write(APP, DEFINITION, DEFINITION);

        // Assert
        expect(diff).toEqual({});
        expect(await exists(folders.instanceFile(OWNER, APP))).toBe(false);
    });

    it('should ignore a corrupt instance file and say why, without quoting the file', async () => {
        // Arrange
        await plant(folders.instanceFile(OWNER, APP), '{"app": {"secret": "typed by the person"');

        // Act
        const read = await instances.get(APP);

        // Assert
        expect(read.value).toEqual({});
        expect(read.problem).toBe(`The instance of the app ${APP} was ignored: the file is not valid JSON`);
        expect(read.problem).not.toContain('typed by the person');
    });

    it('should ignore an instance file that holds something other than an instance', async () => {
        // Arrange
        await plant(folders.instanceFile(OWNER, APP), JSON.stringify({ app: {}, document: {} }));

        // Act
        const read = await instances.get(APP);

        // Assert
        expect(read).toEqual({ value: {}, problem: `The instance of the app ${APP} was ignored: the key "document" is not part of an instance` });
    });

    it('should keep the records of a persona binding by app id and binding name', async () => {
        // Act
        await instances.writeData(APP, 'notes', NOTES);

        // Assert
        const path = join(dir, 'personas', 'default', 'data', APP, 'notes.json');
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(NOTES);
        expect(await instances.getData(APP, 'notes')).toEqual({ value: NOTES });
        expect(await instances.getData(APP, 'other')).toEqual({ value: undefined });
    });

    it('should keep two binding names that differ only in case in two files', async () => {
        // Arrange
        const upper = deepFreeze({ model: 'note', records: { n9: { text: 'Other' } } });

        // Act
        await instances.writeData(APP, 'notesByDay', NOTES);
        await instances.writeData(APP, 'notesbyday', upper);

        // Assert
        expect(folders.personaDataFile(APP, 'notesByDay').endsWith('notes^by^day.json')).toBe(true);
        expect((await instances.getData(APP, 'notesByDay')).value).toEqual(NOTES);
        expect((await instances.getData(APP, 'notesbyday')).value).toEqual(upper);
    });

    it('should ignore a persona dataset file without records and say why', async () => {
        // Arrange
        await plant(folders.personaDataFile(APP, 'notes'), JSON.stringify({ model: 'note' }));

        // Act
        const read = await instances.getData(APP, 'notes');

        // Assert
        expect(read).toEqual({ value: undefined, problem: `The records of "notes" in the app ${APP} were ignored: the file has no records object` });
    });

    it('should remove the instance and every persona dataset of the app on reset, and leave other apps alone', async () => {
        // Arrange
        const other = '00000000-0000-4000-8000-000000000002';
        await instances.write(APP, DEFINITION, USED);
        await instances.writeData(APP, 'notes', NOTES);
        await instances.writeData(APP, 'drafts', NOTES);
        await instances.write(other, DEFINITION, USED);

        // Act
        await instances.reset(APP);

        // Assert
        expect(await instances.get(APP)).toEqual({ value: {} });
        expect(await instances.getData(APP, 'notes')).toEqual({ value: undefined });
        expect(await exists(folders.personaDataDir(APP))).toBe(false);
        expect((await instances.get(other)).value).not.toEqual({});
    });

    it('should refuse an app id that is not a UUID and a binding name that is not a key name', async () => {
        // Act / Assert
        await expect(instances.get('../names')).rejects.toThrow('An app id is a UUID');
        await expect(instances.getData(APP, '../app')).rejects.toThrow('A binding name is a key name');
    });
});
