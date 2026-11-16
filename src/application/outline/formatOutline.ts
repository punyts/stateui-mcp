import { resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { childCount, isNodeValue } from '../../domain/nodeDepth.js';

/** Most lines an outline returns; the rest is counted, not shown */
export const MAX_OUTLINE_LINES = 400;

/** The component of the app node, below which the screens of an app of parts are drawn */
export const APP_NODE = 'app';

/** Components whose children are listed on the line of the parent when every child is a leaf */
const INLINE_CHILDREN: readonly string[] = ['toolbar'];

/** The content properties that name a node, in the order they are tried */
const CONTENT_KEYS: readonly string[] = ['_title', '_label', '_text'];

/** Longest content text shown on a line, in characters */
const MAX_CONTENT_CHARS = 80;

const LINK_PREFIX = '<-';

/** A screen drawn below the app node: its resolved root and its part of the state snapshot (`$.screens.{name}`) */
export interface OutlineScreen {
    readonly name: string;
    readonly root: JsonObject;
    readonly snapshot: JsonObject | undefined;
}

/** Where the content and the marks of a node are read: the overlay and the snapshot of the tree it is in */
interface Scope {
    readonly overlay: JsonObject | undefined;
    readonly snapshot: JsonObject | undefined;
}

export interface OutlineSource {
    /** The resolved node the outline starts at */
    readonly root: JsonObject;
    /** The key shown for the root node; `undefined` for the application root */
    readonly rootKey: string | undefined;
    /** Where the root sits below `app`, for the overlay and the snapshot; `undefined` outside the app tree (composed) */
    readonly appPath: readonly string[] | undefined;
    /** The content overlay of the chosen language, mirroring `app` */
    readonly overlay: JsonObject | undefined;
    /** The `app` part of the latest state snapshot: articulation the user changed, such as `open` */
    readonly snapshotApp: JsonObject | undefined;
    /** How many records a `$.data...` target holds, or `undefined` when it is not data or not a list */
    readonly recordCount: (target: string) => number | undefined;
    readonly depth: number | undefined;
    /** Lines shown after the tree, such as the document's logic */
    readonly trailer?: readonly string[];
    /**
     * The screens of an app of parts, drawn below the app node (`$.app`), each under its name: an app is its screens
     */
    readonly screens?: readonly OutlineScreen[];
}

export interface Outline {
    /** The text: at most `MAX_OUTLINE_LINES` lines, then one line that says how many were cut */
    readonly text: string;
    /** Lines the whole outline has, before the cap */
    readonly lineCount: number;
    /** Lines left out by the cap */
    readonly cutLines: number;
}

interface Slot {
    readonly key: string;
    readonly node: JsonObject & { readonly component: string };
}

function textOf(value: JsonValue | undefined): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function shorten(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > MAX_CONTENT_CHARS ? `${single.slice(0, MAX_CONTENT_CHARS - 1)}…` : single;
}

function walk(tree: JsonObject | undefined, path: readonly string[] | undefined): JsonObject | undefined {
    if (tree === undefined || path === undefined) return undefined;
    const found = resolveDocumentPath(tree, path);
    return found.found && isJsonObject(found.value) ? found.value : undefined;
}

/** The nodes below `node` in the order they are written: `children` entries in key order and slot nodes in place */
function childNodes(node: JsonObject): { children: Slot[]; slots: Slot[]; ordered: Slot[] } {
    const children: Slot[] = [];
    const slots: Slot[] = [];
    const ordered: Slot[] = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'children' && isJsonObject(value)) {
            for (const [childKey, child] of Object.entries(value)) {
                if (isNodeValue(child)) {
                    const slot = { key: childKey, node: child };
                    children.push(slot);
                    ordered.push(slot);
                }
            }
        } else if (key !== 'children' && isNodeValue(value)) {
            const slot = { key, node: value };
            slots.push(slot);
            ordered.push(slot);
        }
    }
    return { children, slots, ordered };
}

class Formatter {
    readonly lines: string[] = [];

    constructor(private readonly source: OutlineSource) {}

    private content(node: JsonObject, path: readonly string[] | undefined, scope: Scope): string | undefined {
        const overlay = walk(scope.overlay, path);
        for (const key of CONTENT_KEYS) {
            if (Object.hasOwn(node, `${LINK_PREFIX}${key}`)) continue;
            const text = textOf(overlay?.[key]) ?? textOf(node[key]);
            if (text !== undefined) return shorten(text);
        }
        return undefined;
    }

    private markers(node: JsonObject, path: readonly string[] | undefined, scope: Scope): string {
        const live = walk(scope.snapshot, path);
        const hidden = typeof live?.['hidden'] === 'boolean' ? live['hidden'] : node['hidden'];
        const open = typeof live?.['open'] === 'boolean' ? live['open'] : node['open'];
        const marks = [hidden === true ? 'hidden' : undefined, open === false ? 'closed' : undefined].filter(
            (mark): mark is string => mark !== undefined
        );
        return marks.length === 0 ? '' : ` (${marks.join(', ')})`;
    }

    private links(node: JsonObject): string[] {
        return Object.entries(node)
            .filter(([key, value]) => key.startsWith(LINK_PREFIX) && typeof value === 'string')
            .map(([, value]) => `${LINK_PREFIX}${value as string}`);
    }

    /** The text of one node without indentation */
    private describe(node: JsonObject & { component: string }, key: string | undefined, path: readonly string[] | undefined, scope: Scope): string {
        const parts: string[] = [node.component];
        if (key !== undefined && key !== node.component) parts.push(key);
        const content = this.content(node, path, scope);
        if (content !== undefined) parts.push(`"${content}"`);
        parts.push(...this.links(node));
        return `${parts.join(' ')}${this.markers(node, path, scope)}`;
    }

    private recordSuffix(parent: JsonObject): string {
        for (const link of this.links(parent)) {
            const count = this.source.recordCount(link.slice(LINK_PREFIX.length));
            if (count !== undefined) return ` (${count} ${count === 1 ? 'record' : 'records'})`;
        }
        return '';
    }

    private isLeaf(node: JsonObject): boolean {
        return childNodes(node).ordered.length === 0;
    }

    emit(
        node: JsonObject & { component: string },
        key: string | undefined,
        path: readonly string[] | undefined,
        level: number,
        indent: number,
        suffix = '',
        scope: Scope = { overlay: this.source.overlay, snapshot: this.source.snapshotApp }
    ): void {
        const screens = this.source.screens ?? [];
        const pad = '  '.repeat(indent);
        const { children, slots, ordered } = childNodes(node);
        const { depth } = this.source;
        const base = `${pad}${this.describe(node, key, path, scope)}${suffix}`;

        if (depth !== undefined && level > depth) {
            const hidden = childCount(node);
            this.lines.push(hidden > 0 ? `${base} (+${hidden} children)` : base);
            return;
        }
        const inline =
            INLINE_CHILDREN.includes(node.component) && slots.length === 0 && children.length > 0 && children.every((child) => this.isLeaf(child.node));
        if (inline) {
            const items = children.map((child) => this.describe(child.node, child.key, path === undefined ? undefined : [...path, 'children', child.key], scope));
            this.lines.push(`${base} [${items.join(', ')}]`);
            return;
        }
        this.lines.push(base);
        if (node.component === APP_NODE) {
            for (const screen of screens) {
                if (isNodeValue(screen.root)) this.emit(screen.root, screen.name, [], level + 1, indent + 1, '', { overlay: undefined, snapshot: screen.snapshot });
            }
        }
        for (const child of ordered) {
            const isChild = children.includes(child);
            const childPath = path === undefined ? undefined : isChild ? [...path, 'children', child.key] : [...path, child.key];
            const childLevel = isChild ? level + 1 : level;
            const rowSuffix = !isChild && child.key === 'row' ? this.recordSuffix(node) : '';
            this.emit(child.node, child.key, childPath, childLevel, indent + 1, rowSuffix, scope);
        }
    }
}

/**
 * A plain-text outline of a resolved node tree: one line per node with indentation for nesting, the node key (left
 * out when it repeats the component), the component, its main content (`_title`, `_label` or `_text`, in the chosen
 * language when an overlay is given), its links as `<-target`, and `(hidden)` or `(closed)` marks. Hidden and closed
 * nodes stay in. A toolbar of leaf nodes shares one line. A `row` template is shown once, with the record count of
 * the link that feeds it; data values are never shown. The `screens` of an app of parts are drawn below the app node. The
 * `trailer` lines follow the tree. Output past
 * `MAX_OUTLINE_LINES` is cut and counted
 */
export function formatOutline(source: OutlineSource): Outline {
    const formatter = new Formatter(source);
    if (isNodeValue(source.root)) formatter.emit(source.root, source.rootKey, source.appPath, 0, 0);
    if (source.trailer !== undefined) formatter.lines.push(...source.trailer);
    const lineCount = formatter.lines.length;
    if (lineCount <= MAX_OUTLINE_LINES) return { text: formatter.lines.join('\n'), lineCount, cutLines: 0 };
    const cutLines = lineCount - MAX_OUTLINE_LINES;
    const shown = formatter.lines.slice(0, MAX_OUTLINE_LINES);
    shown.push(`... ${cutLines} more lines not shown (the outline is capped at ${MAX_OUTLINE_LINES} lines; use path or depth to narrow it)`);
    return { text: shown.join('\n'), lineCount, cutLines };
}
