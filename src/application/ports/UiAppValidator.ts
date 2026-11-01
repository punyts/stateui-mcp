import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';

/**
 * Whether a value may be written to one property of a component through `ui_state_set`. `exposed` and `runtime`
 * properties belong to controllers; `content` is a `_` property (`ok` with `content: true`)
 */
export type PropertyCheck =
    | { readonly kind: 'ok'; readonly content: boolean }
    | { readonly kind: 'unknown-component' }
    | { readonly kind: 'unknown-property' }
    | { readonly kind: 'runtime' }
    | { readonly kind: 'exposed' }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/** Checks documents against the component library. Errors and warnings share one list; see `isValid` */
export interface UiAppValidator {
    /**
     * Every error and warning of the document, each with its state path. Warnings include `SUI-LOCALE-MISSING`
     * for each content path a language of the document's `locales` does not translate
     */
    validate(document: UiDocument): readonly UiBuildError[];
    /**
     * The node at a document path merged with its component defaults, or `undefined` when there is none.
     * Runtime properties (the shape's `runtime` flag: `current`, `status`, `slots`) are left out: controllers own them
     */
    resolveNode(document: UiDocument, path: readonly string[]): JsonObject | undefined;
    /**
     * The content overlay of one language for the whole application: component overlays plus the document's own
     * `locales[code]`, as a sparse tree that mirrors `app`. `undefined` when the language has no overlay at all
     */
    localeOverlay(document: UiDocument, code: string): JsonObject | undefined;
    /**
     * Checks `value` against the shape of `property` on `component` (a root component name). Errors carry state
     * paths below `nodeStatePath`, the state path of the node
     */
    checkProperty(component: string, property: string, value: JsonValue, nodeStatePath: string): PropertyCheck;
}
