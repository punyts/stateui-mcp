import type { PartKind } from '../../domain/partName.js';
import { partReferences } from '../../domain/partReferences.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isBlockingError, isValid } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { loadPartSource } from '../partSource.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { UsageSource } from '../UsageIndex.js';

/** At most this many dependent apps are named in `warnings`; `moreApps` counts the rest */
export const MAX_WARNED_APPS = 20;
/** At most this many invalid record keys are named per dataset */
export const MAX_WARNED_RECORDS = 10;

export interface WritePartInput<K extends PartKind> {
    readonly kind: K;
    readonly name: string;
    readonly body: UiPartBodies[K];
    /** Absent: the first write, which creates the part. Present: the revision the caller read */
    readonly expectedRevision?: number;
}

/** A dependent app that the write leaves with errors */
export interface AppWarning {
    readonly app: string;
    readonly errors: readonly UiBuildError[];
}

/** A dataset whose records no longer fit the model just written */
export interface DatasetWarning {
    readonly dataset: string;
    /** The first invalid record keys, in record order */
    readonly keys: readonly string[];
    readonly invalidCount: number;
}

export type WritePartResult =
    | {
          readonly kind: 'written';
          readonly revision: number;
          /** The apps the write breaks, by name, at most `MAX_WARNED_APPS` */
          readonly warnings: readonly AppWarning[];
          /** How many more apps it breaks */
          readonly moreApps: number;
          /** With a model write: the datasets of that model whose records no longer fit */
          readonly datasetWarnings: readonly DatasetWarning[];
      }
    /** The part's own errors; nothing was written */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'duplicate-name' };

function recordKey(error: UiBuildError): string | undefined {
    const match = /^\$\.records\.([^.]+)/.exec(error.statePath ?? '');
    return match?.[1];
}

/**
 * Writes one part: checks it on its own (the reader of its kind) and refuses it with its errors; writes it with
 * `expectedRevision`, or creates it when there is none; then checks every app that reaches it (`appsUsing`) and returns
 * the ones it breaks as warnings. A model write also checks the records of each dataset of that model
 */
export class WritePart {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly usage: UsageSource,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute<K extends PartKind>(input: WritePartInput<K>): Promise<WritePartResult> {
        const { kind, name, body } = input;
        const own = await loadPartSource(this.parts, partReferences(kind, body));
        const errors = this.validator.validatePart(kind, name, body, own);
        if (!isValid(errors)) {
            this.report.info('Part write', { kind, name, outcome: 'invalid', errorCount: errors.filter(isBlockingError).length });
            return { kind: 'invalid', errors };
        }

        const written = await this.store(input);
        if (written.kind !== 'written') {
            this.report.info('Part write', { kind, name, outcome: written.kind });
            return written;
        }

        const index = await this.usage.usage();
        const broken: AppWarning[] = [];
        for (const app of index.appsUsing(kind, name)) {
            const appErrors = await this.appErrors(app);
            if (appErrors.length > 0) broken.push({ app, errors: appErrors });
        }
        const datasetWarnings = kind === 'models' ? await this.datasetWarnings(name, index.usedBy('models', name)) : [];
        const warnings = broken.slice(0, MAX_WARNED_APPS);
        this.report.info('Part write', {
            kind,
            name,
            outcome: 'written',
            revision: written.revision,
            brokenApps: broken.length,
            brokenDatasets: datasetWarnings.length
        });
        return { kind: 'written', revision: written.revision, warnings, moreApps: broken.length - warnings.length, datasetWarnings };
    }

    private async store<K extends PartKind>(input: WritePartInput<K>): Promise<WritePartResult | { readonly kind: 'written'; readonly revision: number }> {
        if (input.expectedRevision === undefined) {
            const created = await this.parts.create({ kind: input.kind, name: input.name, body: input.body });
            if (created.kind === 'created') return { kind: 'written', revision: created.part.revision };
            return created.kind === 'invalid' ? { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: created.reason }] } : created;
        }
        const result = await this.parts.write(input.kind, input.name, input.body, input.expectedRevision);
        return result.kind === 'invalid' ? { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: result.reason }] } : result;
    }

    /** The blocking errors of one stored app, assembled with what it reaches now */
    private async appErrors(app: string): Promise<readonly UiBuildError[]> {
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return [];
        const source = await loadPartSource(this.parts, partReferences('apps', part.body));
        return this.validator.validateAssembled(part.body, source, app).filter(isBlockingError);
    }

    private async datasetWarnings(model: string, users: ReadonlyArray<{ readonly kind: PartKind; readonly name: string }>): Promise<DatasetWarning[]> {
        const warnings: DatasetWarning[] = [];
        for (const user of users) {
            if (user.kind !== 'data') continue;
            const dataset = await this.parts.findByName('data', user.name);
            if (dataset === undefined || dataset.body.model !== model) continue;
            const source = await loadPartSource(this.parts, [{ kind: 'models', name: model }]);
            const keys = [...new Set(this.validator.validatePart('data', user.name, dataset.body, source).filter(isBlockingError).flatMap((error) => recordKey(error) ?? []))];
            if (keys.length > 0) warnings.push({ dataset: user.name, keys: keys.slice(0, MAX_WARNED_RECORDS), invalidCount: keys.length });
        }
        return warnings;
    }
}
