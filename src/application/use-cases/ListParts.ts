import type { JsonValue } from '../../domain/JsonValue.js';
import type { PartKind } from '../../domain/partName.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** The parts of one kind, or the screens of one app; `query` keeps the ones whose name or title holds every word */
export type ListPartsInput =
    | { readonly kind: PartKind; readonly query?: string }
    | { readonly kind: 'screens'; readonly app: string; readonly query?: string };

/** One row of `ui_list`: no body. `title` where the kind has one (apps, screens); `uses` for apps */
export interface PartListItem {
    readonly name: string;
    readonly title?: string;
    /** The part's revision; a screen has none of its own (the app's is on the result) */
    readonly revision?: number;
    readonly updatedAt?: string;
    readonly uses?: JsonValue;
    /** A screen that is its app's `start` */
    readonly start?: true;
}

export type ListPartsResult =
    | { readonly kind: 'listed'; readonly items: readonly PartListItem[] }
    /** The screens of an app, with the app's revision (the one a screen write checks) */
    | { readonly kind: 'listed-screens'; readonly app: string; readonly revision: number; readonly items: readonly PartListItem[] }
    | { readonly kind: 'not-found'; readonly app: string };

function words(query: string | undefined): string[] {
    return (query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
}

function matches(wanted: readonly string[], name: string, title: string | undefined): boolean {
    const text = `${name} ${title ?? ''}`.toLowerCase();
    return wanted.every((word) => text.includes(word));
}

function titleOf(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const title = (value as Record<string, unknown>)['title'];
    return typeof title === 'string' ? title : undefined;
}

/**
 * Lists the owner's parts of one kind (name, revision, last update; an app also its title and `uses`) or the screens of
 * one app (name, title, which is `start`): parts in the repository's order (by name), screens in the app's. A query keeps an item when every word is in its name or
 * title, ignoring case; nothing is ranked
 */
export class ListParts {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: ListPartsInput): Promise<ListPartsResult> {
        const wanted = words(input.query);
        const result = input.kind === 'screens' ? await this.screens(input.app, wanted) : await this.list(input.kind, wanted);
        this.report.info('Part list', { kind: input.kind, outcome: result.kind, ...(result.kind !== 'not-found' && { count: result.items.length }) });
        return result;
    }

    private async list(kind: PartKind, wanted: readonly string[]): Promise<ListPartsResult> {
        const items: PartListItem[] = [];
        for (const summary of await this.parts.list(kind)) {
            let title: string | undefined;
            let uses: JsonValue | undefined;
            if (kind === 'apps') {
                const part = await this.parts.findById('apps', summary.id);
                if (part === undefined) continue;
                title = titleOf(part.body);
                uses = (part.body.uses ?? {}) as unknown as JsonValue;
            }
            if (!matches(wanted, summary.name, title)) continue;
            items.push({
                name: summary.name,
                ...(title !== undefined && { title }),
                revision: summary.revision,
                updatedAt: summary.updatedAt.toISOString(),
                ...(uses !== undefined && { uses })
            });
        }
        return { kind: 'listed', items };
    }

    private async screens(app: string, wanted: readonly string[]): Promise<ListPartsResult> {
        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return { kind: 'not-found', app };
        const items: PartListItem[] = [];
        for (const [name, screen] of Object.entries(part.body.screens ?? {})) {
            const title = titleOf(screen);
            if (!matches(wanted, name, title)) continue;
            items.push({ name, ...(title !== undefined && { title }), ...(part.body.start === name && { start: true as const }) });
        }
        return { kind: 'listed-screens', app, revision: part.revision, items };
    }
}
