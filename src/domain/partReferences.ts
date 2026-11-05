import type { PartRef } from '@punyts/stateui-app/core';
import type { PartKind } from './partName.js';
import type { UiPartBodies } from './UiPart.js';

/** How a part of each kind is named in a sentence */
export const PART_KIND_WORDS: Readonly<Record<PartKind, string>> = {
    apps: 'app',
    themes: 'theme',
    logic: 'logic module',
    models: 'model',
    data: 'dataset',
    components: 'component',
    patterns: 'pattern'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `component` name of every node under `value`, in the order found; library names included */
export function componentNames(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) componentNames(item, into);
        return into;
    }
    if (!isRecord(value)) return into;
    const name = value['component'];
    if (typeof name === 'string' && !into.includes(name)) into.push(name);
    for (const [key, child] of Object.entries(value)) {
        if (key !== 'component') componentNames(child, into);
    }
    return into;
}

class Refs {
    readonly list: PartRef[] = [];
    private readonly seen = new Set<string>();

    add(kind: PartKind, name: unknown): void {
        if (typeof name !== 'string') return;
        const key = `${kind}/${name}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.list.push({ kind, name });
    }
}

function appReferences(app: UiPartBodies['apps'], refs: Refs): void {
    const uses = isRecord(app.uses) ? app.uses : {};
    for (const theme of Array.isArray(uses.themes) ? uses.themes : []) refs.add('themes', theme);
    for (const binding of Object.values(isRecord(uses.data) ? uses.data : {})) {
        if (!isRecord(binding)) continue;
        if ('dataset' in binding) refs.add('data', binding['dataset']);
        else refs.add('models', binding['model']);
    }
    for (const module of Object.keys(isRecord(uses.logic) ? uses.logic : {})) refs.add('logic', module);
    const names = componentNames(app.shell);
    for (const screen of Object.values(isRecord(app.screens) ? app.screens : {})) {
        if (isRecord(screen)) componentNames(screen['root'], names);
    }
    for (const name of names) refs.add('components', name);
}

/**
 * The parts a part names directly, once each, in the order found. An app: its themes, its datasets (a persona
 * binding names a model), its logic modules and the components in its shell and screens; a logic module: the models of
 * its `needs`; a dataset: its model; a component or a pattern: the components in its tree. Component names include
 * library components, which are no parts: the caller keeps only the names the owner has. Bodies are read loosely, so a
 * part that does not read as its kind gives what can be found
 */
export function partReferences<K extends PartKind>(kind: K, body: UiPartBodies[K]): PartRef[] {
    const refs = new Refs();
    if (kind === 'apps') appReferences(body as UiPartBodies['apps'], refs);
    else if (kind === 'logic') {
        const needs = (body as UiPartBodies['logic']).needs;
        for (const need of Object.values(isRecord(needs) ? needs : {})) {
            if (isRecord(need)) refs.add('models', need['model']);
        }
    } else if (kind === 'data') refs.add('models', (body as UiPartBodies['data']).model);
    else if (kind === 'components' || kind === 'patterns') {
        for (const name of componentNames((body as UiPartBodies['components' | 'patterns']).tree)) refs.add('components', name);
    }
    return refs.list;
}

/** The `start` screen of an app, which cannot be deleted */
export function startScreen(app: UiPartBodies['apps']): string | undefined {
    return typeof app.start === 'string' ? app.start : undefined;
}
