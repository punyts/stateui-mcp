import type { Readable } from 'node:stream';
import type { UiFile } from '../../domain/UiFile.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { ByteRange, UiFileStore } from '../ports/UiFileStore.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type ReadFileResult =
    | { readonly kind: 'found'; readonly file: UiFile; readonly content: Readable; readonly range?: ByteRange }
    /** `pick` chose to open nothing: the caller answers from the metadata alone */
    | { readonly kind: 'held'; readonly file: UiFile }
    | { readonly kind: 'not-found' };

/**
 * What to open of a found file: a range of it, `undefined` for the whole file, or `false` for nothing (a `HEAD`, a
 * cached copy that is still good, a range past the end)
 */
export type PickBytes = (file: UiFile) => ByteRange | undefined | false;

/** Opens a file's bytes. A file of another app or workspace, or one whose bytes are gone, is `not-found` */
export class ReadFile {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, fileId: string, pick?: PickBytes): Promise<ReadFileResult> {
        const file = await this.repository.findById(appId, fileId);
        if (file === undefined) return { kind: 'not-found' };
        const range = pick?.(file);
        if (range === false) return { kind: 'held', file };
        const content = await this.store.open(appId, fileId, range);
        if (content === undefined) return { kind: 'not-found' };
        this.report.info('App file read', { appId, fileId, size: range === undefined ? file.size : range.end - range.start + 1 });
        return { kind: 'found', file, content, ...(range !== undefined && { range }) };
    }
}
