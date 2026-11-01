import { applyOperation } from '../../domain/documentOperations.js';
import type { WriteOperation } from '../../domain/documentOperations.js';
import { checkDocumentLimits, checkOperationLimit } from '../../domain/limits.js';
import { isRevisionCurrent } from '../../domain/revision.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { isValid } from '../../domain/UiBuildError.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { checkDocument } from '../documentChecks.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type WriteAppResult =
    /** The candidate was committed; `revision` is the new one and `warnings` did not block it */
    | { readonly kind: 'written'; readonly appId: string; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    /** The candidate document has blocking errors (or the call is over a limit); nothing was committed. Warnings are listed too */
    | { readonly kind: 'invalid'; readonly appId: string; readonly errors: readonly UiBuildError[] }
    /** One operation could not be applied: an unknown `op`, a bad path or a missing parent. `index` is its position */
    | { readonly kind: 'invalid-operation'; readonly appId: string; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'conflict'; readonly appId: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Applies operations in order to a copy of the document, checks the whole candidate and commits it only when no
 * error blocks, as one write that raises the revision once. Warnings do not block and come back with the result.
 * Any failure leaves the stored app as it was. `expectedRevision` absent means last writer wins; the commit itself
 * is still compare-and-set against the revision that was read, so a write that races another returns `conflict`
 */
export class WriteApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(
        appId: string,
        operations: readonly WriteOperation[],
        expectedRevision?: number
    ): Promise<WriteAppResult> {
        const rejected = this.rejectCall(operations);
        if (rejected !== undefined) return this.finish(appId, operations.length, { kind: 'invalid', appId, errors: [rejected] });

        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish(appId, operations.length, { kind: 'not-found', appId });
        if (!isRevisionCurrent(app.revision, expectedRevision)) {
            return this.finish(appId, operations.length, {
                kind: 'conflict',
                appId,
                currentRevision: app.revision
            });
        }

        let candidate: UiDocument = app.document;
        for (const [index, operation] of operations.entries()) {
            const applied = applyOperation(candidate, operation);
            if (!applied.ok) {
                return this.finish(appId, operations.length, {
                    kind: 'invalid-operation',
                    appId,
                    index,
                    error: applied.error
                });
            }
            candidate = applied.document;
        }

        const limitErrors = checkDocumentLimits(candidate);
        if (limitErrors.length > 0) {
            return this.finish(appId, operations.length, { kind: 'invalid', appId, errors: limitErrors });
        }
        const errors = checkDocument(candidate, this.validator);
        if (!isValid(errors)) {
            return this.finish(appId, operations.length, { kind: 'invalid', appId, errors });
        }

        const written = await this.repository.writeDocument(appId, candidate, app.revision);
        if (written.kind === 'conflict') {
            return this.finish(appId, operations.length, {
                kind: 'conflict',
                appId,
                currentRevision: written.currentRevision
            });
        }
        if (written.kind === 'not-found') return this.finish(appId, operations.length, { kind: 'not-found', appId });
        return this.finish(appId, operations.length, {
            kind: 'written',
            appId,
            revision: written.revision,
            warnings: errors
        });
    }

    private rejectCall(operations: readonly WriteOperation[]): UiBuildError | undefined {
        if (operations.length === 0) {
            return { code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' };
        }
        return checkOperationLimit(operations.length);
    }

    private finish(appId: string, operationCount: number, result: WriteAppResult): WriteAppResult {
        this.report.info('App write', {
            appId,
            operationCount,
            outcome: result.kind,
            ...(result.kind === 'written' ? { revision: result.revision, warningCount: result.warnings.length } : {}),
            ...(result.kind === 'invalid' ? { errorCount: result.errors.length } : {})
        });
        return result;
    }
}
