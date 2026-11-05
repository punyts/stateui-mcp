import type { AppBlueprint, PartRef, PartSource } from '@punyts/stateui-app/core';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { PartKind } from '../../domain/partName.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
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

/** An error of an assembled app, with the part that holds its path: the app, a component, the theme, a dataset or a module */
export interface UiPartError extends UiBuildError {
    readonly part: PartRef;
}

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
    /**
     * Assembles an app from its blueprint and the parts it uses (`parts`: what the app reaches, loaded by the caller) and
     * checks the result; each error names the part that holds it. `name` is the app's part name
     */
    validateAssembled(blueprint: AppBlueprint, parts: PartSource, name: string): readonly UiPartError[];
    /**
     * The errors and warnings of one part on its own, by the reader of its kind: an app's blueprint and the errors of
     * the assembled app that the app itself holds, a theme's tokens and overlays, a module, a model, a dataset's shape and
     * records against its model, a component's tree, a pattern's shape. `parts` holds what the part names (an app's
     * parts, a component's nested components, a dataset's model)
     */
    validatePart<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], parts: PartSource): readonly UiBuildError[];
}
