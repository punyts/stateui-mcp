import type { PartRef, PartSource } from '@punyts/stateui-app/core';
import type { PartKind } from '../domain/partName.js';
import { partReferences } from '../domain/partReferences.js';
import type { UiPartRepository } from './ports/UiPartRepository.js';

/** The key of `PartSource` that holds parts of each kind; apps and patterns are never in a source */
const SOURCE_KEYS: Partial<Record<PartKind, keyof PartSource>> = {
    themes: 'themes',
    logic: 'modules',
    models: 'models',
    data: 'datasets',
    components: 'components'
};

/**
 * The owner parts reachable from `start`, loaded into a `PartSource`: each part found brings in the parts it names
 * (a module's models, a dataset's model, a component's nested components). Names the owner has no part of (library
 * components, missing parts) are left out, so assembling reports them; when one is missing, every part of its kind is
 * loaded too, so the error can name the nearest names the owner has
 */
export async function loadPartSource(parts: UiPartRepository, start: readonly PartRef[]): Promise<PartSource> {
    const source: Record<string, Record<string, unknown>> = {};
    const seen = new Set<string>();
    const listed = new Set<PartKind>();
    const queue = [...start];
    for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
        const key = SOURCE_KEYS[ref.kind];
        const id = `${ref.kind}/${ref.name}`;
        if (key === undefined || seen.has(id)) continue;
        seen.add(id);
        const part = await parts.findByName(ref.kind, ref.name);
        if (part === undefined) {
            // A library component is not missing, but the kind's names are what a misspelt owner component is near too
            if (!listed.has(ref.kind)) {
                listed.add(ref.kind);
                for (const { name } of await parts.list(ref.kind)) queue.push({ kind: ref.kind, name });
            }
            continue;
        }
        (source[key] ??= {})[ref.name] = part.body;
        queue.push(...partReferences(ref.kind, part.body));
    }
    return source as PartSource;
}
