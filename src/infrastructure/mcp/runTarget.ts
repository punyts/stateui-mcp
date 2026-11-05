import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { DEFAULT_PERSONA } from '../../domain/InstanceKey.js';
import type { UiPart } from '../../domain/UiPart.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import { fail } from './toolKit.js';
import type { ToolOutcome } from './toolKit.js';

/** The fields every run-time tool takes to name what it runs on: an app part's instance (`app`), or an app of the old store (`appId`) */
export const RUN_APP_FIELDS = {
    app: { type: 'string', description: 'The app name (ui_list kind "apps"): the tool runs on the instance of the app, never on its definition' },
    appId: { type: 'string', uuid: true, description: 'An app of the old store, from ui_app_create or ui_app_list. Give app or appId' },
    persona: { type: 'string', description: `Whose instance of the app: only "${DEFAULT_PERSONA}" exists, and it is the default` }
} as const;

/** What a run-time tool runs on */
export type RunTarget =
    | {
          readonly kind: 'instance';
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
    | { readonly kind: 'stored'; readonly appId: string; readonly revision: number; readonly viewRevision: number };

export interface RunTargetDependencies {
    readonly useCases: Pick<UiBuilderUseCases, 'getApp' | 'findPartApp'>;
    /** The views of app parts; absent, `app` is refused */
    readonly instanceViews?: Pick<InstanceViews, 'view'>;
}

export type ResolveRunTarget = (args: { readonly app?: string; readonly appId?: string; readonly persona?: string }) => Promise<RunTarget | ToolOutcome>;

export function isRunTarget(value: RunTarget | ToolOutcome): value is RunTarget {
    return 'kind' in value;
}

/** How a result names what it ran on: `{ app }` for an instance, `{ appId }` for an app of the old store */
export function runName(target: RunTarget): { readonly app: string } | { readonly appId: string } {
    return target.kind === 'instance' ? { app: target.app } : { appId: target.appId };
}

/** Resolves `app` or `appId` (exactly one) and `persona` into what a run-time tool runs on, or the error to return */
export function runTargets(dependencies: RunTargetDependencies): ResolveRunTarget {
    const { useCases, instanceViews } = dependencies;
    return async ({ app, appId, persona }) => {
        if ((app === undefined) === (appId === undefined)) return fail('invalid-argument', 'Give exactly one of app (an app name) and appId', { argument: app === undefined ? 'app' : 'appId' });
        if (persona !== undefined && persona !== DEFAULT_PERSONA) {
            return fail('invalid-argument', `No persona "${persona}": only "${DEFAULT_PERSONA}" exists`, { argument: 'persona', personas: [DEFAULT_PERSONA] });
        }
        if (appId !== undefined) {
            const result = await useCases.getApp.execute(appId, { depth: 0 });
            if (result.kind !== 'found') return fail('not-found', 'No application with this id', { appId });
            return { kind: 'stored', appId, revision: result.revision, viewRevision: result.revision };
        }
        const name = app!;
        if (useCases.findPartApp === undefined || instanceViews === undefined) return fail('invalid-argument', 'This server keeps no app parts; give appId', { argument: 'app' });
        const found = await useCases.findPartApp.execute(name);
        if (found.kind === 'not-found') {
            return fail('not-found', `No app named "${name}"${found.nearest.length > 0 ? `; nearest: ${found.nearest.join(', ')}` : '; ui_list lists the apps'}`, {
                argument: 'app',
                nearest: found.nearest
            });
        }
        const view = await instanceViews.view(found.part);
        return { kind: 'instance', app: name, part: found.part, appId: found.part.id, revision: found.part.revision, viewRevision: view.revision, screens: view.screens };
    };
}
