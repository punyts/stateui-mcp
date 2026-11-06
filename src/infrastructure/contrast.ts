import { SHIPPED_OVERLAYS, contrastRatio, mergeOverDefaults, mergeTokenTrees, referencesOf } from '@punyts/stateui-app/core';
import type { JsonObject as LibraryJsonObject, ThemePart, TokenTree } from '@punyts/stateui-app/core';
import type { ContrastPair } from '../application/ports/UiAppValidator.js';

export { contrastRatio };

/** WCAG AA for normal text */
export const AA_CONTRAST = 4.5;

const TONES = ['neutral', 'accent', 'danger', 'warning', 'success', 'info'] as const;
const SURFACE = 'color.surface.base';
const MAX_CHAIN = 32;

function valueAt(tree: TokenTree, path: string): string | TokenTree | undefined {
    let cursor: string | TokenTree | undefined = tree;
    for (const segment of path.split('.')) {
        if (cursor === undefined || typeof cursor === 'string') return undefined;
        cursor = cursor[segment];
    }
    return cursor;
}

/** Follows single references to a literal; `undefined` when the chain breaks, loops or mixes text with a reference */
function literal(tree: TokenTree, path: string): string | undefined {
    let current = valueAt(tree, path);
    for (let step = 0; step < MAX_CHAIN; step += 1) {
        if (typeof current !== 'string') return undefined;
        const refs = referencesOf(current);
        if (refs.length === 0) return current;
        if (refs.length !== 1 || current.trim() !== `{${refs[0]}}`) return undefined;
        current = valueAt(tree, refs[0] as string);
    }
    return undefined;
}

/** Text tokens drawn somewhere other than on `color.surface.base`, with the token they are drawn on */
const TEXT_SURFACES: Readonly<Record<string, string>> = Object.freeze({ inverse: 'color.text.base' });

/** Text tokens left out: disabled text is exempt from the WCAG contrast minimum */
const TEXT_EXEMPT: ReadonlySet<string> = new Set(['disabled']);

/**
 * The text-on-surface pairs of the tree: each `color.text.*` on `color.surface.base` (but `inverse` on `text.base`,
 * the fill of a tooltip, and no `disabled`), and each tone's `on` on its `base`
 */
function pairsOf(tree: TokenTree): [string, string][] {
    const text = valueAt(tree, 'color.text');
    const keys = typeof text === 'object' ? Object.keys(text).filter((key) => !TEXT_EXEMPT.has(key)) : [];
    const pairs: [string, string][] = keys.map((key) => [`color.text.${key}`, TEXT_SURFACES[key] ?? SURFACE]);
    for (const tone of TONES) if (valueAt(tree, `color.${tone}.on`) !== undefined) pairs.push([`color.${tone}.on`, `color.${tone}.base`]);
    return pairs;
}

/**
 * The modes a theme has at run time: the shipped ones, then its own `mode` overlays. An own overlay named like a shipped
 * mode refines it, its tokens merged over the shipped ones, as `buildOverlayCatalog` does
 */
function modesOf(theme: ThemePart): [string, LibraryJsonObject][] {
    const modes: [string, LibraryJsonObject][] = Object.entries(SHIPPED_OVERLAYS['mode'] ?? {}).map(([name, overlay]) => [name, overlay.tokens]);
    for (const [name, overlay] of Object.entries(theme.overlays ?? {})) {
        if (overlay.kind !== 'mode') continue;
        const at = modes.findIndex(([taken]) => taken === name);
        if (at === -1) modes.push([name, overlay.tokens]);
        else modes[at] = [name, mergeTokenTrees(modes[at]![1], overlay.tokens)];
    }
    return modes;
}

/**
 * The WCAG contrast of each text token on its surface in each mode of the theme: the defaults, the mode overlay and
 * the theme's tokens over both, as the runtime merges them. A pair that does not resolve to two opaque colours is `unresolved`
 */
export function themeContrast(theme: ThemePart): ContrastPair[] {
    const report: ContrastPair[] = [];
    for (const [mode, overlay] of modesOf(theme)) {
        const tree = mergeOverDefaults(mergeTokenTrees(overlay, theme.tokens));
        for (const [text, surface] of pairsOf(tree)) {
            const a = literal(tree, text);
            const b = literal(tree, surface);
            const ratio = a === undefined || b === undefined ? undefined : contrastRatio(a, b);
            report.push(
                ratio === undefined
                    ? { mode, text, surface, ratio: 'unresolved' }
                    : { mode, text, surface, ratio: Math.floor(ratio * 100) / 100, passesAA: ratio >= AA_CONTRAST }
            );
        }
    }
    return report;
}
