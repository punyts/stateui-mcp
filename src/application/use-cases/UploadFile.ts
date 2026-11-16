import {
    detectBodyType,
    detectMagicType,
    MAX_BYTES_PER_APP,
    MAX_FILE_BYTES,
    MAX_FILES_PER_APP,
    normaliseFileName
} from '../../domain/UiFile.js';
import type { UiFileReference } from '../../domain/UiFile.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { SweepAppFiles } from './SweepAppFiles.js';

/** What the caller supplies: the name the client gave and the bytes. The claimed type is never an input */
export interface UploadFileInput {
    readonly name: string;
    readonly content: AsyncIterable<Uint8Array>;
}

type RefusedUpload =
    | { readonly kind: 'not-found' }
    | { readonly kind: 'too-large' }
    | { readonly kind: 'empty' }
    | { readonly kind: 'unsupported-type' }
    | { readonly kind: 'quota'; readonly reason: 'files' | 'bytes' };

export type UploadFileResult = { readonly kind: 'uploaded'; readonly file: UiFileReference } | RefusedUpload;

/**
 * Stores a file for an app: sweeps the app first, streams the bytes to the store while hashing, sniffs the type
 * from the bytes, and only then adds the row. The bytes are written before the row and removed again when the
 * type or quota check fails or the insert throws. Reports carry ids and sizes, never names, contents or hashes
 */
export class UploadFile {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly sweep: SweepAppFiles,
        private readonly newId: () => string,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: UploadFileInput): Promise<UploadFileResult> {
        if (!(await this.repository.appExists(appId))) return this.refuse(appId, { kind: 'not-found' });
        await this.sweep.execute(appId);
        const usage = await this.repository.usage(appId);
        if (usage.count >= MAX_FILES_PER_APP) return this.refuse(appId, { kind: 'quota', reason: 'files' });

        const name = normaliseFileName(input.name);
        const id = this.newId();
        const saved = await this.store.save(appId, id, input.content, MAX_FILE_BYTES);
        if (saved.kind === 'too-large') return this.refuse(appId, { kind: 'too-large' });
        if (saved.size === 0) {
            await this.store.remove(appId, id);
            return this.refuse(appId, { kind: 'empty' });
        }
        if (usage.bytes + saved.size > MAX_BYTES_PER_APP) {
            await this.store.remove(appId, id);
            return this.refuse(appId, { kind: 'quota', reason: 'bytes' });
        }

        const type = detectMagicType(saved.head, saved.size) ?? detectBodyType(name, await this.store.read(appId, id));
        if (type === undefined) {
            await this.store.remove(appId, id);
            return this.refuse(appId, { kind: 'unsupported-type' });
        }

        let added;
        try {
            added = await this.repository.add({
                id,
                appId,
                name,
                size: saved.size,
                type,
                sha256: saved.sha256
            });
        } catch (error) {
            await this.store.remove(appId, id);
            throw error;
        }
        if (added.kind !== 'added') {
            await this.store.remove(appId, id);
            return this.refuse(appId, added);
        }
        this.report.info('App file uploaded', { appId, fileId: id, size: saved.size, type });
        return { kind: 'uploaded', file: { id, name, size: saved.size, type } };
    }

    private refuse(appId: string, result: RefusedUpload): RefusedUpload {
        this.report.info('App file refused', { appId, outcome: result.kind });
        return result;
    }
}
