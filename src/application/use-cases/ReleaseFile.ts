import { isFileReferenced } from '../../domain/UiFile.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiFileRepository } from '../ports/UiFileRepository.js';
import type { UiFileStore } from '../ports/UiFileStore.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** `released` removed the row and the bytes; `referenced` kept the file because something holds it; `not-found` found no such file */
export type ReleaseFileResult = { readonly kind: 'released' } | { readonly kind: 'referenced' } | { readonly kind: 'not-found' };

/**
 * Gives a file of an app back, so a component that saves often does not fill the app's quota. The file stays when the
 * app part's definition or the state of its instance still references its id: the same read and the same definition
 * (`isFileReferenced`) as `SweepAppFiles`, so a release never removes a file live state still holds. The check and the
 * removal of the row run under the per-app lock of the file repository; the bytes are removed after the row. A file
 * the app does not have (never uploaded, already released or swept, or another app's) is `not-found`. Reports carry
 * ids, never names or contents
 */
export class ReleaseFile {
    constructor(
        private readonly repository: UiFileRepository,
        private readonly store: UiFileStore,
        private readonly parts: Pick<UiPartRepository, 'findById'>,
        private readonly states: Pick<InstanceStates, 'state'>,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, fileId: string): Promise<ReleaseFileResult> {
        if ((await this.parts.findById('apps', appId)) === undefined) return { kind: 'not-found' };
        const outcome = await this.repository.deleteUnlessReferenced(appId, fileId, async () => {
            // Read under the lock, so the definition and the state are the ones of the moment of the removal
            const part = await this.parts.findById('apps', appId);
            // An app removed meanwhile is left alone: its side folder goes with it
            if (part === undefined) return true;
            const state = await this.states.state(part);
            return isFileReferenced(fileId, [part.body, state]);
        });
        if (outcome === 'not-found') return { kind: 'not-found' };
        if (outcome === 'referenced') {
            this.report.info('App file release refused: referenced', { appId, fileId });
            return { kind: 'referenced' };
        }
        await this.store.remove(appId, fileId);
        this.report.info('App file released', { appId, fileId });
        return { kind: 'released' };
    }
}
