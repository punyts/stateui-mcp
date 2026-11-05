import type { PartRef } from '@punyts/stateui-app/core';
import { partReferences } from '../../domain/partReferences.js';
import { isBlockingError } from '../../domain/UiBuildError.js';
import { blockingErrors, checkDocument, warningsOf } from '../documentChecks.js';
import { loadPartSource } from '../partSource.js';
import type { UiPartError } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UsageSource } from '../UsageIndex.js';
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

export type ValidatePartAppResult =
    | {
          readonly kind: 'validated';
          readonly app: string;
          readonly revision: number;
          /** True when no error blocks; warnings do not count */
          readonly valid: boolean;
          /** Each error names the part that holds it */
          readonly errors: readonly UiPartError[];
          readonly warnings: readonly UiPartError[];
          /** The owner parts the app reaches directly */
          readonly uses: readonly PartRef[];
      }
    | { readonly kind: 'not-found'; readonly app: string };

/**
 * Validates one app of parts, assembled with everything it reaches as stored now. What `ui_validate` calls once the
 * tools work on parts (epic 3); `ValidateApp` serves the old tools until then
 */
export class ValidatePartApp {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly usage: UsageSource,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(app: string): Promise<ValidatePartAppResult> {
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) {
            this.report.info('Part app validate', { app, outcome: 'not-found' });
            return { kind: 'not-found', app };
        }
        const source = await loadPartSource(this.parts, partReferences('apps', part.body));
        const all = this.validator.validateAssembled(part.body, source, app);
        const errors = all.filter(isBlockingError);
        const warnings = all.filter((error) => !isBlockingError(error));
        this.report.info('Part app validate', { app, outcome: 'validated', errorCount: errors.length, warningCount: warnings.length });
        return {
            kind: 'validated',
            app,
            revision: part.revision,
            valid: errors.length === 0,
            errors,
            warnings,
            uses: (await this.usage.usage()).uses(app)
        };
    }
}
