import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPartSource } from '../application/partSource.js';
import { partReferences } from '../domain/partReferences.js';
import { isBlockingError } from '../domain/UiBuildError.js';
import type { UiDocument } from '../domain/UiApp.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiFileRepository } from '../infrastructure/storage/FileUiFileRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { deepFreeze, SAMPLE_FORM_AND_LIST_APP } from '../testing/sampleFormAndListApp.fixture.js';
import { SAMPLE_TABS_APP } from '../testing/sampleTabsApp.fixture.js';
import { CONVERTED_DIR, convertDataDir, formatConvertReport } from './convertDataDir.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { LOCAL_OWNER_ID } from './createServices.js';

const { validator } = createStateUiAdapters();

const FORM_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const TABS_ID = '1a2b3c4d-0000-4000-8000-000000000002';
const STRIP_ID = '1a2b3c4d-0000-4000-8000-000000000003';
const FILE_ID = '9f8e7d6c-0000-4000-8000-000000000001';

/** The tabs app with a rule that switches the strip itself, which screens cannot follow: the converter refuses it */
const STRIP_LOGIC_APP = deepFreeze({
    ...(JSON.parse(JSON.stringify(SAMPLE_TABS_APP)) as Record<string, unknown>),
    logic: {
        rules: { toBag: { when: { path: '$.data.bag' }, do: [{ command: 'set', target: '$.app.active', value: 'bag' }] } }
    }
}) as unknown as UiDocument;

let dataDir: string;

async function writeOldApp(appId: string, name: string, document: UiDocument, data?: Record<string, unknown>): Promise<void> {
    const dir = join(dataDir, appId);
    await mkdir(dir, { recursive: true });
    const at = '2026-01-01T00:00:00.000Z';
    await writeFile(join(dir, 'app.json'), JSON.stringify({ id: appId, name, revision: 3, createdAt: at, updatedAt: at, document }));
    const state = { data: data ?? (document as unknown as { data?: unknown }).data ?? {}, app: {} };
    await writeFile(join(dir, 'state.json'), JSON.stringify({ state, revision: 7, log: [], applied: [] }));
    await writeFile(join(dir, 'errors.json'), JSON.stringify([]));
}

/** Every file under the data directory with a hash of its bytes */
async function listing(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    async function walk(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else files[relative(dataDir, path).split('\\').join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
        }
    }
    await walk(dataDir);
    return files;
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false
    );
}

function parts(): FilePartRepository {
    return new FilePartRepository(new PartFolders(dataDir), new KeyedLock());
}

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'stateui-convert-'));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

describe('convertDataDir', () => {
    it('should convert both sample apps into parts that validate, keep their ids and move only app.json and state.json', async () => {
        // Arrange
        await writeOldApp(FORM_ID, 'Contacts', SAMPLE_FORM_AND_LIST_APP);
        await writeOldApp(TABS_ID, 'Halo', SAMPLE_TABS_APP);
        const folders = new PartFolders(dataDir);
        const files = new FileUiFileRepository(folders, new KeyedLock());
        // The old store's file index, as it was written before the conversion
        await mkdir(join(dataDir, TABS_ID, 'files'), { recursive: true });
        await writeFile(folders.filesIndex(TABS_ID), JSON.stringify([{ id: FILE_ID, name: 'lamp.png', size: 4, type: 'image/png', sha256: 'ab', createdAt: new Date().toISOString() }]));
        const instances = new FileUiInstanceRepository(folders, new KeyedLock(), LOCAL_OWNER_ID);
        await mkdir(join(folders.instanceFile(LOCAL_OWNER_ID, TABS_ID), '..'), { recursive: true });
        await writeFile(folders.instanceFile(LOCAL_OWNER_ID, TABS_ID), JSON.stringify({ app: { children: { header: { _text: 'Stale' } } } }));
        await writeFile(folders.fileBytes(TABS_ID, FILE_ID), 'lamp');

        // Act
        const report = await convertDataDir({ dataDir });

        // Assert
        expect(report.unconverted).toEqual([]);
        expect(report.converted.map((app) => app.appId)).toEqual([FORM_ID, TABS_ID]);
        expect(report.converted.every((app) => app.parts.at(-1)?.kind === 'apps')).toBe(true);
        const repository = parts();
        for (const app of report.converted) {
            const part = await repository.findById('apps', app.appId);
            expect(part?.name).toBe(app.parts.at(-1)?.name);
            const body = part!.body;
            const source = await loadPartSource(repository, partReferences('apps', body));
            const errors = validator.validateAssembled(body, source, part!.name).filter(isBlockingError);
            expect(errors, `${app.name}: ${JSON.stringify(errors)}`).toEqual([]);
            expect(await exists(join(dataDir, CONVERTED_DIR, app.appId, 'app.json'))).toBe(true);
            expect(await exists(join(dataDir, CONVERTED_DIR, app.appId, 'state.json'))).toBe(true);
            expect(await exists(join(dataDir, app.appId, 'app.json'))).toBe(false);
            expect(await exists(join(dataDir, app.appId, 'state.json'))).toBe(false);
            expect(await exists(join(dataDir, app.appId, 'errors.json'))).toBe(true);
            expect(await instances.get(app.appId)).toEqual({ value: {} });
        }
        expect((await files.list(TABS_ID)).map((file) => file.id)).toEqual([FILE_ID]);
        expect(await readFile(folders.fileBytes(TABS_ID, FILE_ID), 'utf8')).toBe('lamp');
        expect(formatConvertReport(report)).toContain('Converted 2 apps:');
    });

    it('should take the live data from state.json into the datasets', async () => {
        // Arrange
        await writeOldApp(TABS_ID, 'Halo', SAMPLE_TABS_APP, {
            products: [{ id: 'p1', name: 'Lamp', price: 30 }],
            bag: { l1: { product: 'p1', qty: 1 }, l2: { product: 'p1', qty: 4 } }
        });

        // Act
        const report = await convertDataDir({ dataDir });

        // Assert
        const bagName = report.converted[0]?.parts.find((part) => part.kind === 'data' && part.name.includes('bag'))?.name;
        expect(bagName).toBeDefined();
        const bag = await parts().findByName('data', bagName!);
        expect(Object.keys((bag?.body as unknown as { records: Record<string, unknown> }).records)).toEqual(['l1', 'l2']);
    });

    it('should report the same in a dry run and change no file', async () => {
        // Arrange
        await writeOldApp(FORM_ID, 'Contacts', SAMPLE_FORM_AND_LIST_APP);
        await writeOldApp(STRIP_ID, 'Strip', STRIP_LOGIC_APP);
        const before = await listing();

        // Act
        const dry = await convertDataDir({ dataDir, dryRun: true, purge: true });
        const after = await listing();
        const real = await convertDataDir({ dataDir });

        // Assert
        expect(after).toEqual(before);
        expect(dry.dryRun).toBe(true);
        expect({ converted: dry.converted, unconverted: dry.unconverted }).toEqual({ converted: real.converted, unconverted: real.unconverted });
        expect(dry.purged).toBe(false);
        expect(formatConvertReport(dry)).toContain('Dry run: nothing was changed.');
        expect(formatConvertReport(dry)).toContain('Would convert 1 app:');
    });

    it('should leave an app it cannot convert in place and report it again on the next run', async () => {
        // Arrange
        await writeOldApp(STRIP_ID, 'Strip', STRIP_LOGIC_APP);
        const before = await listing();

        // Act
        const first = await convertDataDir({ dataDir });
        const second = await convertDataDir({ dataDir });

        // Assert
        expect(first.converted).toEqual([]);
        expect(first.unconverted).toHaveLength(1);
        expect(first.unconverted[0]?.name).toBe('Strip');
        expect(first.unconverted[0]?.reasons).toEqual([expect.stringMatching(/^\$\.logic\.rules\.toBag\.do\.0\.target: refers to the hidden-strip tabs/)]);
        expect(second.unconverted).toEqual(first.unconverted);
        expect(await listing()).toEqual(before);
        expect(formatConvertReport(first)).toContain('Not converted, 1 app (the files stay in place):');
    });

    it('should convert nothing on a second run and delete .converted with --purge', async () => {
        // Arrange
        await writeOldApp(FORM_ID, 'Contacts', SAMPLE_FORM_AND_LIST_APP);
        await convertDataDir({ dataDir });
        const partsBefore = await listing();

        // Act
        const second = await convertDataDir({ dataDir });
        const purged = await convertDataDir({ dataDir, purge: true });

        // Assert
        expect(second.converted).toEqual([]);
        expect(formatConvertReport(second)).toBe(`Nothing to convert in ${dataDir}.\n`);
        expect(purged.purged).toBe(true);
        expect(await exists(join(dataDir, CONVERTED_DIR))).toBe(false);
        expect(Object.keys(await listing())).toEqual(Object.keys(partsBefore).filter((path) => !path.startsWith(`${CONVERTED_DIR}/`)));
    });

    it('should report nothing to convert for an empty or missing data directory', async () => {
        // Arrange
        const missing = join(dataDir, 'none');

        // Act
        const empty = await convertDataDir({ dataDir });
        const absent = await convertDataDir({ dataDir: missing });

        // Assert
        expect(formatConvertReport(empty)).toBe(`Nothing to convert in ${dataDir}.\n`);
        expect(formatConvertReport(absent)).toBe(`Nothing to convert in ${missing}.\n`);
        expect(await exists(missing)).toBe(false);
    });

    it('should move the files of an app whose parts an earlier run created', async () => {
        // Arrange
        await writeOldApp(FORM_ID, 'Contacts', SAMPLE_FORM_AND_LIST_APP);
        await convertDataDir({ dataDir });
        const moved = join(dataDir, CONVERTED_DIR, FORM_ID);
        await writeFile(join(dataDir, FORM_ID, 'app.json'), await readFile(join(moved, 'app.json')));
        await writeFile(join(dataDir, FORM_ID, 'state.json'), await readFile(join(moved, 'state.json')));
        await rm(moved, { recursive: true });
        const partFiles = Object.keys(await listing()).filter((path) => !path.startsWith(`${FORM_ID}/`));

        // Act
        const report = await convertDataDir({ dataDir });

        // Assert
        expect(report.converted).toEqual([{ appId: FORM_ID, name: 'Contacts', parts: [], renamed: [] }]);
        expect(formatConvertReport(report)).toContain('its parts exist from an earlier run');
        expect(await exists(join(moved, 'app.json'))).toBe(true);
        expect(await exists(join(dataDir, FORM_ID, 'app.json'))).toBe(false);
        const now = Object.keys(await listing()).filter((path) => !path.startsWith(`${FORM_ID}/`) && !path.startsWith(`${CONVERTED_DIR}/`));
        expect(now).toEqual(partFiles);
    });

    it('should not take a name that an existing part or an earlier app of the run has', async () => {
        // Arrange
        await writeOldApp(FORM_ID, 'Halo', SAMPLE_TABS_APP);
        await writeOldApp(TABS_ID, 'Halo', SAMPLE_TABS_APP);

        // Act
        const report = await convertDataDir({ dataDir });

        // Assert
        expect(report.unconverted).toEqual([]);
        const names = report.converted.flatMap((app) => app.parts.map((part) => `${part.kind}/${part.name}`));
        expect(new Set(names).size).toBe(names.length);
        expect(report.converted[1]?.renamed.length).toBeGreaterThan(0);
    });
});
