import {
    assembleApp,
    buildAppOverlay,
    extractBaseOverlay,
    extractLinks,
    findUntranslated,
    libraryFromCatalog,
    resolveNode,
    screenPath,
    validateAppLocale,
    validateDocument,
    validateNode
} from '@punyts/stateui-app/core';
import type {
    AppBlueprint,
    CatalogSource,
    ComponentLibrary,
    ComponentOverlays,
    DocumentComposed,
    JsonObject as LibraryJsonObject,
    Node,
    PartSource
} from '@punyts/stateui-app/core';
import type { PropertyCheck, UiAppValidator, UiPartError } from '../application/ports/UiAppValidator.js';
import { resolveDocumentPath, toStatePath } from '../domain/DocumentPath.js';
import { isJsonObject } from '../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../domain/JsonValue.js';
import { checkDocumentLimits } from '../domain/limits.js';
import type { PartKind } from '../domain/partName.js';
import type { UiDocument } from '../domain/UiApp.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { isBlockingError } from '../domain/UiBuildError.js';
import type { UiBuildError } from '../domain/UiBuildError.js';
import { nearestNames } from '../domain/nearestNames.js';
import { assembledErrors, partErrors } from './partChecks.js';
import { loadComponentOverlay } from './stateUiLibrary.js';
import type { CatalogFile } from './stateUiLibrary.js';

const UNKNOWN_COMPONENT = 'SUI-NODE-UNKNOWN';
const NO_COMPONENT = '(none)';

/** The resolved application without linked properties, the paths of those properties and where composed names were expanded */
interface AssembledApp {
    readonly tree: JsonObject;
    readonly linkedPaths: readonly string[];
    readonly instances: Readonly<Record<string, readonly string[]>>;
    readonly composed: Record<string, Node>;
}

/** The document's own `composed` entries, which win over the library and can be named in `component` */
function composedOf(document: UiDocument): Record<string, Node> {
    const composed = document['composed'];
    if (!isJsonObject(composed)) return {};
    const entries: Record<string, Node> = {};
    for (const [name, tree] of Object.entries(composed)) {
        if (isJsonObject(tree) && typeof tree['component'] === 'string') entries[name] = tree as unknown as Node;
    }
    return entries;
}

/** Removes the properties at the linked paths: a linked property is data, not content. `root` is the tree's state path */
function withoutLinked(tree: JsonObject, linkedPaths: readonly string[], root = '$.app'): JsonObject {
    const copy = structuredClone(tree) as Record<string, JsonValue>;
    const depth = root.split('.').length;
    for (const path of linkedPaths) {
        const segments = path.split('.').slice(depth);
        const last = segments.pop();
        let holder: unknown = copy;
        for (const segment of segments) {
            holder = isJsonObject(holder) ? (holder as Record<string, unknown>)[segment] : undefined;
        }
        if (last !== undefined && isJsonObject(holder)) delete (holder as Record<string, unknown>)[last];
    }
    return copy;
}

/**
 * `UiAppValidator` over `validateDocument` of `@punyts/stateui-app/core`. The library's pure part needs no DOM and
 * no worker. A document over the size or node limit is rejected before validation. `icon`-typed properties are
 * checked against `isIconName`. The library also checks `<-` targets: `$.data` paths that exist, `$row` only inside
 * a row template, and node references only to `exposed` properties. A document that is otherwise valid also gets
 * a `SUI-LOCALE-MISSING` warning for each content path that a language in its `locales` does not translate; the
 * component overlays come from the files the library ships
 */
export class StateUiAppValidator implements UiAppValidator {
    private readonly library: ComponentLibrary;
    private readonly overlaysByCode = new Map<string, ComponentOverlays>();

    constructor(
        private readonly catalog: CatalogFile,
        private readonly isIconName: (name: string) => boolean
    ) {
        // The catalog file is the library's own `catalog.json`: each entry fits `CatalogComponent`
        this.library = libraryFromCatalog(catalog as unknown as CatalogSource);
    }

    validate(document: UiDocument): readonly UiBuildError[] {
        const limitErrors = checkDocumentLimits(document);
        if (limitErrors.length > 0) return limitErrors;

        const { errors } = validateDocument(document, this.library, { isIconName: this.isIconName });
        const known = [...Object.keys(this.library), ...Object.keys(composedOf(document))];
        const reported = errors.map((error) => withNearestNames(error, known));
        if (reported.some(isBlockingError)) return reported;
        return [...reported, ...this.untranslated(document), ...viewportWarnings(document)];
    }

    resolveNode(document: UiDocument, path: readonly string[]): JsonObject | undefined {
        const found = resolveDocumentPath(document, path);
        if (!found.found || !isJsonObject(found.value) || typeof found.value['component'] !== 'string') return undefined;

        const statePath = toStatePath(path);
        const result = resolveNode(found.value as unknown as Node, this.library, composedOf(document) as DocumentComposed, {
            path: statePath
        });
        const unknown = result.errors.some((error) => error.code === UNKNOWN_COMPONENT && error.statePath === statePath);
        return unknown ? undefined : (this.withoutRuntime(result.node as unknown as JsonValue) as JsonObject);
    }

    validateAssembled(blueprint: AppBlueprint, parts: PartSource, name: string): readonly UiPartError[] {
        return assembledErrors(blueprint, parts, name, { library: this.library, isIconName: this.isIconName });
    }

    assembleApp(blueprint: AppBlueprint, parts: PartSource): UiDocument {
        return JSON.parse(JSON.stringify(assembleApp(blueprint, parts).document)) as UiDocument;
    }

    validatePart<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], parts: PartSource): readonly UiBuildError[] {
        return partErrors(kind, name, body, parts, { library: this.library, isIconName: this.isIconName });
    }

    /** Controllers own runtime properties (`current`, `status`, `slots`); a read of the resolved node leaves them out */
    private withoutRuntime(value: JsonValue): JsonValue {
        if (Array.isArray(value)) return (value as readonly JsonValue[]).map((item) => this.withoutRuntime(item));
        if (!isJsonObject(value)) return value;
        const component = value['component'];
        const entry =
            typeof component === 'string' && Object.hasOwn(this.library, component) ? this.library[component] : undefined;
        const properties = entry?.tier === 'root' ? entry.shape.properties : undefined;
        const kept = Object.entries(value).filter(([key]) => {
            const declared = properties !== undefined && Object.hasOwn(properties, key) ? properties[key] : undefined;
            return declared?.runtime !== true;
        });
        return Object.fromEntries(kept.map(([key, item]): [string, JsonValue] => [key, this.withoutRuntime(item)]));
    }

    validateLocale(document: UiDocument, code: string, screen?: string): readonly UiBuildError[] {
        const screens = document['screens'];
        const entry = screen === undefined || !isJsonObject(screens) || !Object.hasOwn(screens, screen) ? undefined : screens[screen];
        if (screen !== undefined && !isJsonObject(entry)) return [];
        const owner = screen === undefined ? document : (entry as JsonObject);
        const node = screen === undefined ? document['app'] : owner['root'];
        if (!isJsonObject(node) || typeof node['component'] !== 'string') return [];
        const path = screen === undefined ? '$.app' : screenPath(screen);
        const composed = composedOf(document) as DocumentComposed;
        const resolved = resolveNode(node as unknown as Node, this.library, composed, { path });
        if (resolved.errors.length > 0) return [];
        const extracted = extractLinks(resolved.node, { library: this.library, instances: resolved.instances, path });
        const tree = withoutLinked(extracted.tree as unknown as JsonObject, extracted.linkedPaths, path);
        const locales = owner['locales'];
        const own = isJsonObject(locales) && Object.hasOwn(locales, code) && isJsonObject(locales[code]) ? locales[code] : {};
        return validateAppLocale(code, tree as unknown as LibraryJsonObject, this.componentOverlays(code), own as unknown as LibraryJsonObject, {
            library: this.library,
            composed,
            instances: resolved.instances,
            linkedPaths: extracted.linkedPaths,
            path
        });
    }

    localeOverlay(document: UiDocument, code: string): JsonObject | undefined {
        const assembled = this.assemble(document);
        if (assembled === undefined) return undefined;
        const overlay = this.overlayOf(document, code, assembled);
        return Object.keys(overlay).length === 0 ? undefined : overlay;
    }

    checkProperty(component: string, property: string, value: JsonValue, nodeStatePath: string): PropertyCheck {
        const entry = Object.hasOwn(this.library, component) ? this.library[component] : undefined;
        if (entry?.tier !== 'root') return { kind: 'unknown-component' };
        const shape = entry.shape;
        const declared = Object.hasOwn(shape.properties, property) ? shape.properties[property] : undefined;
        if (declared === undefined) return { kind: 'unknown-property' };
        if (declared.exposed) return { kind: 'exposed' };
        if (declared.runtime) return { kind: 'runtime' };

        const node = { component, [property]: value } as unknown as Node;
        const prefix = `${nodeStatePath}.${property}`;
        const errors = validateNode(shape, node, nodeStatePath, { isIconName: this.isIconName }).filter(
            (error) => error.statePath === prefix || error.statePath?.startsWith(`${prefix}.`) === true
        );
        if (errors.length > 0) return { kind: 'invalid', errors };
        return { kind: 'ok', content: declared.kind === 'content' || property.startsWith('_') };
    }

    /** The resolved application, or `undefined` when `app` is missing or does not resolve */
    private assemble(document: UiDocument): AssembledApp | undefined {
        const app = document['app'];
        if (!isJsonObject(app) || typeof app['component'] !== 'string') return undefined;
        const composed = composedOf(document);
        const resolved = resolveNode(app as unknown as Node, this.library, composed as DocumentComposed);
        if (resolved.errors.length > 0) return undefined;
        const extracted = extractLinks(resolved.node, { library: this.library, instances: resolved.instances });
        return {
            tree: withoutLinked(extracted.tree as unknown as JsonObject, extracted.linkedPaths),
            linkedPaths: extracted.linkedPaths,
            instances: resolved.instances,
            composed
        };
    }

    /** The shipped overlays of the components for one language; only codes the catalog lists are read from disk */
    private componentOverlays(code: string): ComponentOverlays {
        const cached = this.overlaysByCode.get(code);
        if (cached !== undefined) return cached;
        const overlays: Record<string, Record<string, LibraryJsonObject>> = {};
        for (const component of this.catalog.components) {
            if (!component.locales.includes(code)) continue;
            const overlay = loadComponentOverlay(component.name, code);
            if (overlay !== undefined) overlays[component.name] = { [code]: overlay as unknown as LibraryJsonObject };
        }
        this.overlaysByCode.set(code, overlays);
        return overlays;
    }

    private overlayOf(document: UiDocument, code: string, assembled: AssembledApp): JsonObject {
        const locales = document['locales'];
        const own = isJsonObject(locales) && Object.hasOwn(locales, code) ? locales[code] : undefined;
        return buildAppOverlay(
            code,
            assembled.tree as unknown as LibraryJsonObject,
            this.componentOverlays(code),
            (isJsonObject(own) ? own : {}) as unknown as LibraryJsonObject,
            {
                library: this.library,
                composed: assembled.composed as DocumentComposed,
                instances: assembled.instances,
                linkedPaths: assembled.linkedPaths
            }
        ) as unknown as JsonObject;
    }

    /** `SUI-LOCALE-MISSING` warnings for each language the document declares in `locales` */
    private untranslated(document: UiDocument): UiBuildError[] {
        const locales = document['locales'];
        if (!isJsonObject(locales)) return [];
        const assembled = this.assemble(document);
        if (assembled === undefined) return [];
        const base = extractBaseOverlay(assembled.tree as unknown as LibraryJsonObject, assembled.linkedPaths);
        return Object.keys(locales).flatMap((code) =>
            findUntranslated(code, base, this.overlayOf(document, code, assembled) as unknown as LibraryJsonObject)
        );
    }
}

/** The warning code of a layout that does not fit a phone */
export const VIEWPORT_WARNING = 'SUI-VIEWPORT-NARROW';

/**
 * Layouts that do not fit a phone: a page whose side nav never collapses (`navBreakpoint` 0 with the nav at the
 * start) keeps the nav beside the content at every width and squeezes the content
 */
function viewportWarnings(document: UiDocument): UiBuildError[] {
    const warnings: UiBuildError[] = [];
    const visit = (value: unknown, path: string): void => {
        if (!isJsonObject(value)) return;
        if (value['component'] === 'page' && isJsonObject(value['nav']) && value['navBreakpoint'] === 0 && (value['navPosition'] ?? 'start') === 'start') {
            warnings.push({
                code: VIEWPORT_WARNING,
                severity: 'warning',
                statePath: path,
                component: 'page',
                message: `The page at ${path} has navBreakpoint 0, so its side nav stays beside the content on a phone; leave navBreakpoint out (768) so the nav moves behind a menu button on narrow screens`
            });
        }
        for (const [key, item] of Object.entries(value)) if (isJsonObject(item)) visit(item, `${path}.${key}`);
    };
    visit(document['app'], '$.app');
    return warnings;
}

/** An unknown component name gets the nearest known names appended, so a typo is a one-step fix */
function withNearestNames(error: UiBuildError, known: readonly string[]): UiBuildError {
    if (error.code !== UNKNOWN_COMPONENT || error.component === undefined || error.component === NO_COMPONENT) return error;
    const nearest = nearestNames(error.component, known);
    if (nearest.length === 0) return error;
    return { ...error, message: `${error.message}. Nearest names: ${nearest.join(', ')}` };
}
