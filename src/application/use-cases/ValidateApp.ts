import { blockingErrors, checkDocument, warningsOf } from '../documentChecks.js';
import type { UiPreviewDto } from '../dtos/UiPreviewDto.js';
import { toPreviewDto } from '../dtos/UiPreviewDto.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type ValidateAppResult =
    | {
          readonly kind: 'validated';
          readonly appId: string;
          readonly revision: number;
          /** True when no error blocks; warnings do not count */
          readonly valid: boolean;
          readonly errors: readonly UiBuildError[];
          /** Includes `SUI-LOCALE-MISSING` for each content path a language of the app does not translate */
          readonly warnings: readonly UiBuildError[];
          readonly preview: UiPreviewDto;
      }
    | { readonly kind: 'not-found'; readonly appId: string };

/** Validates the stored document and adds what the previews of the app report */
export class ValidateApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<ValidateAppResult> {
        const app = await this.repository.findById(appId);
        if (app === undefined) {
            this.report.info('App validate', { appId, outcome: 'not-found' });
            return { kind: 'not-found', appId };
        }
        const all = checkDocument(app.document, this.validator);
        const errors = blockingErrors(all);
        const warnings = warningsOf(all);
        const preview = toPreviewDto(await this.previewLog.status(appId, this.now()));
        this.report.info('App validate', {
            appId,
            outcome: 'validated',
            errorCount: errors.length,
            warningCount: warnings.length,
            previewAttached: preview.attached
        });
        return { kind: 'validated', appId, revision: app.revision, valid: errors.length === 0, errors, warnings, preview };
    }
}
