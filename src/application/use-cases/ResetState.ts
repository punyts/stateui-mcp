import { isRevisionCurrent } from '../../domain/revision.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiInstanceRepository } from '../ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type ResetStateResult =
    | { readonly kind: 'reset'; readonly appId: string; readonly revision: number }
    | { readonly kind: 'persisted-app'; readonly appId: string }
    | { readonly kind: 'conflict'; readonly appId: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Puts an app's state back to its document: `$.data` is the document's data again and `$.app` has no articulation,
 * so a test run starts clean. The app's logic does not run for the reset and starts again after it. The revision
 * counts document writes, so it stays as it is
 */
export class ResetState {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, expectedRevision?: number): Promise<ResetStateResult> {
        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish({ kind: 'not-found', appId });
        if (app.sync === 'persisted') return this.finish({ kind: 'persisted-app', appId });
        if (!isRevisionCurrent(app.revision, expectedRevision)) return this.finish({ kind: 'conflict', appId, currentRevision: app.revision });
        const written = await this.repository.resetState(appId, app.revision);
        switch (written.kind) {
            case 'conflict':
                return this.finish({ kind: 'conflict', appId, currentRevision: written.currentRevision });
            case 'not-found':
                return this.finish({ kind: 'not-found', appId });
            case 'refused':
                // A reset asks no guard, so it is never refused
                return this.finish({ kind: 'reset', appId, revision: app.revision });
            case 'written':
                return this.finish({ kind: 'reset', appId, revision: written.revision });
        }
    }

    private finish(result: ResetStateResult): ResetStateResult {
        this.report.info('App state reset', { appId: result.appId, outcome: result.kind });
        return result;
    }
}

export type ResetInstanceResult = { readonly kind: 'reset'; readonly app: string } | { readonly kind: 'not-found'; readonly app: string };

/**
 * Puts the default persona's use of an owner app back to the definition: its instance (the diff) and the records of its
 * persona bindings are removed, so the next read is the definition. The definition and every part stay as they are
 */
export class ResetInstance {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(app: string): Promise<ResetInstanceResult> {
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return this.finish({ kind: 'not-found', app });
        await this.instances.reset(part.id);
        return this.finish({ kind: 'reset', app });
    }

    private finish(result: ResetInstanceResult): ResetInstanceResult {
        this.report.info('Instance reset', { app: result.app, outcome: result.kind });
        return result;
    }
}
