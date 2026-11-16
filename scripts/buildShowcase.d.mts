/** The name of the showcase app */
export declare const SHOWCASE_APP: string;
export declare const EXAMPLES_DIR: string;
export declare const FILES_DIR: string;
export declare const PARTS_DIR: string;
/** Catalog components the showcase leaves out, each with the reason */
export declare const EXCLUDED: Readonly<Record<string, string>>;
/** The categories in the order of the category index */
export declare const CATEGORY_ORDER: readonly string[];
/** The catalog of @punyts/stateui-components */
export declare function loadCatalog(): unknown;
/** A stable UUID for a name */
export declare function stableId(name: string): string;
/** Every file of showcase/parts, by its path under it with forward slashes: JSON text or the bytes of a shipped file */
export declare function buildShowcase(catalog?: unknown, examplesDir?: string, filesDir?: string): Map<string, string | Buffer>;
/** Writes the built files to `dir`, removing what was there */
export declare function writeShowcase(files: Map<string, string | Buffer>, dir?: string): void;
