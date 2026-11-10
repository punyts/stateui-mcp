import type { PartRef } from '@punyts/stateui-app/core';
import { partReferences } from '../domain/partReferences.js';
import { bodyWithRenamedPart } from '../domain/renameReferences.js';
import type { PartKind } from '../domain/partName.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import type { UiPartRepository } from './ports/UiPartRepository.js';

/** A part the copy made in the target, and the name it had in the source when it got another one */
export interface CopiedPart {
    readonly kind: PartKind;
    readonly name: string;
    readonly from?: string;
}

export type CopyAppResult =
    | {
          readonly kind: 'copied';
          readonly app: UiPart<'apps'>;
          /** The parts made in the target besides the app; a part the target already had with the same body is reused */
          readonly parts: readonly CopiedPart[];
      }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'failed'; readonly reason: string };

export interface CopyAppOptions {
    /** The copy's name; default the app's name. Either gets `-2`, `-3`… when the target has an app of that name */
    readonly name?: string;
}

const MAX_NAME = 63;

/** `name`, or `name-2`, `name-3`… : the first that `taken` does not hold, cut to fit a part name */
function freeName(name: string, taken: (candidate: string) => boolean): string {
    if (!taken(name)) return name;
    for (let n = 2; ; n++) {
        const suffix = `-${n}`;
        const candidate = `${name.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
        if (!taken(candidate)) return candidate;
    }
}

/**
 * Copies an app and every part it reaches (its themes, datasets and models, logic modules and composed components,
 * and what those reach in turn) from one owner's parts to another's, as a remix does. The copy is the definition only:
 * no persona's state and none of the app's uploaded files come along.
 *
 * A reached part the target already has under its name with the same body is reused. One whose name the target uses for
 * something else is copied under a free name (`theme-2`), and every copied body that names it is rewritten to match.
 * The parts are made before the app, so a failure leaves the target without the app (parts made before it stay)
 */
export async function copyAppParts(
    from: Pick<UiPartRepository, 'findById' | 'findByName'>,
    to: Pick<UiPartRepository, 'findByName' | 'create'>,
    appId: string,
    options: CopyAppOptions = {}
): Promise<CopyAppResult> {
    const app = await from.findById('apps', appId);
    if (app === undefined) return { kind: 'not-found' };

    // Every part the app reaches, once each, in the order found; names that are no parts (library components) drop out
    const reached: UiPart[] = [];
    const seen = new Set<string>();
    const queue: PartRef[] = partReferences('apps', app.body);
    while (queue.length > 0) {
        const ref = queue.shift() as PartRef;
        const key = `${ref.kind}/${ref.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const part = await from.findByName(ref.kind, ref.name);
        if (part === undefined) continue;
        reached.push(part);
        queue.push(...partReferences(part.kind, part.body as never));
    }

    // What each reached part is called in the target
    const planned = new Set<string>();
    const sourceNames = new Set(reached.map((part) => `${part.kind}/${part.name}`));
    const renames: { kind: PartKind; from: string; to: string }[] = [];
    const toMake: UiPart[] = [];
    for (const part of reached) {
        const existing = await to.findByName(part.kind, part.name);
        if (existing !== undefined && JSON.stringify(existing.body) === JSON.stringify(part.body)) continue;
        let name = part.name;
        if (existing !== undefined) {
            const names: string[] = [];
            // Free in the target, not planned, and not the name of another reached part of the kind
            for (let tries = 0; tries < 50; tries++) {
                name = freeName(part.name, (candidate) => planned.has(`${part.kind}/${candidate}`) || sourceNames.has(`${part.kind}/${candidate}`) || names.includes(candidate));
                if ((await to.findByName(part.kind, name)) === undefined) break;
                names.push(name);
            }
            renames.push({ kind: part.kind, from: part.name, to: name });
        }
        planned.add(`${part.kind}/${name}`);
        toMake.push(part);
    }
    const renamed = <K extends PartKind>(kind: K, body: UiPartBodies[K]): UiPartBodies[K] => {
        let next = body;
        for (const rename of renames) next = bodyWithRenamedPart(kind, next, rename.kind, rename.from, rename.to) ?? next;
        return next;
    };
    const nameIn = (part: UiPart): string => renames.find((rename) => rename.kind === part.kind && rename.from === part.name)?.to ?? part.name;

    // What a part needs is found after it, so the last found is made first
    const made: CopiedPart[] = [];
    for (const part of [...toMake].reverse()) {
        const name = nameIn(part);
        const created = await to.create({ kind: part.kind, name, body: renamed(part.kind, part.body) });
        if (created.kind !== 'created') return { kind: 'failed', reason: created.kind === 'invalid' ? created.reason : `The ${part.kind} part "${name}" could not be made` };
        made.push({ kind: part.kind, name, ...(name !== part.name && { from: part.name }) });
    }

    const appNames: string[] = [];
    let name = options.name ?? app.name;
    for (let tries = 0; tries < 50; tries++) {
        name = freeName(options.name ?? app.name, (candidate) => appNames.includes(candidate));
        if ((await to.findByName('apps', name)) === undefined) break;
        appNames.push(name);
    }
    const created = await to.create({ kind: 'apps', name, body: renamed('apps', app.body) });
    if (created.kind !== 'created') return { kind: 'failed', reason: created.kind === 'invalid' ? created.reason : `The app "${name}" could not be made` };
    return { kind: 'copied', app: created.part, parts: made.reverse() };
}
