import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { childCount, isNodeValue } from '../../domain/nodeDepth.js';
import { MAX_OUTLINE_LINES } from './formatOutline.js';

export interface TreeSource {
    /** The resolved node the tree starts at */
    readonly root: JsonObject;
    /** The key shown for the root node */
    readonly rootKey: string;
    /** The state path of the root node, such as `$.app` or `$.app.children.main` */
    readonly rootPath: string;
    /** How many `children` levels to show below the root; deeper nodes end their line with a child count */
    readonly depth: number | undefined;
    /** False leaves the state path off each line */
    readonly paths: boolean;
}

export interface Tree {
    readonly text: string;
    readonly lineCount: number;
    readonly cutLines: number;
    readonly nodeCount: number;
}

type NodeValue = JsonObject & { readonly component: string };

/** The bullet of a level: `-` on even levels, `*` on odd ones, so the nesting reads at a glance */
function bullet(level: number): string {
    return level % 2 === 0 ? '-' : '*';
}

/**
 * The structure of a resolved node tree as a nested list: one line per node with its key, its component and its
 * state path, indented two spaces per level with bullets that alternate between `-` and `*`. A node held by a slot
 * property (a `footer`, a `row` template) is marked `[slot]` and sits one level below its parent like a child; a
 * `row` template draws once per record. The state paths are the ones ui_interact, ui_state_set and ui_screenshot
 * take. Output past `MAX_OUTLINE_LINES` is cut and counted
 */
export function formatTree(source: TreeSource): Tree {
    const lines: string[] = [];
    let nodeCount = 0;

    const emit = (node: NodeValue, key: string, path: string, level: number, childLevel: number, slot: boolean): void => {
        nodeCount += 1;
        const marks = [slot ? '[slot]' : '', slot && key === 'row' ? '(one per record)' : ''].filter((mark) => mark !== '');
        const parts = [`${bullet(level)} ${key} (${node.component})`, ...marks];
        if (source.paths) parts.push(path);
        if (source.depth !== undefined && childLevel > source.depth) {
            const hidden = childCount(node);
            lines.push(`${'  '.repeat(level)}${parts.join(' ')}${hidden > 0 ? ` (+${hidden} children)` : ''}`);
            return;
        }
        lines.push(`${'  '.repeat(level)}${parts.join(' ')}`);
        for (const [property, value] of Object.entries(node)) {
            if (property === 'children' && isJsonObject(value)) {
                for (const [childKey, child] of Object.entries(value)) {
                    if (isNodeValue(child)) emit(child, childKey, `${path}.children.${childKey}`, level + 1, childLevel + 1, false);
                }
            } else if (property !== 'children' && isNodeValue(value)) {
                emit(value, property, `${path}.${property}`, level + 1, childLevel, true);
            }
        }
    };

    if (isNodeValue(source.root)) emit(source.root, source.rootKey, source.rootPath, 0, 0, false);
    const lineCount = lines.length;
    if (lineCount <= MAX_OUTLINE_LINES) return { text: lines.join('\n'), lineCount, cutLines: 0, nodeCount };
    const cutLines = lineCount - MAX_OUTLINE_LINES;
    const shown = lines.slice(0, MAX_OUTLINE_LINES);
    shown.push(`... ${cutLines} more lines not shown (the tree is capped at ${MAX_OUTLINE_LINES} lines; use path or depth to narrow it)`);
    return { text: shown.join('\n'), lineCount, cutLines, nodeCount };
}
