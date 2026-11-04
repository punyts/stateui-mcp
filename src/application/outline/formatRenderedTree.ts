import { MAX_OUTLINE_LINES } from './formatOutline.js';
import type { Tree } from './formatTree.js';

/** A node a running view draws: its state path, its component and whether it has a box on screen */
export interface RenderedTreeNode {
    readonly path: string;
    readonly component: string;
    readonly visible: boolean;
}

export interface RenderedTreeSource {
    /** The drawn nodes in page order, the root first */
    readonly nodes: readonly RenderedTreeNode[];
    /** How many levels to show below the root; deeper nodes are counted on the line of their ancestor */
    readonly depth: number | undefined;
    /** False leaves the state path off each line */
    readonly paths: boolean;
}

interface Placed {
    readonly node: RenderedTreeNode;
    readonly level: number;
    /** The path of the node below the one it nests in, such as `cols.k_open.body.main` */
    readonly label: string;
    below: number;
    /** False when an ancestor is collapsed (hidden, or at the depth limit): the node is only counted */
    readonly shown: boolean;
}

function bullet(level: number): string {
    return level % 2 === 0 ? '-' : '*';
}

/**
 * The nodes a running view draws as a nested list, like `formatTree` but from the page: a node nests in the
 * nearest drawn node whose path its own path extends, and its label is the rest of its path (a leading `children.`
 * left out), so the rows of a list (`body.slots.0`) and the cards of a board (`cols.k_open.body.main.slots.2`) show
 * with the paths ui_interact takes. A node with no box on screen is marked `(hidden)` and its subtree is counted, not
 * listed; a run of hidden siblings of one component is one line (`slots.3 … slots.15 (card) (13 hidden)`). Output past
 * `MAX_OUTLINE_LINES` is cut and counted
 */
export function formatRenderedTree(source: RenderedTreeSource): Tree {
    const placed: Placed[] = [];
    const stack: Placed[] = [];
    for (const node of source.nodes) {
        while (stack.length > 0 && !node.path.startsWith(`${(stack[stack.length - 1] as Placed).node.path}.`)) stack.pop();
        const parent = stack[stack.length - 1];
        const level = parent === undefined ? 0 : parent.level + 1;
        const label = parent === undefined ? (node.path.split('.').pop() ?? node.path) : node.path.slice(parent.node.path.length + 1).replace(/^children\./, '');
        const collapsed = parent !== undefined && (!parent.shown || !parent.node.visible || (source.depth !== undefined && parent.level >= source.depth));
        const entry: Placed = { node, level, label, below: 0, shown: !collapsed };
        if (collapsed) {
            // Counted on the nearest ancestor that is listed
            const listed = [...stack].reverse().find((ancestor) => ancestor.shown);
            if (listed !== undefined) listed.below += 1;
        }
        placed.push(entry);
        stack.push(entry);
    }

    const lines: string[] = [];
    const listed = placed.filter((entry) => entry.shown);
    for (let index = 0; index < listed.length; index += 1) {
        const entry = listed[index] as Placed;
        // A run of hidden siblings of one component (the spare slots a list keeps for scrolling) is one line
        let last = index;
        while (!entry.node.visible) {
            const next = listed[last + 1];
            if (next === undefined || next.node.visible || next.level !== entry.level || next.node.component !== entry.node.component) break;
            last += 1;
        }
        if (last > index) {
            const end = listed[last] as Placed;
            const below = listed.slice(index, last + 1).reduce((sum, item) => sum + item.below, 0);
            const count = `(${last - index + 1} hidden${below > 0 ? `, +${below} below` : ''})`;
            lines.push(`${'  '.repeat(entry.level)}${bullet(entry.level)} ${entry.label} … ${end.label} (${entry.node.component}) ${count}`);
            index = last;
            continue;
        }
        const parts = [`${bullet(entry.level)} ${entry.label} (${entry.node.component})`];
        if (!entry.node.visible) parts.push('(hidden)');
        if (source.paths) parts.push(entry.node.path);
        if (entry.below > 0) parts.push(`(+${entry.below} below)`);
        lines.push(`${'  '.repeat(entry.level)}${parts.join(' ')}`);
    }

    const nodeCount = source.nodes.length;
    const lineCount = lines.length;
    if (lineCount <= MAX_OUTLINE_LINES) return { text: lines.join('\n'), lineCount, cutLines: 0, nodeCount };
    const cutLines = lineCount - MAX_OUTLINE_LINES;
    const shown = lines.slice(0, MAX_OUTLINE_LINES);
    shown.push(`... ${cutLines} more lines not shown (the tree is capped at ${MAX_OUTLINE_LINES} lines; use path or depth to narrow it)`);
    return { text: shown.join('\n'), lineCount, cutLines, nodeCount };
}
