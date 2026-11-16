import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { MissingPart } from '../../application/partAppCheck.js';
import type { IconOperation } from '../../application/use-cases/WriteIcons.js';
import type { LocaleOperation } from '../../application/use-cases/WriteLocale.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import { treePath, APP_TREE } from '../../domain/nodeOperations.js';
import type { NodeOperation, TreeTarget } from '../../domain/nodeOperations.js';
import { PART_KIND_WORDS } from '../../domain/partReferences.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { WRITES, defineInput, fail, succeed, withGuides } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';

const APP = { type: 'string', required: true, description: 'The app name from ui_list (kind "apps")' } as const;
const SCREEN = {
    type: 'string',
    required: true,
    description: 'The tree to write: a screen name of the app (ui_list kind "screens"), or "app" for the app node (its layout, toasts and app events)'
} as const;
const EXPECTED = {
    type: 'integer',
    minimum: 1,
    required: true,
    description: 'The app revision you last read (a screen and the app node are parts of their app). When it has changed since, nothing is written'
} as const;
const PATH_TEXT =
    'A path in the tree that starts with root, such as "root.children.hero._title" ("root" is the screen\'s root node, or the app node). The run-time form also works: "$.screens.product.children.buy" for a screen, "$.app.toasts" for the app node';

const NODE_ITEMS = {
    op: {
        type: 'string',
        required: true,
        enum: ['add', 'set', 'remove', 'merge', 'move'],
        description:
            'add puts a node into the children of the node at path (under key, or a key made from its component), set replaces or appends a key, remove deletes it, merge deep-merges an object and creates missing keys, move relocates a keyed entry with its subtree and key'
    },
    path: { type: 'string', required: true, description: `${PATH_TEXT}. For add: the parent node. For move: the entry to move` },
    value: { type: 'json', description: 'The node for add; the new value for set; an object for merge; not allowed for remove or move' },
    key: { type: 'string', description: 'add only: the key of the new child; letters first, never integer-like ("o42", not "42"). Without it the component name, then name2, name3...' },
    to: { type: 'string', description: 'move only: the keyed map to move the entry into, such as "root.children.panel.children"; it goes at the end unless before or after is given' },
    before: { type: 'string', description: 'add and move: a sibling key to place the entry before' },
    after: { type: 'string', description: 'add and move: a sibling key to place the entry after' }
} as const;

const NODES_WRITE = defineInput({
    app: APP,
    screen: SCREEN,
    expectedRevision: EXPECTED,
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The changes, applied in order as one checked write (at most ${MAX_OPERATIONS_PER_WRITE}). Nothing is written unless the whole app is valid`,
        items: NODE_ITEMS
    }
});

const LOCALE_ITEMS = {
    op: { type: 'string', required: true, enum: ['set', 'remove'], description: 'set writes the text of a content path, remove takes it out of the overlay' },
    path: { type: 'string', required: true, description: `A content path: ${PATH_TEXT}, ending in a content property such as "_title" or "_text"` },
    value: { type: 'json', description: 'set only: the translated text (or content map)' }
} as const;

const LOCALE_WRITE = defineInput({
    app: APP,
    screen: SCREEN,
    language: { type: 'string', required: true, description: 'A language code such as "de" or "pt-BR"' },
    expectedRevision: EXPECTED,
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: 'The texts set or removed, as one checked write',
        items: LOCALE_ITEMS
    }
});

const ICON_ITEMS = {
    op: { type: 'string', required: true, enum: ['set', 'remove'], description: 'set adds the icon or replaces it whole, remove takes it out of the app' },
    name: {
        type: 'string',
        required: true,
        description: 'The icon name: lower-case letters, digits and dashes, such as "chat" or "zoom-fit". It wins over an icon of the same name in ui_icons_list'
    },
    outline: {
        type: 'json',
        schema: { type: 'array', items: {} },
        description:
            'set only: the outline paths in a 24×24 view box, each the d of an SVG <path> ("M4 5h16v11H9l-5 4z") or { d, fill: true, stroke: false, opacity } for a part the icon fills. They are stroked round with the icon stroke of the theme. Path data only: a circle or rect is written as a path (a circle of radius 8 at 12,12 is "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0")'
    },
    filled: { type: 'json', schema: { type: 'array', items: {} }, description: 'set only, optional: the paths of a filled variant, drawn when a node sets filled: true' }
} as const;

const ICONS_WRITE = defineInput({
    app: APP,
    expectedRevision: EXPECTED,
    operations: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: 'The icons set or removed, in order, as one checked write',
        items: ICON_ITEMS
    }
});

type IconItem = ParsedArguments<typeof ICON_ITEMS>;

/** One parsed item as an icon operation, or the argument error for a field the operation does not take */
function toIconOperation(item: IconItem, index: number): IconOperation | ToolOutcome {
    if (item.op === 'remove') {
        for (const name of ['outline', 'filled'] as const) if (item[name] !== undefined) return misplaced(index, name, 'is not allowed for remove');
        return { op: 'remove', name: item.name };
    }
    if (!Array.isArray(item.outline)) return misplaced(index, 'outline', 'is required for set: a list of path data');
    if (item.filled !== undefined && !Array.isArray(item.filled)) return misplaced(index, 'filled', 'must be a list of path data');
    return { op: 'set', name: item.name, outline: item.outline as never, ...(item.filled !== undefined && { filled: item.filled as never }) };
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

function misplaced(index: number, name: string, message: string): ToolOutcome {
    return fail('invalid-argument', `operations[${index}].${name} ${message}`, { argument: `operations[${index}].${name}` });
}

function targetOf(screen: string): TreeTarget {
    return screen === APP_TREE ? { kind: 'app' } : { kind: 'screen', screen };
}

/** A path made relative to the tree, or the argument error for a path of another tree */
function relative(text: string, target: TreeTarget, index: number, name: string): string | ToolOutcome {
    const path = treePath(text, target);
    if (path !== undefined) return path;
    const where = target.kind === 'app' ? 'the app node ("root..." or "$.app...")' : `the screen "${target.screen}" ("root..." or "$.screens.${target.screen}...")`;
    return misplaced(index, name, `is not a path in ${where}`);
}

type NodeItem = ParsedArguments<typeof NODE_ITEMS>;

/** One parsed item as a node operation, or the argument error for a field the operation does not take */
function toNodeOperation(item: NodeItem, index: number, target: TreeTarget): NodeOperation | ToolOutcome {
    const path = relative(item.path, target, index, 'path');
    if (typeof path !== 'string') return path;
    if (item.key !== undefined && item.op !== 'add') return misplaced(index, 'key', `is only allowed for add, not ${item.op}`);
    if (item.to !== undefined && item.op !== 'move') return misplaced(index, 'to', `is only allowed for move, not ${item.op}`);
    if (item.op !== 'add' && item.op !== 'move') {
        for (const name of ['before', 'after'] as const) if (item[name] !== undefined) return misplaced(index, name, `is only allowed for add and move, not ${item.op}`);
    }
    const place = { ...(item.before !== undefined && { before: item.before }), ...(item.after !== undefined && { after: item.after }) };
    switch (item.op) {
        case 'move': {
            if (item.value !== undefined) return misplaced(index, 'value', 'is not allowed for move');
            const to = item.to === undefined ? undefined : relative(item.to, target, index, 'to');
            if (to !== undefined && typeof to !== 'string') return to;
            return { op: 'move', path, ...(to !== undefined && { to }), ...place };
        }
        case 'remove':
            if (item.value !== undefined) return misplaced(index, 'value', 'is not allowed for remove');
            return { op: 'remove', path };
        case 'add':
            if (item.value === undefined) return misplaced(index, 'value', 'is required for add');
            return { op: 'add', path, value: item.value, ...(item.key !== undefined && { key: item.key }), ...place };
        default:
            if (item.value === undefined) return misplaced(index, 'value', `is required for ${item.op}`);
            return { op: item.op, path, value: item.value };
    }
}

function missingParts(missing: readonly MissingPart[]): ToolOutcome {
    const lines = missing.map((part) => `no ${PART_KIND_WORDS[part.kind]} "${part.name}"${part.nearest.length > 0 ? ` (nearest: ${part.nearest.join(', ')})` : ''}`);
    return fail('not-found', `The app names parts the owner does not have: ${lines.join('; ')}; nothing was written`, { missing });
}

type SharedResult =
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'screen-not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

function sharedOutcome(result: SharedResult, app: string, screen: string): ToolOutcome {
    switch (result.kind) {
        case 'not-found':
            return fail('not-found', `No app named "${app}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : '; ui_list lists the apps'}`, {
                argument: 'app',
                nearest: result.nearest
            });
        case 'screen-not-found':
            return fail('not-found', `The app "${app}" has no screen "${screen}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : ''}; "app" names the app node`, {
                argument: 'screen',
                nearest: result.nearest
            });
        case 'conflict':
            return fail('conflict', `The app is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                currentRevision: result.currentRevision
            });
        case 'invalid-operation':
            return fail('invalid-operation', `Operation ${result.index} could not be applied: ${result.error.message}`, { index: result.index, errors: [result.error] });
        case 'missing-parts':
            return missingParts(result.missing);
        case 'invalid':
            return fail('invalid-app', 'The app would have blocking errors or the call is over a limit; nothing was written. Each error names its part and path', {
                errors: result.errors
            });
    }
}

/** `ui_nodes_write`, `ui_locale_write` and `ui_icons_write`, when the server has parts */
export function createNodeTools(useCases: Pick<UiBuilderUseCases, 'writeNodes' | 'writeLocale' | 'writeIcons'>): readonly UiToolDefinition[] {
    const { writeNodes, writeLocale, writeIcons } = useCases;
    if (writeNodes === undefined || writeLocale === undefined || writeIcons === undefined) return [];
    return [
        {
            name: 'ui_nodes_write',
            description: `Build time: change the nodes of one tree of an app: a screen (screen: its name) or the app node (screen: "app": its layout, toasts and on; an app is its screens, so a header or menu goes in each screen), with up to ${MAX_OPERATIONS_PER_WRITE} add, set, remove, merge and move operations on paths that start with root. They apply in order to a copy, and later ones see the paths earlier ones made. add puts a node into the children of the node at path and returns its path; move keeps the key and subtree of an entry ({ op: "move", path, before | after } reorders it, with to it moves into another map). A set through a missing parent fails: write the parent first or use merge. The app is then checked as a whole with every part it uses and written as one change, or not at all; the shell must keep its one outlet. Pass expectedRevision, the app's. Returns { app, screen, revision, warnings, added: [{ index, path }] }.`,
            inputSchema: NODES_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = NODES_WRITE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { app, screen, expectedRevision } = parsed.value;
                const target = targetOf(screen);
                const operations: NodeOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toNodeOperation(item, index, target);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const result = await writeNodes.execute({ app, target, expectedRevision, operations });
                if (result.kind === 'written') return succeed({ app, screen, revision: result.revision, warnings: withGuides(result.warnings), added: result.added });
                return sharedOutcome(result, app, screen);
            }
        },
        {
            name: 'ui_locale_write',
            description:
                'Build time: write the translations of one language for one tree of an app: a screen (screen: its name) or the app node (screen: "app"). Each operation sets or removes the text at a content path of the tree (root.children.hero._title); the overlay keeps only content, never data links. The app is checked as a whole, then the language: every content path still untranslated comes back as a SUI-LOCALE-MISSING warning, so you can see what is left. Pass expectedRevision, the app\'s. Returns { app, screen, language, revision, warnings }.',
            inputSchema: LOCALE_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = LOCALE_WRITE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { app, screen, language, expectedRevision } = parsed.value;
                const target = targetOf(screen);
                const operations: LocaleOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const path = relative(item.path, target, index, 'path');
                    if (typeof path !== 'string') return path;
                    if (item.op === 'remove') {
                        if (item.value !== undefined) return misplaced(index, 'value', 'is not allowed for remove');
                        operations.push({ op: 'remove', path });
                    } else {
                        if (item.value === undefined) return misplaced(index, 'value', 'is required for set');
                        operations.push({ op: 'set', path, value: item.value });
                    }
                }
                const result = await writeLocale.execute({ app, language, target, expectedRevision, operations });
                if (result.kind === 'written') return succeed({ app, screen, language, revision: result.revision, warnings: withGuides(result.warnings) });
                if (result.kind === 'invalid-language') return fail('invalid-argument', 'language must be a code such as "de" or "pt-BR"', { argument: 'language' });
                return sharedOutcome(result, app, screen);
            }
        },
        {
            name: 'ui_icons_write',
            description: `Build time: write the app's own icons, for a glyph the icon set does not have: up to ${MAX_OPERATIONS_PER_WRITE} operations that set an icon by name (its outline paths in a 24×24 view box, as SVG path data, and optionally a filled variant) or remove one. A node names an app icon as it names any icon (icon: "chat"), and an app icon wins over an icon of the same name in ui_icons_list, which lists the app's icons when given app. Path data only: no markup, url( or other attributes, and a circle or rect is written as a path. The app is checked as a whole and written as one change, or not at all. Pass expectedRevision, the app's. Returns { app, revision, icons (the app's icon names), warnings }.`,
            inputSchema: ICONS_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = ICONS_WRITE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { app, expectedRevision } = parsed.value;
                const operations: IconOperation[] = [];
                for (const [index, item] of parsed.value.operations.entries()) {
                    const converted = toIconOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const result = await writeIcons.execute({ app, expectedRevision, operations });
                if (result.kind === 'written') return succeed({ app, revision: result.revision, icons: result.icons, warnings: withGuides(result.warnings) });
                return sharedOutcome(result, app, 'app');
            }
        }
    ];
}
