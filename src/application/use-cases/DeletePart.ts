import type { PartRef } from '@punyts/stateui-app/core';
import { nearestNames } from '../../domain/nearestNames.js';
import type { PartKind } from '../../domain/partName.js';
import { appWithoutScreen } from '../../domain/renameReferences.js';
import { deleteRule } from '../deleteRule.js';
import type { AppFolderStore } from '../ports/AppFolderStore.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiInstanceRepository } from '../ports/UiInstanceRepository.js';
import type { UiPart } from '../../domain/UiPart.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { UsageSource } from '../UsageIndex.js';

/** A part, or a screen of an app (a write of the app, so it takes the app's revision) */
export type DeletePartInput =
    | { readonly kind: PartKind; readonly name: string; readonly expectedRevision: number }
    | { readonly kind: 'screens'; readonly app: string; readonly name: string; readonly expectedRevision: number };

export type DeletePartResult =
    /** `id` is the deleted part's (for a screen, its app's); `revision` the deleted part's, or the app's new one */
    | { readonly kind: 'deleted'; readonly id: string; readonly revision: number }
    /** Something uses the part, or the screen is its app's `start`; nothing was deleted */
    | { readonly kind: 'in-use'; readonly reason: string; readonly users: readonly PartRef[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    /** `nearest` are app names when `missingApp` (a screen's app) is set */
    | { readonly kind: 'not-found'; readonly nearest: readonly string[]; readonly missingApp?: string };

/** What deleting an app removes besides the part: its running instance, the stored instance and persona records, and its side folder */
export interface AppCleanup {
    readonly instances: Pick<UiInstanceRepository, 'reset'>;
    readonly folder: AppFolderStore;
    /** The running instances: the one of the deleted app is stopped first, so it cannot save its state again */
    readonly states?: Pick<InstanceStates, 'stop'>;
}

/**
 * Deletes a part while nothing uses it (`deleteRule`), or a screen that is not its app's `start`, with the revision the
 * caller read. Deleting an app also stops its running instance and removes its default persona's instance and persona
 * records, which are keyed by its id, and its side folder (preview errors and uploaded files)
 */
export class DeletePart {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly usage: UsageSource,
        private readonly report: UseCaseReport,
        private readonly cleanup?: AppCleanup
    ) {}

    async execute(input: DeletePartInput): Promise<DeletePartResult> {
        const result = input.kind === 'screens' ? await this.deleteScreen(input) : await this.deletePart(input);
        this.report.info('Part delete', { kind: input.kind, outcome: result.kind });
        return result;
    }

    private async deletePart(input: { readonly kind: PartKind; readonly name: string; readonly expectedRevision: number }): Promise<DeletePartResult> {
        const { kind, name, expectedRevision } = input;
        const part = await this.parts.findByName(kind, name);
        if (part === undefined) return { kind: 'not-found', nearest: nearestNames(name, (await this.parts.list(kind)).map((summary) => summary.name)) };
        if (part.revision !== expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
        const ruling = deleteRule(await this.usage.usage(), { kind, name });
        if (ruling.kind === 'refused') return { kind: 'in-use', reason: ruling.reason, users: ruling.users };
        const deleted = await this.parts.delete(kind, name, expectedRevision);
        if (deleted.kind === 'conflict') return deleted;
        if (deleted.kind === 'not-found') return { kind: 'not-found', nearest: [] };
        if (kind === 'apps') await this.removeAppData(part as UiPart<'apps'>);
        return { kind: 'deleted', id: part.id, revision: part.revision };
    }

    /** The part is gone, so nothing can start its instance or add to its folder again: stop it, then remove what it kept */
    private async removeAppData(part: UiPart<'apps'>): Promise<void> {
        const cleanup = this.cleanup;
        if (cleanup === undefined) return;
        const remove = async (): Promise<void> => {
            await cleanup.instances.reset(part.id);
            await cleanup.folder.remove(part.id);
        };
        if (cleanup.states === undefined) await remove();
        else await cleanup.states.stop(part, remove);
    }

    private async deleteScreen(input: { readonly app: string; readonly name: string; readonly expectedRevision: number }): Promise<DeletePartResult> {
        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined) return { kind: 'not-found', missingApp: input.app, nearest: nearestNames(input.app, (await this.parts.list('apps')).map((part) => part.name)) };
        const body = appWithoutScreen(app.body, input.name);
        if (body === undefined) return { kind: 'not-found', nearest: nearestNames(input.name, Object.keys(app.body.screens ?? {})) };
        if (app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        const ruling = deleteRule(await this.usage.usage(), { kind: 'screens', app: input.app, name: input.name });
        if (ruling.kind === 'refused') return { kind: 'in-use', reason: ruling.reason, users: ruling.users };
        const written = await this.parts.write('apps', input.app, body, input.expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'deleted', id: app.id, revision: written.revision };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', missingApp: input.app, nearest: [] };
            case 'invalid':
                throw new Error(`The app "${input.app}" without the screen "${input.name}" was refused: ${written.reason}`);
        }
    }
}
