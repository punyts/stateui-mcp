/**
 * Where `ui_interact drag` takes a node (G1.10b of the graphics epic 1): onto the node whose state path is `value`, or
 * by an offset `+dx,+dy` in page pixels (signed integers) from the middle of the node's box. A value that starts like a
 * number (a sign, a digit or a comma) is read as an offset, and one that is not a whole offset is refused, since no
 * state path starts that way
 */

/** How far a drag by offset moves the mouse, in page pixels */
export interface DragOffset {
    readonly dx: number;
    readonly dy: number;
}

/** What the `value` of a `drag` names: an offset, or the state path of a drop target */
export type DragTarget = { readonly offset: DragOffset } | { readonly path: string };

/** The accepted form of an offset, for messages */
export const DRAG_OFFSET_FORM = '+dx,+dy';

const OFFSET = /^([+-]?\d+)\s*,\s*([+-]?\d+)$/;
const OFFSET_LIKE = /^[+\-\d,]/;

/** An offset written back in its accepted form, each part with its sign: `+40,-10` */
export function formatDragOffset(offset: DragOffset): string {
    const signed = (value: number): string => (value < 0 ? String(value) : `+${value}`);
    return `${signed(offset.dx)},${signed(offset.dy)}`;
}

/**
 * Reads the `value` of a `drag`: an offset `+dx,+dy` (whitespace around the comma allowed, a sign optional), else the
 * path of a drop target. A value that starts like an offset but is not one is an error message that shows the form
 */
export function dragTargetOf(value: string): DragTarget | { readonly error: string } {
    const trimmed = value.trim();
    if (!OFFSET_LIKE.test(trimmed)) return { path: value };
    const match = OFFSET.exec(trimmed);
    const dx = match === null ? NaN : Number(match[1]);
    const dy = match === null ? NaN : Number(match[2]);
    if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) {
        return {
            error: `drag value "${value}" is not an offset: write ${DRAG_OFFSET_FORM}, two signed whole numbers of page pixels such as +40,-10 (or give the state path of a drop target)`
        };
    }
    // -0 is 0
    return { offset: { dx: dx + 0, dy: dy + 0 } };
}
