import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { LiveViews } from '../preview/LiveViews.js';
import { DESTROYS, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const APP_DELETE = defineInput({
    appId: { type: 'string', uuid: true, required: true, description: 'The application id from ui_app_list' },
    expectedRevision: {
        type: 'integer',
        minimum: 1,
        required: true,
        description: 'The revision you last read. When the app has changed since, nothing is deleted and the result says the current revision'
    }
});

/**
 * The delete tool. There is no approval step in this server: the MCP client is the place to ask the user, and it can
 * see the `destructiveHint` annotation. `expectedRevision` is required, so a delete never removes unseen edits
 */
export function createDeleteTools(useCases: Pick<UiBuilderUseCases, 'deleteApp'>, live: Pick<LiveViews, 'deleted'>): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_app_delete',
            description:
                'Delete an application, its state, error log and uploaded files for good. Ask the user first: a deleted application cannot be restored. expectedRevision is required, so a delete never removes edits you have not seen: on a conflict nothing is deleted. Open views of the app are closed. Returns { appId, revision } with the revision that was deleted.',
            inputSchema: APP_DELETE.schema,
            annotations: DESTROYS,
            run: async (args) => {
                const parsed = APP_DELETE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { appId, expectedRevision } = parsed.value;
                const result = await useCases.deleteApp.execute(appId, expectedRevision);
                switch (result.kind) {
                    case 'deleted':
                        await live.deleted(result.appId);
                        return succeed({ appId: result.appId, revision: result.revision });
                    case 'conflict':
                        return fail('conflict', `The application is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_app_get; nothing was deleted`, {
                            appId: result.appId,
                            currentRevision: result.currentRevision
                        });
                    case 'not-found':
                        return fail('not-found', 'No application with this id', { appId: result.appId });
                }
            }
        }
    ];
}
