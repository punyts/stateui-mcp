import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { READ_ONLY, defineInput, fail, succeed } from './toolKit.js';
import type { UiToolDefinition } from './toolKit.js';

const FILE_READ = defineInput({
    appId: { type: 'string', uuid: true, required: true, description: 'The application the file was uploaded to' },
    fileId: { type: 'string', uuid: true, required: true, description: 'The file id from a file reference in ui_state_get or an emit payload' }
});

/** The file tool: read an uploaded file of an app */
export function createFileTools(useCases: Pick<UiBuilderUseCases, 'readFileText'>): readonly UiToolDefinition[] {
    return [
        {
            name: 'ui_file_read',
            description:
                'Read a file the user uploaded to an application. Text, CSV, Markdown and JSON files return { file: { id, name, size, type }, text, truncated } with at most 256 KiB of text; other types return the reference with text null and a note.',
            inputSchema: FILE_READ.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = FILE_READ.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { appId, fileId } = parsed.value;
                const result = await useCases.readFileText.execute(appId, fileId);
                if (result.kind === 'not-found') {
                    return fail('not-found', 'No file with this id in this application', { appId, fileId });
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
