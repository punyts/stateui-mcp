import { isJsonObject } from './JsonValue.js';
import type { JsonValue } from './JsonValue.js';

/** A parsed dotted document path such as `app.children.footer._title`. The empty list is the document root */
export type DocumentPath = readonly string[];

export type ParsedDocumentPath =
    | { readonly ok: true; readonly path: DocumentPath }
    | { readonly ok: false; readonly reason: string };

/** Parses `a.b.c` into segments. The empty string is the root; an empty segment (`a..b`, `.a`, `a.`) is invalid */
export function parseDocumentPath(text: string): ParsedDocumentPath {
    if (text === '') return { ok: true, path: [] };
    const segments = text.split('.');
    if (segments.some((segment) => segment === '')) {
        return { ok: false, reason: 'A path segment is empty' };
    }
    return { ok: true, path: segments };
}

/** The state path of a document path: `$` for the root, otherwise `$.a.b` */
export function toStatePath(path: DocumentPath): string {
    return path.length === 0 ? '$' : `$.${path.join('.')}`;
}

export type PathResolution =
    | { readonly found: true; readonly value: JsonValue }
    | { readonly found: false; readonly missingAt: number };

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/**
 * Walks `path` down from `root`. Object segments are own keys; array segments are indexes. When a segment is
 * missing, `missingAt` is its index in the path (a path through a missing parent reports the first missing one)
 */
export function resolveDocumentPath(root: JsonValue, path: DocumentPath): PathResolution {
    let current: JsonValue = root;
    for (let index = 0; index < path.length; index++) {
        const segment = path[index] as string;
        if (Array.isArray(current)) {
            const items = current as readonly JsonValue[];
            const position = ARRAY_INDEX.test(segment) ? Number(segment) : -1;
            if (position < 0 || position >= items.length) return { found: false, missingAt: index };
            current = items[position] as JsonValue;
        } else if (isJsonObject(current) && Object.hasOwn(current, segment)) {
            current = current[segment] as JsonValue;
        } else {
            return { found: false, missingAt: index };
        }
    }
    return { found: true, value: current };
}
