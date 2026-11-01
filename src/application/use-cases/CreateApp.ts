import { createEmptyDocument } from '../../domain/UiApp.js';
import type { UiDocument } from '../../domain/UiApp.js';
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
}

export type CreateAppResult =
    | { readonly kind: 'created'; readonly appId: string; readonly revision: number }
    /** The supplied document has blocking errors; nothing was created */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name' }
    | { readonly kind: 'duplicate-name' };

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

        const created = await this.repository.create({ name, document });
        if (created.kind === 'duplicate-name') {
            this.report.info('Create app rejected: duplicate name');
            return { kind: 'duplicate-name' };
        }
        this.report.info('App created', { appId: created.app.id, revision: created.app.revision });
        return { kind: 'created', appId: created.app.id, revision: created.app.revision };
    }
}
