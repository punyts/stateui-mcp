import type { PartRef } from '@punyts/stateui-app/core';
import { PART_KINDS } from '../domain/partName.js';
import type { PartKind } from '../domain/partName.js';
import { partReferences, startScreen } from '../domain/partReferences.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import type { UiPartRepository } from './ports/UiPartRepository.js';

function keyOf(kind: PartKind, name: string): string {
    return `${kind}/${name}`;
}

function byKindThenName(a: PartRef, b: PartRef): number {
    const kinds = PART_KINDS.indexOf(a.kind) - PART_KINDS.indexOf(b.kind);
    if (kinds !== 0) return kinds;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Where a use case gets the usage index: `IndexedUiPartRepository` */
export interface UsageSource {
    usage(): Promise<UsageIndex>;
}

/**
 * Who uses what among the owner's parts, in memory. Each part's direct references come from its body
 * (`partReferences`: an app's `uses` and the components in its nodes, a module's `needs`, a dataset's `model`, the
 * components in a component's tree); a reference to a name the owner has no part of (a library component, a missing
 * part) is kept and counts once a part of that name exists. The index follows the stored files: a rename moves only the
 * renamed part, so the parts that still name the old name keep using it until they are rewritten
 */
export class UsageIndex {
    private readonly references = new Map<string, readonly PartRef[]>();
    private readonly parts = new Map<string, PartRef>();
    private readonly starts = new Map<string, string>();

    /** The index of every part in `repository` */
    static async build(repository: UiPartRepository): Promise<UsageIndex> {
        const index = new UsageIndex();
        for (const kind of PART_KINDS) {
            for (const { name } of await repository.list(kind)) {
                const part = await repository.findByName(kind, name);
                if (part !== undefined) index.set(kind, name, part.body);
            }
        }
        return index;
    }

    /** Records a part created or written */
    set<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K]): void {
        const key = keyOf(kind, name);
        this.parts.set(key, { kind, name });
        this.references.set(
            key,
            partReferences(kind, body).filter((ref) => ref.kind !== kind || ref.name !== name)
        );
        if (kind !== 'apps') return;
        const start = startScreen(body as UiPartBodies['apps']);
        if (start === undefined) this.starts.delete(name);
        else this.starts.set(name, start);
    }

    remove(kind: PartKind, name: string): void {
        const key = keyOf(kind, name);
        this.parts.delete(key);
        this.references.delete(key);
        if (kind === 'apps') this.starts.delete(name);
    }

    /** Moves a part to its new name with its own references; references to it elsewhere are the writes of those parts */
    rename(kind: PartKind, from: string, to: string): void {
        const references = this.references.get(keyOf(kind, from));
        const start = kind === 'apps' ? this.starts.get(from) : undefined;
        this.remove(kind, from);
        this.parts.set(keyOf(kind, to), { kind, name: to });
        this.references.set(keyOf(kind, to), references ?? []);
        if (start !== undefined) this.starts.set(to, start);
    }

    has(kind: PartKind, name: string): boolean {
        return this.parts.has(keyOf(kind, name));
    }

    /**
     * The parts that name this part directly, by kind then name. With `kind: "screens"`, `name` is a screen of `app`, and
     * the app is its user when the screen is the app's `start`
     */
    usedBy(kind: PartKind, name: string): PartRef[];
    usedBy(kind: 'screens', name: string, app: string): PartRef[];
    usedBy(kind: PartKind | 'screens', name: string, app?: string): PartRef[] {
        if (kind === 'screens') return app !== undefined && this.starts.get(app) === name ? [{ kind: 'apps', name: app }] : [];
        const users: PartRef[] = [];
        for (const [key, references] of this.references) {
            if (references.some((ref) => ref.kind === kind && ref.name === name)) users.push(this.parts.get(key) as PartRef);
        }
        return users.sort(byKindThenName);
    }

    /** The owner parts an app names directly, in the order found; library components and missing parts are left out */
    uses(app: string): PartRef[] {
        return (this.references.get(keyOf('apps', app)) ?? []).filter((ref) => this.has(ref.kind, ref.name));
    }

    /** The apps that reach this part through any chain of parts (a model through a dataset or a module), by name */
    appsUsing(kind: PartKind, name: string): string[] {
        const apps = new Set<string>();
        const seen = new Set<string>([keyOf(kind, name)]);
        const queue: PartRef[] = [{ kind, name }];
        for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
            for (const user of this.usedBy(ref.kind, ref.name)) {
                if (user.kind === 'apps') apps.add(user.name);
                const key = keyOf(user.kind, user.name);
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push(user);
            }
        }
        return [...apps].sort();
    }
}
