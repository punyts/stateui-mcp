import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isBlockingError, isValid } from '../../domain/UiBuildError.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { loadPartSource } from '../partSource.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiInstanceRepository } from '../ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface WritePersonDataInput {
    /** The app's name */
    readonly app: string;
    /** A key of the app's `uses.data` whose binding has `scope: "person"` */
    readonly binding: string;
    readonly records: JsonObject;
}

export type WritePersonDataResult =
    | { readonly kind: 'written'; readonly app: string; readonly binding: string }
    /** Records that do not fit the binding's model (each error at `$.records.{key}`); nothing was written */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    /** The app has no such binding, or it names a shared dataset, whose records are the dataset's */
    | { readonly kind: 'not-person'; readonly app: string; readonly binding: string }
    | { readonly kind: 'not-found'; readonly app: string };

/**
 * Replaces the owner's own records of one person binding. They have no part: they are kept with the instance,
 * under the app's id, and checked against the binding's model with the same check a dataset part gets (`checkRecord`).
 * With `states`, the running instance is stopped first and the records are written while it is stopped, so it does
 * not save its own over them, and its views reconnect to an instance that has them
 */
export class WritePersonData {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport,
        private readonly states?: Pick<InstanceStates, 'stop'>
    ) {}

    async execute(input: WritePersonDataInput): Promise<WritePersonDataResult> {
        const { app, binding, records } = input;
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return this.finish({ kind: 'not-found', app });
        const declared: unknown = part.body.uses?.data?.[binding];
        if (!isJsonObject(declared) || declared['scope'] !== 'person' || typeof declared['model'] !== 'string') {
            return this.finish({ kind: 'not-person', app, binding });
        }
        const model = declared['model'];
        const body = { model, records } as unknown as UiPartBodies['data'];
        const source = await loadPartSource(this.parts, [{ kind: 'models', name: model }]);
        const errors = this.validator.validatePart('data', binding, body, source);
        if (!isValid(errors)) {
            this.report.info('Person data write', { app, binding, outcome: 'invalid', errorCount: errors.filter(isBlockingError).length });
            return { kind: 'invalid', errors };
        }
        const write = (): Promise<void> => this.instances.writeData(part.id, binding, { model, records });
        if (this.states === undefined) await write();
        else await this.states.stop(part, write);
        return this.finish({ kind: 'written', app, binding });
    }

    private finish(result: WritePersonDataResult): WritePersonDataResult {
        const named = result.kind === 'invalid' ? {} : { app: result.app, ...('binding' in result && { binding: result.binding }) };
        this.report.info('Person data write', { ...named, outcome: result.kind });
        return result;
    }
}
