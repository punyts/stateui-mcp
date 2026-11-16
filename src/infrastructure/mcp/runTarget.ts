import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { DEFAULT_PERSONA } from '../../domain/InstanceKey.js';
import type { UiPart } from '../../domain/UiPart.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import { fail } from './toolKit.js';
import type { ToolOutcome } from './toolKit.js';

/** The fields every run-time tool takes to name what it runs on: an app part's instance */
export const RUN_APP_FIELDS = {
    app: { type: 'string', required: true, description: 'The app name (ui_list kind "apps"): the tool runs on the instance of the app, never on its definition' },
    persona: { type: 'string', description: `Whose instance of the app: only "${DEFAULT_PERSONA}" exists, and it is the default` }
} as const;

/** What a run-time tool runs on: the default persona's instance of an app part */
export interface RunTarget {
    readonly app: string;
    readonly part: UiPart<'apps'>;
    /** The part id: the views, events and calls of the instance are keyed by it */
    readonly appId: string;
    /** The app part's revision, which using the app never raises */
    readonly revision: number;
    /** The revision of the document the instance's views show; the browser waits for it */
    readonly viewRevision: number;
    readonly screens: readonly string[];
}

export interface RunTargetDependencies {
    readonly useCases: Pick<UiBuilderUseCases, 'findPartApp'>;
    /** The views of app parts */
    readonly instanceViews: Pick<InstanceViews, 'view'>;
}

export type ResolveRunTarget = (args: { readonly app: string; readonly persona?: string }) => Promise<RunTarget | ToolOutcome>;

export function isRunTarget(value: RunTarget | ToolOutcome): value is RunTarget {
    return 'part' in value;
}

/** How a result names what it ran on */
export function runName(target: RunTarget): { readonly app: string } {
    return { app: target.app };
}

/** Resolves `app` and `persona` into what a run-time tool runs on, or the error to return */
export function runTargets(dependencies: RunTargetDependencies): ResolveRunTarget {
    const { useCases, instanceViews } = dependencies;
    return async ({ app, persona }) => {
        if (persona !== undefined && persona !== DEFAULT_PERSONA) {
            return fail('invalid-argument', `No persona "${persona}": only "${DEFAULT_PERSONA}" exists`, { argument: 'persona', personas: [DEFAULT_PERSONA] });
        }
        const found = await useCases.findPartApp.execute(app);
        if (found.kind === 'not-found') {
            return fail('not-found', `No app named "${app}"${found.nearest.length > 0 ? `; nearest: ${found.nearest.join(', ')}` : '; ui_list lists the apps'}`, {
                argument: 'app',
                nearest: found.nearest
            });
        }
        const view = await instanceViews.view(found.part);
        return { app, part: found.part, appId: found.part.id, revision: found.part.revision, viewRevision: view.revision, screens: view.screens };
    };
}
