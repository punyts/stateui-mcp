import type { UiPreviewLog, UiViewLoad } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type RecordPreviewLoadResult = { readonly kind: 'recorded'; readonly appId: string } | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Records that a view rendered the app again. The errors its earlier loads and other views left are dropped from the
 * error log: a view reports what the document still causes when it renders, so an error that stays in the log is one
 * that still happens
 */
export class RecordPreviewLoad {
    constructor(
        private readonly previewLog: UiPreviewLog,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, source: UiViewLoad): Promise<RecordPreviewLoadResult> {
        const recorded = await this.previewLog.recordLoad(appId, source);
        const result: RecordPreviewLoadResult = recorded ? { kind: 'recorded', appId } : { kind: 'not-found', appId };
        this.report.info('Preview load', { appId, outcome: result.kind });
        return result;
    }
}
