import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import { isRunTarget, RUN_APP_FIELDS, runName, runTargets } from './runTarget.js';
import { READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const FILE_READ = defineInput({
    ...RUN_APP_FIELDS,
    fileId: { type: 'string', uuid: true, required: true, description: 'The file id from a file reference in ui_state_get or an emit payload' }
});

export interface FileToolDependencies {
    readonly useCases: Pick<UiBuilderUseCases, 'readFileText' | 'getApp' | 'findPartApp'>;
    /** The views of app parts; absent, only appId works */
    readonly instanceViews?: Pick<InstanceViews, 'view'>;
}

/** The file tool: read a file uploaded to an app part's instance (`app`) or to an app of the old store (`appId`) */
export function createFileTools(dependencies: FileToolDependencies): readonly UiToolDefinition[] {
    const { useCases, instanceViews } = dependencies;
    const resolve = runTargets({ useCases, ...(instanceViews !== undefined && { instanceViews }) });
    return [
        {
            name: 'ui_file_read',
            description:
                'Run time: read a file a user uploaded while using the app, to the instance of an app part (app) or to an app of the old store (appId). Reading changes nothing. Text, CSV, Markdown and JSON files return { file: { id, name, size, type }, text, truncated } with at most 256 KiB of text; other types return the reference with text null and a note.',
            inputSchema: FILE_READ.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = FILE_READ.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { fileId } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const result = await useCases.readFileText.execute(target.appId, fileId);
                if (result.kind === 'not-found') {
                    return fail('not-found', 'No file with this id in this application', { ...runName(target), fileId });
                }
                return succeed({
                    file: result.file,
                    text: result.text,
                    truncated: result.truncated,
                    ...(result.note !== undefined && { note: result.note })
                });
            }
        }
    ];
}
