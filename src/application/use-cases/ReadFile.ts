import type { Readable } from 'node:stream';
import type { UiFile } from '../../domain/UiFile.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type ReadFileResult =
    | { readonly kind: 'found'; readonly file: UiFile; readonly content: Readable }
    | { readonly kind: 'not-found' };

/** Opens a file's bytes. A file of another app or workspace, or one whose bytes are gone, is `not-found` */
export class ReadFile {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, fileId: string): Promise<ReadFileResult> {
        const file = await this.repository.findById(appId, fileId);
        if (file === undefined) return { kind: 'not-found' };
        const content = await this.store.open(appId, fileId);
        if (content === undefined) return { kind: 'not-found' };
        this.report.info('App file read', { appId, fileId, size: file.size });
        return { kind: 'found', file, content };
    }
}
