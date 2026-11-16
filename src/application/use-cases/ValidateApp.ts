import type { PartRef } from '@punyts/stateui-app/core';
import { partReferences } from '../../domain/partReferences.js';
import { isBlockingError } from '../../domain/UiBuildError.js';
import { loadPartSource } from '../partSource.js';
import type { UiPartError } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UsageSource } from '../UsageIndex.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

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
 * Validates one app of parts, assembled with everything it reaches as stored now, for `ui_validate`
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
