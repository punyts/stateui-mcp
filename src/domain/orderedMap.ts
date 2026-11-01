import { isJsonObject } from './JsonValue.js';
import type { JsonObject, JsonValue } from './JsonValue.js';
import type { UiBuildError } from './UiBuildError.js';

/** Keys whose object value is an ordered map: its key order is the display order */
export const ORDERED_MAP_KEYS: readonly string[] = ['children', 'options', 'columns', 'items', 'steps', 'messages'];

/** Integer-like keys are moved to the front of an object by JavaScript, whatever order they were written in */
const INTEGER_LIKE_KEY = /^(0|[1-9]\d*)$/;

export function isIntegerLikeKey(key: string): boolean {
    return INTEGER_LIKE_KEY.test(key);
}

interface Frame {
    value: JsonValue;
    path: string;
    /** True when `value` is the object held by an ordered-map key */
    ordered: boolean;
    underData: boolean;
}

/**
 * One `SUI-DOC` error, with the state path of the key, for every integer-like key in an ordered map
 * (`children`, `options`, `columns`, `items`, `steps`, `messages`) of `app` and every composed tree, and in every
 * object under `data`. Records are keyed with a prefix (`o42`, not `42`). Iterative, so a deep value cannot overflow
 */
export function orderedMapKeyErrors(document: JsonObject): UiBuildError[] {
    const errors: UiBuildError[] = [];
    const stack: Frame[] = [];
    const push = (value: JsonValue | undefined, path: string, underData: boolean): void => {
        if (value !== undefined) stack.push({ value, path, ordered: false, underData });
    };

    push(document['app'], '$.app', false);
    const composed = document['composed'];
    if (isJsonObject(composed)) {
        for (const [name, tree] of Object.entries(composed)) push(tree, `$.composed.${name}`, false);
    }
    push(document['data'], '$.data', true);

    while (stack.length > 0) {
        const frame = stack.pop() as Frame;
        if (Array.isArray(frame.value)) {
            (frame.value as readonly JsonValue[]).forEach((item, index) =>
                stack.push({ value: item, path: `${frame.path}.${index}`, ordered: false, underData: frame.underData })
            );
        } else if (isJsonObject(frame.value)) {
            for (const [key, item] of Object.entries(frame.value)) {
                const path = `${frame.path}.${key}`;
                if ((frame.ordered || frame.underData) && isIntegerLikeKey(key)) {
                    errors.push({
                        code: 'SUI-DOC-ORDER',
                        message: `Key "${key}" at ${path} is integer-like and would be reordered; use a prefixed key`,
                        statePath: path
                    });
                }
                stack.push({ value: item, path, ordered: ORDERED_MAP_KEYS.includes(key), underData: frame.underData });
            }
        }
    }
    return errors.sort((a, b) => (a.statePath as string).localeCompare(b.statePath as string));
}
