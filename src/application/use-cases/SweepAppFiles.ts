import { UNREFERENCED_FILE_GRACE_MS } from '../../domain/UiFile.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/**
 * Removes what nothing needs: files older than 24 hours whose id is in neither the app's state snapshot nor its
 * document. It runs at the start of every upload to the app. A failure is reported by id and never fails the upload
 */
export class SweepAppFiles {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<void> {
        try {
            const cutoff = new Date(this.now().getTime() - UNREFERENCED_FILE_GRACE_MS);
            const stale = await this.repository.findUnreferenced(appId, cutoff);
            if (stale.length === 0) return;
            await this.repository.deleteByIds(appId, stale.map((file) => file.id));
            for (const file of stale) await this.store.remove(appId, file.id);
            this.report.info('Unreferenced app files removed', { appId, count: stale.length });
        } catch {
            this.report.info('App file sweep failed', { appId });
        }
    }
}
