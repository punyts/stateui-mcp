import type { UiBuildError } from './UiBuildError.js';
import type { UiDocument } from './UiApp.js';
import { isJsonObject } from './JsonValue.js';
import type { JsonValue } from './JsonValue.js';

/** Largest serialised document, in UTF-8 bytes (1 MiB). Matches `MAX_DOCUMENT_BYTES` of `@punyts/stateui-app` */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Most nodes in a document, counting `app` and every composed tree. Matches `MAX_NODES` of `@punyts/stateui-app` */
export const MAX_NODE_COUNT = 2000;

/** Most operations in one `writeApp` call */
export const MAX_OPERATIONS_PER_WRITE = 50;

/** Most runtime errors kept per app in the preview error log; the oldest are dropped first */
export const MAX_PREVIEW_ERRORS = 50;

const encoder = new TextEncoder();

/** Serialised size of a value in UTF-8 bytes */
export function documentBytes(value: JsonValue): number {
    return encoder.encode(JSON.stringify(value)).length;
}

/** Counts the nodes of a value: every object with a string `component` */
export function countNodes(value: JsonValue): number {
    let count = 0;
    const stack: JsonValue[] = [value];
    while (stack.length > 0) {
        const current = stack.pop() as JsonValue;
        if (Array.isArray(current)) {
            stack.push(...(current as readonly JsonValue[]));
        } else if (isJsonObject(current)) {
            if (typeof current['component'] === 'string') count++;
            stack.push(...Object.values(current));
        }
    }
    return count;
}

/** `SUI-DOC` errors for a document over the byte or node limit. A document exactly at a limit passes */
export function checkDocumentLimits(document: UiDocument): UiBuildError[] {
    const errors: UiBuildError[] = [];
    const bytes = documentBytes(document);
    if (bytes > MAX_DOCUMENT_BYTES) {
        errors.push({
            code: 'SUI-DOC-LIMIT-BYTES',
            message: `The document is ${bytes} bytes; the limit is ${MAX_DOCUMENT_BYTES}`,
            statePath: '$'
        });
    }
    const nodes = countNodes(document);
    if (nodes > MAX_NODE_COUNT) {
        errors.push({
            code: 'SUI-DOC-LIMIT-NODES',
            message: `The document has ${nodes} nodes; the limit is ${MAX_NODE_COUNT}`,
            statePath: '$'
        });
    }
    return errors;
}

/** A `SUI-DOC` error when one write carries more operations than allowed, otherwise `undefined` */
export function checkOperationLimit(operationCount: number): UiBuildError | undefined {
    if (operationCount <= MAX_OPERATIONS_PER_WRITE) return undefined;
    return {
        code: 'SUI-DOC-LIMIT-OPERATIONS',
        message: `The write has ${operationCount} operations; the limit is ${MAX_OPERATIONS_PER_WRITE}`,
        statePath: '$'
    };
}

/** How long after its last event a preview still counts as attached. A preview host reports at least this often */
export const PREVIEW_HEARTBEAT_WINDOW_MS = 30_000;
