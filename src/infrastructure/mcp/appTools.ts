import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { formatRenderedTree } from '../../application/outline/formatRenderedTree.js';
import { BrowserUnavailableError } from '../preview/BrowserPreview.js';
import type { PreviewBrowser } from '../preview/BrowserPreview.js';
import { PART_APP_FIELDS, SHELL_ARGUMENT, USES_TEXT, runPartAppCreate } from './partAppTools.js';
import { CREATES, READ_ONLY, defineInput, documentPath, fail, statePath, succeed } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';
import { isRunTarget, RUN_APP_FIELDS, runName, runTargets } from './runTarget.js';
import type { RunTargetDependencies } from './runTarget.js';

const APP_CREATE = defineInput({
    name: {
        type: 'string',
        required: true,
        description: 'The app name, unique among the apps: lower-case letters, digits and dashes, starting with a letter'
    },
    ...PART_APP_FIELDS,
    shell: { ...SHELL_ARGUMENT, required: true }
});

const VALIDATE = defineInput({
    app: { type: 'string', required: true, description: 'The app name from ui_list (kind "apps")' }
});

const TREE = defineInput({
    ...RUN_APP_FIELDS,
    screen: { type: 'string', description: 'Draw only this screen at the outlet (and, with rendered, open it first). Without it every screen' },
    content: { type: 'boolean', description: 'true: what the user sees (text, links, marks, record counts) instead of the structure with paths' },
    logic: { type: 'boolean', description: 'true adds the machines with their current state, the rules, guards and tables, those of the logic modules too' },
    path: { type: 'string', description: 'The node to start at, such as "$.app.children.main" or "$.screens.home.children.form"; without it the app root' },
    depth: { type: 'integer', minimum: 0, description: 'How many levels to show below path; deeper nodes are counted on the line of their ancestor' },
    paths: { type: 'boolean', description: 'false: leave the state path off each line, for a shorter tree. Default true' },
    rendered: {
        type: 'boolean',
        description:
            'true: list what the headless page draws instead of the document, with the runtime paths of rows and cards. Opens the headless page when none is open'
    }
});

function unknownScreen(screen: string, screens: readonly string[]): ToolOutcome {
    const known = screens.length > 0 ? `its screens: ${screens.join(', ')}` : 'it has no screens';
    return fail('invalid-argument', `The app has no screen "${screen}"; ${known}`, { argument: 'screen', screens });
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

/** The app tools: create, validate and the tree */
export function createAppTools(
    useCases: Pick<UiBuilderUseCases, 'createPartApp' | 'validatePartApp' | 'outlinePartApp' | 'findPartApp'>,
    /** The headless page, for ui_tree with rendered: true; absent, that answers browser-unavailable */
    browser: Pick<PreviewBrowser, 'rendered' | 'open'> | undefined,
    /** The views of app parts */
    instanceViews: RunTargetDependencies['instanceViews']
): readonly UiToolDefinition[] {
    const resolve = runTargets({ useCases, instanceViews });
    return [
        {
            name: 'ui_app_create',
            description:
                `Build time: create an app of the owner's parts, with a title, the parts it uses and a shell. It starts with one screen, home, its start screen, and ui_screen_create adds more. ${USES_TEXT}. Here themes, data and logic are the three parts of uses. The app is checked as a whole first: a part that does not exist comes back with the nearest names, an error with its part and path, and nothing is created. Returns { name, id, revision, start, slots, warnings }: slots are the shell pattern's places to fill, each { name, path, description } with the node path for ui_nodes_write (none for a node tree).`,
            inputSchema: APP_CREATE.schema,
            annotations: CREATES,
            run: async (args) => {
                const parsed = APP_CREATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                return runPartAppCreate(useCases.createPartApp, parsed.value);
            }
        },
        {
            name: 'ui_validate',
            description:
                'Build time: validate an app of parts, assembled with every part it uses. Returns { app, revision, valid, errors, warnings, uses }: each error and warning has a code and the state path it concerns, and names the part that holds it, and uses lists the parts the app names.',
            inputSchema: VALIDATE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = VALIDATE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { app } = parsed.value;
                const part = await useCases.validatePartApp.execute(app);
                if (part.kind === 'not-found') return fail('not-found', `No app named "${app}"; ui_list lists the apps`, { app });
                return succeed({ app: part.app, revision: part.revision, valid: part.valid, errors: part.errors, warnings: part.warnings, uses: part.uses });
            }
        },
        {
            name: 'ui_tree',
            description:
                'Run time: show the instance of an app part as a nested list, one line per node, two spaces per level: the shell, with the screens drawn at its outlet (one screen takes the outlet\'s place; several are listed under it by name), each screen node with its own path ($.screens.home.children.form); screen draws only that screen. Default: the structure, key (component) and path per node, bullets alternating - and *; [slot] marks a node held by a slot property (a footer, a row template), and a row template draws once per record. content: true shows what the user sees instead: component, key, text, links, hidden or closed marks and record counts (no data values). logic: true adds the logic after the tree: each machine with its current state in the instance, then the rules, guards and tables, the units of a logic module named with the module as prefix (cart:totals). rendered: true lists what the headless page draws: each row and card with its runtime path (such as ...board.cols.k_open.body.main.slots.0) and each interactive shape of a drawing (...rows.<recordKey> for a drawRepeat copy), the path ui_interact and ui_screenshot need; a node with no box is (hidden) and its subtree is counted. path starts at a node, depth limits the levels, paths: false leaves the paths off. Capped at 400 lines. Returns { app, revision, text, lineCount, cutLines, nodeCount?, screens? }.',
            inputSchema: TREE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = TREE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { screen, content, logic, path, depth, paths, rendered } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                if (screen !== undefined && !target.screens.includes(screen)) return unknownScreen(screen, target.screens);
                if (rendered === true) {
                    if (content === true || logic === true) return fail('invalid-argument', 'rendered lists what the page draws; leave content and logic out', { argument: 'rendered' });
                    if (browser === undefined) return fail('browser-unavailable', 'This server has no headless browser, so it cannot list what the page draws');
                    const under = path === undefined ? '$.app' : statePath(path);
                    try {
                        if (screen !== undefined) await browser.open(target.appId, target.viewRevision, { screen });
                        const nodes = await browser.rendered(target.appId, target.viewRevision, under);
                        if (nodes.length === 0) {
                            return fail('not-rendered', `The page draws nothing at ${under}; check the path with ui_tree, and open what holds it (a tab, a drawer, a screen)`, { ...runName(target), path: under });
                        }
                        const tree = formatRenderedTree({ nodes, depth, paths: paths !== false });
                        return succeed({ ...runName(target), revision: target.revision, text: tree.text, lineCount: tree.lineCount, cutLines: tree.cutLines, nodeCount: tree.nodeCount });
                    } catch (error) {
                        if (error instanceof BrowserUnavailableError) return fail('browser-unavailable', error.message);
                        throw error;
                    }
                }
                const at = {
                    ...(path !== undefined && { path: documentPath(path) }),
                    ...(depth !== undefined && { depth }),
                    ...(paths !== undefined && { paths })
                };
                const result = await useCases.outlinePartApp.execute(target.part, {
                    ...at,
                    ...(screen !== undefined && { screen }),
                    ...(content !== undefined && { content }),
                    ...(logic !== undefined && { logic })
                });
                const name = { app: target.app };
                switch (result.kind) {
                    case 'outline':
                        return succeed({
                            ...name,
                            revision: target.revision,
                            text: result.text,
                            lineCount: result.lineCount,
                            cutLines: result.cutLines,
                            ...(result.nodeCount !== undefined && { nodeCount: result.nodeCount }),
                            screens: result.screens
                        });
                    case 'unknown-screen':
                        return unknownScreen(screen ?? '', result.screens);
                    case 'invalid-path':
                        return fail('invalid-path', result.reason, name);
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { ...name, path: result.path, missingAt: result.missingAt });
                    case 'not-a-node':
                        return fail('not-a-node', `${result.path} is not a node, so it has no tree`, { ...name, path: result.path });
                    case 'invalid-input':
                        return fail('invalid-argument', result.message, name);
                }
            }
        }
    ];
}
