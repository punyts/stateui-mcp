/** The two lists of the catalog a search ranks by meaning */
export type CatalogKind = 'component' | 'pattern';

/** One library entry as it is embedded: its name and the text that says what it is for */
export interface CatalogText {
    readonly name: string;
    readonly text: string;
}

/** The library entries closest in meaning to a need, best first, and whether the best is close enough to rely on */
export interface CatalogMeaning {
    readonly ranked: readonly string[];
    readonly close: boolean;
}

/**
 * Ranks the library's components or patterns by the meaning of a need, for the requests the keyword index marks weak
 * (docs/design/magnetic-postgres.md, "Four kinds of semantic search"). The entries are given at each call, so an
 * implementation embeds them once per set of texts and model; `undefined` when it cannot rank now
 */
export interface CatalogMeanings {
    rank(kind: CatalogKind, need: string, entries: readonly CatalogText[], limit: number): Promise<CatalogMeaning | undefined>;
}
