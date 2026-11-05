import type { ComponentCatalog } from './ports/ComponentCatalog.js';

/** The components a written token reaches */
export interface TokenReach {
    readonly token: string;
    readonly components: readonly string[];
}

const REFERENCE = /\{([^{}]+)\}/g;

function referencesIn(value: string): string[] {
    return [...value.matchAll(REFERENCE)].map((match) => match[1] as string);
}

/** True when one path is the other or lies below it: writing `palette.blue` reaches `{palette.blue.500}` */
function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * The components each token path reaches, from the catalog's defaults: a component whose own token is that path or
 * refers to it, directly or through one semantic token (`palette.blue.500` → `color.accent.base` → `button`)
 */
export function tokenReach(catalog: ComponentCatalog, paths: readonly string[]): TokenReach[] {
    const semantic = catalog.listTokens();
    const components = catalog.list().flatMap((summary) => {
        const entry = catalog.get(summary.name);
        return entry === undefined ? [] : [{ name: entry.name, tokens: entry.tokens }];
    });
    return [...new Set(paths)].map((token) => {
        const via = [token, ...semantic.filter((entry) => referencesIn(entry.default).some((ref) => overlaps(ref, token))).map((entry) => entry.path)];
        const reached = components
            .filter((component) =>
                component.tokens.some((own) => overlaps(own.path, token) || referencesIn(own.default).some((ref) => via.some((path) => overlaps(ref, path))))
            )
            .map((component) => component.name);
        return { token, components: reached };
    });
}
