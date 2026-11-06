import { OUTLET_COMPONENT, checkPattern, checkRecord, nearestNames, readBlueprint, readModel, readModule, readPattern, validateApp } from '@punyts/stateui-app/core';
import type { AppBlueprint, ComponentLibrary, JsonValue as LibraryJsonValue, LibraryEntry, Node, PartSource, PatternKind } from '@punyts/stateui-app/core';
import type { UiPartError } from '../application/ports/UiAppValidator.js';
import { isJsonObject } from '../domain/JsonValue.js';
import type { PartKind } from '../domain/partName.js';
import { PART_KIND_WORDS } from '../domain/partReferences.js';
import type { UiBuildError } from '../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../domain/UiPart.js';
import type { UiPartBodies } from '../domain/UiPart.js';


export interface PartCheckContext {
    readonly library: ComponentLibrary;
    readonly isIconName: (name: string) => boolean;
    /** True for a token name the theme has; the `paint` validator reports an unknown `{token}` colour (`SUI-STATE-TOKEN`) */
    readonly hasToken?: (name: string) => boolean;
}

function shapeError(kind: PartKind, name: string, path: string, reason: string): UiBuildError {
    return { code: PART_SHAPE_CODE, statePath: path, message: `The ${PART_KIND_WORDS[kind]} "${name}" at ${path} is not valid: ${reason}` };
}

function isNode(value: unknown): boolean {
    return isJsonObject(value) && typeof value['component'] === 'string';
}

/** `validateApp` of the library, each error with the part that holds it */
export function assembledErrors(blueprint: AppBlueprint, parts: PartSource, name: string, context: PartCheckContext): UiPartError[] {
    return validateApp(blueprint, parts, context.library, { name, isIconName: context.isIconName, ...(context.hasToken !== undefined && { hasToken: context.hasToken }) }).errors.map((error) => ({ ...error }));
}

/** The errors one part holds when a probe app uses it: the app is a bare outlet shell with one screen of `root` */
function probeErrors(kind: PartKind, name: string, uses: AppBlueprint['uses'], root: Node, parts: PartSource, context: PartCheckContext): UiBuildError[] {
    const outlet: Node = { component: OUTLET_COMPONENT } as Node;
    const probe: AppBlueprint = { start: 'main', shell: outlet, screens: { main: { root } }, ...(uses !== undefined && { uses }) };
    return assembledErrors(probe, parts, `probe-${name}`, context).filter((error) => error.part.kind === kind && error.part.name === name);
}

function appErrors(name: string, body: UiPartBodies['apps'], parts: PartSource, context: PartCheckContext): UiBuildError[] {
    const read = readBlueprint(body as unknown as LibraryJsonValue);
    if (read.blueprint === undefined) return read.errors;
    return assembledErrors(read.blueprint, parts, name, context).filter((error) => error.part.kind === 'apps' && error.part.name === name);
}

function themeErrors(name: string, body: UiPartBodies['themes'], parts: PartSource, context: PartCheckContext): UiBuildError[] {
    if (!isJsonObject(body.tokens)) return [shapeError('themes', name, '$.tokens', 'needs an object of tokens')];
    if (body.overlays !== undefined && !isJsonObject(body.overlays)) return [shapeError('themes', name, '$.overlays', 'must be an object of overlays by name')];
    const themes = { ...parts.themes, [name]: body };
    return probeErrors('themes', name, { themes: [name] }, { component: OUTLET_COMPONENT } as Node, { ...parts, themes }, context);
}

function componentErrors(name: string, body: UiPartBodies['components'], parts: PartSource, context: PartCheckContext): UiBuildError[] {
    if (!isNode(body.tree)) return [shapeError('components', name, '$.tree', 'must be a node with a "component" name')];
    if (!Array.isArray(body.exposes)) return [shapeError('components', name, '$.exposes', 'must be a list of { path, description }')];
    const components = { ...parts.components, [name]: body };
    return probeErrors('components', name, undefined, { component: name } as Node, { ...parts, components }, context);
}

function datasetErrors(name: string, body: UiPartBodies['data'], parts: PartSource): UiBuildError[] {
    if (!isJsonObject(body.records)) return [shapeError('data', name, '$.records', 'must be an object of records by key')];
    if (body.model === undefined) {
        const notRecords = Object.keys(body.records).filter((key) => !isJsonObject(body.records[key]));
        return notRecords.map((key) => shapeError('data', name, `$.records.${key}`, 'a record must be an object'));
    }
    if (typeof body.model !== 'string') return [shapeError('data', name, '$.model', 'must be the name of a model')];
    const model = parts.models?.[body.model];
    if (model === undefined) {
        const near = nearestNames(body.model, Object.keys(parts.models ?? {}));
        return [shapeError('data', name, '$.model', `the owner has no model "${body.model}"; nearest names: ${near.length > 0 ? near.join(', ') : '(none)'}`)];
    }
    return Object.entries(body.records).flatMap(([key, record]) =>
        checkRecord(model, record as LibraryJsonValue, key).map((error) => ({ ...error, statePath: `$.records.${key}` }))
    );
}

/** The file-like path a pattern part's errors name, as a library pattern's name its file */
export function patternFile(name: string): string {
    return `patterns/${name}.pattern.json`;
}

/**
 * A pattern is checked as the library build checks its patterns (`readPattern` and `checkPattern` of the library):
 * shape and purposes, components, nodes, slot and param paths and the one outlet of a shell. The owner's components
 * count as composed components of the library, so a pattern may use them
 */
function patternErrors(name: string, body: UiPartBodies['patterns'], parts: PartSource, context: PartCheckContext): UiBuildError[] {
    const file = patternFile(name);
    const read = readPattern(body as unknown as LibraryJsonValue, file, (isJsonObject(body) ? body.kind : undefined) as PatternKind);
    if (read.pattern === undefined) return read.errors;
    const owned = Object.fromEntries(
        Object.entries(parts.components ?? {})
            .filter(([component]) => !Object.hasOwn(context.library, component))
            .map(([component, part]) => [component, { tier: 'composed', tree: part.tree } satisfies LibraryEntry])
    );
    return checkPattern(read.pattern, { ...context.library, ...owned }, file);
}

/**
 * The errors of one part on its own. Apps, logic modules and models have readers in the library; a theme and a
 * component are checked as a probe app that uses them would be, keeping only the errors the part holds; a dataset's
 * records are checked against its model, each error at `$.records.{key}`; a pattern as the library build checks one
 */
export function partErrors<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], parts: PartSource, context: PartCheckContext): UiBuildError[] {
    switch (kind) {
        case 'apps':
            return appErrors(name, body as UiPartBodies['apps'], parts, context);
        case 'themes':
            return themeErrors(name, body as UiPartBodies['themes'], parts, context);
        case 'logic':
            return readModule(body as unknown as LibraryJsonValue).errors;
        case 'models':
            return readModel(body as unknown as LibraryJsonValue).errors;
        case 'data':
            return datasetErrors(name, body as UiPartBodies['data'], parts);
        case 'components':
            return componentErrors(name, body as UiPartBodies['components'], parts, context);
        default:
            return patternErrors(name, body as UiPartBodies['patterns'], parts, context);
    }
}
