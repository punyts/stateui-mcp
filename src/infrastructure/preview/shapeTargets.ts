/**
 * How the headless preview finds the shapes of a drawing (G1.10 of the graphics epic 1). A shape is not a custom
 * element with a scope: the renderer marks the element that draws it (an SVG element, or the hidden proxy button of a
 * canvas drawing in the host's shadow root) with `data-shape-path` (its state path, `…rows.<recordKey>` for a repeat
 * copy) and `data-shape-kind` (its component). The page code of `BrowserPreview` takes the selectors made here
 */

import type { InteractAction } from './BrowserPreview.js';

/** The actions `ui_interact` takes on a shape; `drag` is added with draggable shapes (G1.10b) */
export const SHAPE_ACTIONS: readonly InteractAction[] = ['click', 'press', 'hover', 'focus', 'key'];

/** The attribute that names the state path of the shape an element draws */
export const SHAPE_PATH_ATTRIBUTE = 'data-shape-path';

/** The attribute that names the component of the shape an element draws (`circle`, `drawText`) */
export const SHAPE_KIND_ATTRIBUTE = 'data-shape-kind';

/** The elements of interactive shapes: an SVG shape made a button, or the proxy button of a canvas shape */
export const INTERACTIVE_SHAPE_SELECTOR = `[${SHAPE_PATH_ATTRIBUTE}][role="button"], button[${SHAPE_PATH_ATTRIBUTE}]`;

/** A value quoted for a CSS attribute selector: backslashes, quotes and line breaks escaped */
function cssString(value: string): string {
    const escaped = value.replace(/[\\"]/g, (character) => `\\${character}`).replace(/[\n\r\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `);
    return `"${escaped}"`;
}

/** The selector of the element that draws the shape at `statePath` (a full state path, `$.app.children.map.children.seat`) */
export function shapeSelector(statePath: string): string {
    return `[${SHAPE_PATH_ATTRIBUTE}=${cssString(statePath)}]`;
}

/** True when `path` is `root` or a path below it (`$.app.children.map` holds `$.app.children.map.children.seat`, not `$.app.children.mapLegend`) */
export function isAtOrBelow(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}.`);
}

/**
 * Why `action` cannot run on a shape, naming the actions a shape takes; undefined when it can. `fill`, `select` and
 * `choose` need a field or options, which a shape does not have
 */
export function shapeActionError(statePath: string, kind: string, action: InteractAction): string | undefined {
    if (SHAPE_ACTIONS.includes(action) || action === 'drag') return undefined;
    return `${statePath} is a shape (${kind}), which takes ${SHAPE_ACTIONS.join(', ')}, not ${action}`;
}
