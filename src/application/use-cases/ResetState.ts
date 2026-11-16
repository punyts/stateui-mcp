import { isRevisionCurrent } from '../../domain/revision.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiInstanceRepository } from '../ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type ResetInstanceResult =
    /** `revision` is the app part's: a reset does not raise it */
    | { readonly kind: 'reset'; readonly app: string; readonly revision: number }
    | { readonly kind: 'conflict'; readonly app: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly app: string };

/**
 * Puts the default persona's use of an owner app back to the definition: its instance (the diff) and the records of its
 * persona bindings are removed, so the next read is the definition. The definition and every part stay as they are.
 * With `states`, the running instance is stopped first and the removal runs while it is stopped, so its views
 * reconnect to an instance of the definition and its logic starts again
 */
export class ResetInstance {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly report: UseCaseReport,
        private readonly states?: Pick<InstanceStates, 'stop'>
    ) {}

    async execute(app: string, expectedRevision?: number): Promise<ResetInstanceResult> {
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return this.finish({ kind: 'not-found', app });
        if (!isRevisionCurrent(part.revision, expectedRevision)) return this.finish({ kind: 'conflict', app, currentRevision: part.revision });
        const reset = (): Promise<void> => this.instances.reset(part.id);
        if (this.states === undefined) await reset();
        else await this.states.stop(part, reset);
        return this.finish({ kind: 'reset', app, revision: part.revision });
    }

    private finish(result: ResetInstanceResult): ResetInstanceResult {
        this.report.info('Instance reset', { app: result.app, outcome: result.kind });
        return result;
    }
}
