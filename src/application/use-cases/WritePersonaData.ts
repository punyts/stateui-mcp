import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isBlockingError, isValid } from '../../domain/UiBuildError.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { loadPartSource } from '../partSource.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiInstanceRepository } from '../ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface WritePersonaDataInput {
    /** The app's name */
    readonly app: string;
    /** A key of the app's `uses.data` whose binding has `scope: "persona"` */
    readonly binding: string;
    readonly records: JsonObject;
}

export type WritePersonaDataResult =
    | { readonly kind: 'written'; readonly app: string; readonly binding: string }
    /** Records that do not fit the binding's model (each error at `$.records.{key}`); nothing was written */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    /** The app has no such binding, or it names a shared dataset, whose records are the dataset's */
    | { readonly kind: 'not-persona'; readonly app: string; readonly binding: string }
    | { readonly kind: 'not-found'; readonly app: string };

/**
 * Replaces the default persona's records of one persona binding. They have no part: they are kept with the instance,
 * under the app's id, and checked against the binding's model with the same check a dataset part gets (`checkRecord`)
 */
export class WritePersonaData {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WritePersonaDataInput): Promise<WritePersonaDataResult> {
        const { app, binding, records } = input;
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return this.finish({ kind: 'not-found', app });
        const declared: unknown = part.body.uses?.data?.[binding];
        if (!isJsonObject(declared) || declared['scope'] !== 'persona' || typeof declared['model'] !== 'string') {
            return this.finish({ kind: 'not-persona', app, binding });
        }
        const model = declared['model'];
        const body = { model, records } as unknown as UiPartBodies['data'];
        const source = await loadPartSource(this.parts, [{ kind: 'models', name: model }]);
        const errors = this.validator.validatePart('data', binding, body, source);
        if (!isValid(errors)) {
            this.report.info('Persona data write', { app, binding, outcome: 'invalid', errorCount: errors.filter(isBlockingError).length });
            return { kind: 'invalid', errors };
        }
        await this.instances.writeData(part.id, binding, { model, records });
        return this.finish({ kind: 'written', app, binding });
    }

    private finish(result: WritePersonaDataResult): WritePersonaDataResult {
        const named = result.kind === 'invalid' ? {} : { app: result.app, ...('binding' in result && { binding: result.binding }) };
        this.report.info('Persona data write', { ...named, outcome: result.kind });
        return result;
    }
}
