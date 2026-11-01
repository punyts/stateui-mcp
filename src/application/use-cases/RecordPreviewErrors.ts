import { MAX_PREVIEW_ERRORS } from '../../domain/limits.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type RecordPreviewErrorsResult =
    | { readonly kind: 'recorded'; readonly appId: string; readonly count: number }
    | { readonly kind: 'invalid'; readonly appId: string; readonly reason: string }
    | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Appends the runtime errors a preview reports to the bounded error log, and counts the report as a sign of life.
 * More errors than the log holds in one report keeps the newest, as the log itself drops the oldest
 */
export class RecordPreviewErrors {
    constructor(
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(
        appId: string,
        errors: readonly UiBuildError[],
        revision?: number
    ): Promise<RecordPreviewErrorsResult> {
        if (errors.length === 0) {
            return this.finish({ kind: 'invalid', appId, reason: 'At least one error is required' });
        }
        const occurredAt = this.now();
        const kept = errors.slice(-MAX_PREVIEW_ERRORS);
        for (const error of kept) {
            const appended = await this.previewLog.appendError(appId, error, occurredAt);
            if (!appended) return this.finish({ kind: 'not-found', appId });
        }
        await this.previewLog.recordHeartbeat(appId, revision, occurredAt);
        return this.finish({ kind: 'recorded', appId, count: kept.length });
    }

    private finish(result: RecordPreviewErrorsResult): RecordPreviewErrorsResult {
        this.report.info('Preview errors', {
            appId: result.appId,
            outcome: result.kind,
            ...(result.kind === 'recorded' ? { count: result.count } : {})
        });
        return result;
    }
}
