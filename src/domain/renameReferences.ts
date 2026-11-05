import type { PartKind } from './partName.js';
import type { UiPartBodies } from './UiPart.js';

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of `record` with the key `from` called `to`, in the same place; every other key keeps its place */
function renameKey(record: Record<string, Json>, from: string, to: string): Record<string, Json> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key === from ? to : key, value]));
}

/** A copy of `value` in which every object whose `component` is `from` names `to` instead */
function renameComponents(value: Json, from: string, to: string): Json {
    if (Array.isArray(value)) return value.map((item) => renameComponents(item, from, to));
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, key === 'component' && child === from ? to : renameComponents(child, from, to)])
    );
}

/** A copy of `value` in which every `navigate` command to the screen `from` goes to `to` */
function renameNavigateTargets(value: Json, from: string, to: string): Json {
    if (Array.isArray(value)) return value.map((item) => renameNavigateTargets(item, from, to));
    if (!isRecord(value)) return value;
    const navigates = value['command'] === 'navigate' && value['target'] === from;
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, navigates && key === 'target' ? to : renameNavigateTargets(child, from, to)])
    );
}

function appWithReferences(app: Record<string, Json>, kind: PartKind, from: string, to: string): Record<string, Json> {
    const next: Record<string, Json> = { ...app };
    const uses = isRecord(app['uses']) ? { ...app['uses'] } : undefined;
    if (uses !== undefined) {
        if (kind === 'themes' && Array.isArray(uses['themes'])) uses['themes'] = uses['themes'].map((theme) => (theme === from ? to : theme));
        if ((kind === 'data' || kind === 'models') && isRecord(uses['data'])) {
            const field = kind === 'data' ? 'dataset' : 'model';
            uses['data'] = Object.fromEntries(
                Object.entries(uses['data']).map(([key, binding]) => [key, isRecord(binding) && binding[field] === from ? { ...binding, [field]: to } : binding])
            );
        }
        if (kind === 'logic' && isRecord(uses['logic']) && Object.hasOwn(uses['logic'], from)) uses['logic'] = renameKey(uses['logic'], from, to);
        next['uses'] = uses;
    }
    if (kind === 'components') {
        if ('shell' in app) next['shell'] = renameComponents(app['shell'], from, to);
        if (isRecord(app['screens'])) next['screens'] = renameComponents(app['screens'], from, to);
    }
    return next;
}

/**
 * The body of a part of kind `of` with every reference to the part `kind`/`from` naming `to` instead, or undefined
 * when the body names no such part. What is rewritten: an app's theme list, its bindings' `dataset` or `model`, its
 * `uses.logic` key (in its place) and the `component` of its shell and screen nodes; a logic module's `needs` models; a
 * dataset's `model`; the `component` of the nodes of a component's or a pattern's tree. The input is not changed and
 * every key keeps its place
 */
export function bodyWithRenamedPart<K extends PartKind>(of: K, body: UiPartBodies[K], kind: PartKind, from: string, to: string): UiPartBodies[K] | undefined {
    const source = body as unknown as Record<string, Json>;
    let next: Record<string, Json> = source;
    if (of === 'apps') next = appWithReferences(source, kind, from, to);
    else if (of === 'logic' && kind === 'models' && isRecord(source['needs'])) {
        const needs = Object.fromEntries(
            Object.entries(source['needs']).map(([key, need]) => [key, isRecord(need) && need['model'] === from ? { ...need, model: to } : need])
        );
        next = { ...source, needs };
    } else if (of === 'data' && kind === 'models' && source['model'] === from) next = { ...source, model: to };
    else if ((of === 'components' || of === 'patterns') && kind === 'components' && 'tree' in source) {
        next = { ...source, tree: renameComponents(source['tree'], from, to) };
    }
    return JSON.stringify(next) === JSON.stringify(source) ? undefined : (structuredClone(next) as unknown as UiPartBodies[K]);
}

/**
 * The app with its screen `from` called `to`: the key in `screens` (in its place), `start` and every `navigate` command
 * to it anywhere in the body. Undefined when the app has no such screen
 */
export function appWithRenamedScreen(app: UiPartBodies['apps'], from: string, to: string): UiPartBodies['apps'] | undefined {
    const source = app as unknown as Record<string, Json>;
    const screens = source['screens'];
    if (!isRecord(screens) || !Object.hasOwn(screens, from)) return undefined;
    const next = renameNavigateTargets({ ...source, screens: renameKey(screens, from, to) }, from, to) as Record<string, Json>;
    if (next['start'] === from) next['start'] = to;
    return structuredClone(next) as unknown as UiPartBodies['apps'];
}

/** True when the app has a screen of this name */
export function hasScreen(app: UiPartBodies['apps'], name: string): boolean {
    const screens = (app as unknown as Record<string, Json>)['screens'];
    return isRecord(screens) && Object.hasOwn(screens, name);
}
