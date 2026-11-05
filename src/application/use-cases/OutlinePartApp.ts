import { parseDocumentPath, resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isNodeValue } from '../../domain/nodeDepth.js';
import type { UiPart } from '../../domain/UiPart.js';
import { formatLogic } from '../outline/formatLogic.js';
import { formatOutline } from '../outline/formatOutline.js';
import type { OutlineScreen } from '../outline/formatOutline.js';
import { formatTree } from '../outline/formatTree.js';
import type { TreeScreen } from '../outline/formatTree.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface OutlinePartAppInput {
    /** One screen to draw at the shell's outlet; absent, all of them */
    readonly screen?: string;
    /** A dotted path to a node of the running app (`app.children.main`, `screens.home.children.form`); absent, the shell */
    readonly path?: string;
    /** How many `children` levels to show below the first node */
    readonly depth?: number;
    /** True: the content outline (text, links, marks, record counts); false: the structure with state paths */
    readonly content?: boolean;
    /** True: the logic follows, with each machine's current state in the instance */
    readonly logic?: boolean;
    /** For the structure: false leaves the state paths off. Default true */
    readonly paths?: boolean;
}

export type OutlinePartAppResult =
    | {
          readonly kind: 'outline';
          readonly text: string;
          readonly lineCount: number;
          readonly cutLines: number;
          /** For the structure: how many nodes it shows */
          readonly nodeCount?: number;
          /** The screens drawn at the outlet */
          readonly screens: readonly string[];
      }
    | { readonly kind: 'unknown-screen'; readonly screens: readonly string[] }
    | { readonly kind: 'invalid-path'; readonly reason: string }
    | { readonly kind: 'missing-path'; readonly path: string; readonly missingAt: string }
    | { readonly kind: 'not-a-node'; readonly path: string }
    | { readonly kind: 'invalid-input'; readonly message: string };

const DATA_PREFIX = '$.data.';

function objectAt(value: JsonValue | undefined, key: string): JsonObject | undefined {
    if (!isJsonObject(value)) return undefined;
    const found = value[key];
    return isJsonObject(found) ? found : undefined;
}

/**
 * The structure or the content of an app of parts as its default persona's instance runs it: the shell, with the
 * screens drawn at its outlet under their own state paths (`$.screens.{name}`), and, when asked, the logic of the app
 * and of its modules (module units carry their module's name as a prefix, `cart:totals`), each machine in its current
 * state. Marks and record counts follow the instance's state. Reuses the formatters of `OutlineApp`
 */
export class OutlinePartApp {
    constructor(
        private readonly states: Pick<InstanceStates, 'shape' | 'state'>,
        private readonly validator: Pick<UiAppValidator, 'resolveNode'>,
        private readonly report: UseCaseReport
    ) {}

    async execute(part: UiPart<'apps'>, input: OutlinePartAppInput = {}): Promise<OutlinePartAppResult> {
        const result = await this.outline(part, input);
        this.report.info('App part outline', { app: part.name, outcome: result.kind, ...(result.kind === 'outline' && { lineCount: result.lineCount }) });
        return result;
    }

    private async outline(part: UiPart<'apps'>, input: OutlinePartAppInput): Promise<OutlinePartAppResult> {
        const { depth } = input;
        if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) return { kind: 'invalid-input', message: 'depth must be a whole number of zero or more' };
        const { document } = await this.states.shape(part);
        const allScreens = Object.keys(isJsonObject(document['screens']) ? document['screens'] : {});
        if (input.screen !== undefined && !allScreens.includes(input.screen)) return { kind: 'unknown-screen', screens: allScreens };
        const shown = input.screen === undefined ? allScreens : [input.screen];

        const text = input.path ?? '';
        const parsed = parseDocumentPath(text);
        if (!parsed.ok) return { kind: 'invalid-path', reason: parsed.reason };
        const state = await this.states.state(part);
        // A node of a screen is at $.screens.{name}... while it runs, and at screens.{name}.root... in the document
        const at = parsed.path.length === 0 ? ['app'] : parsed.path;
        const segments = at[0] === 'screens' && at.length >= 2 ? ['screens', at[1] as string, 'root', ...at.slice(2)] : at;
        const found = resolveDocumentPath(document, segments);
        if (!found.found) return { kind: 'missing-path', path: text, missingAt: segments.slice(0, found.missingAt + 1).join('.') };
        const root = this.validator.resolveNode(document, segments);
        if (root === undefined || !isNodeValue(root)) return { kind: 'not-a-node', path: text };

        const statePath = `$.${at.join('.')}`;
        const inScreen = at[0] === 'screens';
        const trailer = input.logic === true ? formatLogic(document['logic'], (path) => this.stateAt(state, path)) : [];
        const resolved = shown.flatMap((name) => {
            const node = this.validator.resolveNode(document, ['screens', name, 'root']);
            return node === undefined ? [] : [{ name, node }];
        });

        if (input.content !== true) {
            const screens: TreeScreen[] = resolved.map(({ name, node }) => ({ name, root: node, path: `$.screens.${name}` }));
            const tree = formatTree({ root, rootKey: at[at.length - 1] as string, rootPath: statePath, depth, paths: input.paths !== false, screens, trailer });
            return { kind: 'outline', text: tree.text, lineCount: tree.lineCount, cutLines: tree.cutLines, nodeCount: tree.nodeCount, screens: shown };
        }
        const liveScreens = objectAt(state, 'screens');
        const screens: OutlineScreen[] = resolved.map(({ name, node }) => ({ name, root: node, snapshot: objectAt(liveScreens, name) }));
        const data = state['data'];
        const outline = formatOutline({
            root,
            rootKey: parsed.path.length === 0 ? undefined : (at[at.length - 1] as string),
            appPath: inScreen ? at.slice(2) : at.slice(1),
            overlay: undefined,
            snapshotApp: inScreen ? objectAt(liveScreens, at[1] as string) : objectAt(state, 'app'),
            recordCount: (target) => this.countRecords(data, target),
            depth,
            trailer,
            screens
        });
        return { kind: 'outline', text: outline.text, lineCount: outline.lineCount, cutLines: outline.cutLines, screens: shown };
    }

    /** A state path such as a machine's, read from the instance's state */
    private stateAt(state: JsonObject, path: string): JsonValue | undefined {
        if (!path.startsWith('$.')) return undefined;
        const found = resolveDocumentPath(state, path.slice(2).split('.'));
        return found.found ? found.value : undefined;
    }

    private countRecords(data: JsonValue | undefined, target: string): number | undefined {
        if (data === undefined || !target.startsWith(DATA_PREFIX)) return undefined;
        const found = resolveDocumentPath(data, target.slice(DATA_PREFIX.length).split('.'));
        if (!found.found) return undefined;
        if (Array.isArray(found.value)) return (found.value as readonly JsonValue[]).length;
        return isJsonObject(found.value) ? Object.keys(found.value as JsonObject).length : undefined;
    }
}
