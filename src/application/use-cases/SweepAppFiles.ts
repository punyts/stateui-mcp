import { isFileReferenced, UNREFERENCED_FILE_GRACE_MS } from '../../domain/UiFile.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/**
 * Removes what nothing needs: files older than 24 hours whose id is in neither the app part's definition nor the
 * state of its instance. The state is read through the instance's authority, so it is the live state (what a view set
 * and a tool wrote), not only what reached the disk. It runs at the start of every upload to the app. When the app or
 * its state cannot be read nothing is removed. A failure is reported by id and never fails the upload
 */
export class SweepAppFiles {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly parts: Pick<UiPartRepository, 'findById'>,
        private readonly states: Pick<InstanceStates, 'state'>,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<void> {
        try {
            const cutoff = new Date(this.now().getTime() - UNREFERENCED_FILE_GRACE_MS);
            const old = await this.repository.findOlderThan(appId, cutoff);
            if (old.length === 0) return;
            const part = await this.parts.findById('apps', appId);
            if (part === undefined) return;
            const state = await this.states.state(part);
            const stale = old.filter((file) => !isFileReferenced(file.id, [part.body, state]));
            if (stale.length === 0) return;
            await this.repository.deleteByIds(appId, stale.map((file) => file.id));
            for (const file of stale) await this.store.remove(appId, file.id);
            this.report.info('Unreferenced app files removed', { appId, count: stale.length });
        } catch {
            this.report.info('App file sweep failed', { appId });
        }
    }
}
