import { createEmptyDocument } from '../../domain/UiApp.js';
import type { UiDocument, UiSyncMode } from '../../domain/UiApp.js';
import { isValid } from '../../domain/UiBuildError.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { orderedMapKeyErrors } from '../../domain/orderedMap.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface CreateAppInput {
    readonly name: string;
    /** Absent: the app starts from an empty valid document */
    readonly document?: UiDocument;
    /** Absent: `full` */
    readonly sync?: UiSyncMode;
}

export type CreateAppResult =
    | { readonly kind: 'created'; readonly appId: string; readonly revision: number }
    /** The supplied document has blocking errors; nothing was created */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name' }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'no-statenet' };

/** Creates an app, from an empty document or from a validated one */
export class CreateApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: CreateAppInput): Promise<CreateAppResult> {
        const name = input.name.trim();
        if (name === '') return { kind: 'invalid-name' };

        let document = createEmptyDocument();
        if (input.document !== undefined) {
            const errors = [...orderedMapKeyErrors(input.document), ...this.validator.validate(input.document)];
            if (!isValid(errors)) {
                this.report.info('Create app rejected', { errorCount: errors.length });
                return { kind: 'invalid', errors };
            }
            document = input.document;
        }

        const created = await this.repository.create({ name, document, sync: input.sync ?? 'full' });
        if (created.kind !== 'created') {
            this.report.info('Create app rejected', { reason: created.kind });
            return { kind: created.kind };
        }
        this.report.info('App created', { appId: created.app.id, revision: created.app.revision, sync: created.app.sync });
        return { kind: 'created', appId: created.app.id, revision: created.app.revision };
    }
}
