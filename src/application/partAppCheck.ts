import type { JsonObject } from '../domain/JsonValue.js';
import { nearestNames } from '../domain/nearestNames.js';
import type { PartKind } from '../domain/partName.js';
import { partReferences } from '../domain/partReferences.js';
import { isBlockingError, isValid } from '../domain/UiBuildError.js';
import type { UiBuildError } from '../domain/UiBuildError.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { loadPartSource } from './partSource.js';
import type { PatternCatalog } from './ports/PatternCatalog.js';
import type { UiAppValidator } from './ports/UiAppValidator.js';
import type { UiPartRepository } from './ports/UiPartRepository.js';

/** A part an app names that the owner does not have, with the owner's names of that kind closest to it */
export interface MissingPart {
    readonly kind: PartKind;
    readonly name: string;
    readonly nearest: readonly string[];
}

export type PartAppCheck =
    | { readonly kind: 'checked'; readonly warnings: readonly UiBuildError[] }
    /** Themes, datasets, models or logic modules the app names that do not exist; nothing else was checked */
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    /** The blocking errors (and the warnings) of the app on its own or assembled with the parts it uses, each assembled error naming its part */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Checks an app body before it is stored, as a whole: every theme, dataset, model and logic module it names exists
 * (components are left to the validator, since most are the library's), its blueprint reads, and the app assembled with
 * those parts has no blocking error, wherever the error is: an unbound module need is an error of the module
 */
export async function checkPartApp(parts: UiPartRepository, validator: UiAppValidator, name: string, body: UiPartBodies['apps']): Promise<PartAppCheck> {
    const references = partReferences('apps', body);
    const missing: MissingPart[] = [];
    for (const reference of references) {
        if (reference.kind === 'components' || (await parts.findByName(reference.kind, reference.name)) !== undefined) continue;
        const known = (await parts.list(reference.kind)).map((summary) => summary.name);
        missing.push({ kind: reference.kind, name: reference.name, nearest: nearestNames(reference.name, known) });
    }
    if (missing.length > 0) return { kind: 'missing-parts', missing };
    const source = await loadPartSource(parts, references);
    const own = validator.validatePart('apps', name, body, source);
    if (!isValid(own)) return { kind: 'invalid', errors: own };
    const all = validator.validateAssembled(body, source, name);
    if (!isValid(all)) return { kind: 'invalid', errors: all };
    return { kind: 'checked', warnings: all.filter((error) => !isBlockingError(error)) };
}

/** A shell or a screen root: a library pattern with its params, or a node tree */
export type TreeChoice = { readonly pattern: string; readonly params?: JsonObject } | { readonly node: JsonObject };

export type TreeOutcome =
    | { readonly kind: 'tree'; readonly tree: JsonObject }
    /** No pattern of that name in the library */
    | { readonly kind: 'unknown-pattern'; readonly pattern: string }
    /** A screen pattern given as a shell, or a shell pattern as a screen */
    | { readonly kind: 'wrong-pattern-kind'; readonly pattern: string; readonly patternKind: 'shell' | 'screen' }
    /** Pattern params are applied by search epic 2 S2.6; until then a pattern with params is refused */
    | { readonly kind: 'pattern-params'; readonly pattern: string };

/** The tree a choice gives: the node as given, or a copy of the pattern's tree */
export function treeOf(choice: TreeChoice, want: 'shell' | 'screen', patterns: PatternCatalog): TreeOutcome {
    if ('node' in choice) return { kind: 'tree', tree: choice.node };
    const pattern = patterns.get(choice.pattern);
    if (pattern === undefined) return { kind: 'unknown-pattern', pattern: choice.pattern };
    if (pattern.kind !== want) return { kind: 'wrong-pattern-kind', pattern: choice.pattern, patternKind: pattern.kind };
    if (choice.params !== undefined && Object.keys(choice.params).length > 0) return { kind: 'pattern-params', pattern: choice.pattern };
    return { kind: 'tree', tree: structuredClone(pattern.tree) as unknown as JsonObject };
}
