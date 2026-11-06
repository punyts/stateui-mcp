import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../domain/JsonValue.js';
import type { UiFile } from '../../domain/UiFile.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../../testing/InMemoryUiPartRepository.js';
import type { ReleaseUiFileOutcome, UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import { ReleaseFile } from './ReleaseFile.js';

const FILE = '0b6e8c1a-3f1e-4a52-9a43-2f4f1c8f2d10';
const OTHER_FILE = '7d1f0a52-9c3e-4b1a-8e2f-61a0b3c4d5e6';
const APP_BODY = Object.freeze({ shell: { component: 'page' }, start: 'home', screens: { home: { root: { component: 'panel' } } } }) as unknown as UiPartBodies['apps'];

/** The file rows of each app, in memory; `deleteUnlessReferenced` records whether it ran its check */
class MemoryFiles implements UiFileRepository {
    readonly rows = new Map<string, UiFile[]>();
    checks = 0;

    put(appId: string, id: string): void {
        const file: UiFile = { id, appId, name: 'a.png', size: 1, type: 'image/png', sha256: 'h', createdAt: new Date() };
        this.rows.set(appId, [...(this.rows.get(appId) ?? []), file]);
    }

    has(appId: string, id: string): boolean {
        return (this.rows.get(appId) ?? []).some((file) => file.id === id);
    }

    async appExists(): Promise<boolean> {
        return true;
    }

    async usage(appId: string) {
        const files = this.rows.get(appId) ?? [];
        return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
    }

    async add(): Promise<never> {
        throw new Error('not used');
    }

    async findById(appId: string, fileId: string): Promise<UiFile | undefined> {
        return (this.rows.get(appId) ?? []).find((file) => file.id === fileId);
    }

    async list(appId: string): Promise<readonly UiFile[]> {
        return this.rows.get(appId) ?? [];
    }

    async findOlderThan(): Promise<readonly UiFile[]> {
        return [];
    }

    async deleteByIds(appId: string, fileIds: readonly string[]): Promise<void> {
        this.rows.set(appId, (this.rows.get(appId) ?? []).filter((file) => !fileIds.includes(file.id)));
    }

    async deleteUnlessReferenced(appId: string, fileId: string, isReferenced: () => Promise<boolean>): Promise<ReleaseUiFileOutcome> {
        if (!this.has(appId, fileId)) return 'not-found';
        this.checks += 1;
        if (await isReferenced()) return 'referenced';
        await this.deleteByIds(appId, [fileId]);
        return 'deleted';
    }
}

async function setUp(state: JsonObject = {}, body: UiPartBodies['apps'] = APP_BODY) {
    const parts = new InMemoryUiPartRepository();
    const app = await parts.create({ kind: 'apps', name: 'one', body });
    const other = await parts.create({ kind: 'apps', name: 'two', body: APP_BODY });
    if (app.kind !== 'created' || other.kind !== 'created') throw new Error('not created');
    const files = new MemoryFiles();
    const removed: string[] = [];
    const store = { remove: vi.fn(async (_appId: string, fileId: string) => void removed.push(fileId)) } as unknown as UiFileStore;
    const states = { state: vi.fn(async (_part: UiPart<'apps'>) => state) };
    const release = new ReleaseFile(files, store, parts, states, { info: vi.fn() });
    return { release, files, removed, states, appId: app.part.id, otherId: other.part.id };
}

describe('ReleaseFile', () => {
    it('should remove the row and the bytes of a file nothing references', async () => {
        // Arrange
        const { release, files, removed, appId } = await setUp({ data: { photo: { id: OTHER_FILE } } });
        files.put(appId, FILE);

        // Act
        const result = await release.execute(appId, FILE);

        // Assert
        expect(result).toEqual({ kind: 'released' });
        expect(files.has(appId, FILE)).toBe(false);
        expect(removed).toEqual([FILE]);
    });

    it('should keep a file the live state of the instance references, in any case of the id', async () => {
        // Arrange
        const { release, files, removed, states, appId } = await setUp({ app: { children: { sketch: { value: { id: FILE.toUpperCase() } } } } });
        files.put(appId, FILE);

        // Act
        const result = await release.execute(appId, FILE);

        // Assert
        expect(result).toEqual({ kind: 'referenced' });
        expect(files.has(appId, FILE)).toBe(true);
        expect(removed).toEqual([]);
        expect(states.state).toHaveBeenCalledTimes(1);
    });

    it("should keep a file the app part's definition references", async () => {
        // Arrange
        const body = { ...APP_BODY, shell: { component: 'page', background: { id: FILE } } } as unknown as UiPartBodies['apps'];
        const { release, files, appId } = await setUp({}, body);
        files.put(appId, FILE);

        // Act
        const result = await release.execute(appId, FILE);

        // Assert
        expect(result).toEqual({ kind: 'referenced' });
        expect(files.has(appId, FILE)).toBe(true);
    });

    it('should answer not-found for a missing file, and again for a file released before', async () => {
        // Arrange
        const { release, files, removed, appId } = await setUp();
        files.put(appId, FILE);

        // Act
        const missing = await release.execute(appId, OTHER_FILE);
        const first = await release.execute(appId, FILE);
        const second = await release.execute(appId, FILE);

        // Assert
        expect([missing, first, second]).toEqual([{ kind: 'not-found' }, { kind: 'released' }, { kind: 'not-found' }]);
        expect(removed).toEqual([FILE]);
    });

    it("should answer not-found for another app's file id and leave that file alone", async () => {
        // Arrange
        const { release, files, removed, appId, otherId } = await setUp();
        files.put(otherId, FILE);

        // Act
        const result = await release.execute(appId, FILE);

        // Assert
        expect(result).toEqual({ kind: 'not-found' });
        expect(files.has(otherId, FILE)).toBe(true);
        expect(files.checks).toBe(0);
        expect(removed).toEqual([]);
    });

    it('should answer not-found for an app that does not exist', async () => {
        // Arrange
        const { release, files } = await setUp();

        // Act
        const result = await release.execute('11111111-1111-4111-8111-111111111111', FILE);

        // Assert
        expect(result).toEqual({ kind: 'not-found' });
        expect(files.checks).toBe(0);
    });
});
