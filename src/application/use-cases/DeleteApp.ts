import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type DeleteAppResult =
    /** `revision` is the revision that was deleted: the one the caller expected */
    | { readonly kind: 'deleted'; readonly appId: string; readonly revision: number }
    | { readonly kind: 'conflict'; readonly appId: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Deletes an app with its state, error log and files (the whole app folder). `expectedRevision` is required, so a
 * delete never removes edits the caller has not seen
 */
export class DeleteApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, expectedRevision: number): Promise<DeleteAppResult> {
        const result = await this.repository.delete(appId, expectedRevision);
        this.report.info('App delete', { appId, outcome: result.kind });
        if (result.kind === 'deleted') return { kind: 'deleted', appId, revision: expectedRevision };
        if (result.kind === 'conflict') return { kind: 'conflict', appId, currentRevision: result.currentRevision };
        return { kind: 'not-found', appId };
    }
}
