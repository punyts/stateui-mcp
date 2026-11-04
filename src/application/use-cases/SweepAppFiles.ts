import { isFileReferenced, UNREFERENCED_FILE_GRACE_MS } from '../../domain/UiFile.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/**
 * Removes what nothing needs: files older than 24 hours whose id is in neither the app's document nor the state its
 * views hold. The state is read through the app repository, so it is the live state wherever it is kept (the server's
 * authority, the statenet, or the statenet alone for a Persisted app), not only what reached `state.json`. It runs at
 * the start of every upload to the app. When the app or its state cannot be read nothing is removed. A failure is
 * reported by id and never fails the upload
 */
export class SweepAppFiles {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly apps: UiAppRepository,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<void> {
        try {
            const cutoff = new Date(this.now().getTime() - UNREFERENCED_FILE_GRACE_MS);
            const old = await this.repository.findOlderThan(appId, cutoff);
            if (old.length === 0) return;
            const app = await this.apps.findById(appId);
            if (app === undefined) return;
            const stale = old.filter((file) => !isFileReferenced(file.id, [app.document, app.stateSnapshot]));
            if (stale.length === 0) return;
            await this.repository.deleteByIds(appId, stale.map((file) => file.id));
            for (const file of stale) await this.store.remove(appId, file.id);
            this.report.info('Unreferenced app files removed', { appId, count: stale.length });
        } catch {
            this.report.info('App file sweep failed', { appId });
        }
    }
}
