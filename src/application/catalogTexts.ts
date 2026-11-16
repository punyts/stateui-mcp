import type { CatalogText } from './ports/CatalogMeanings.js';
import type { ComponentSummary } from './ports/ComponentCatalog.js';
import type { PatternEntry } from './ports/PatternCatalog.js';

/** The words of a camelCase or hyphenated name: `dateRangeField` is date range field */
const wordsOf = (name: string): string => name.split(/(?=[A-Z])|-/).join(' ').toLowerCase();

/** What an entry is embedded as: the words of its name, its summary and its purpose phrases */
function textOf(name: string, summary: string, purposes: readonly string[]): string {
    return [`${wordsOf(name)}.`, summary, purposes.length > 0 ? `For: ${purposes.join('; ')}.` : ''].filter((part) => part !== '').join(' ');
}

/** The library's components as they are embedded, in catalog order */
export function componentTexts(components: readonly ComponentSummary[]): CatalogText[] {
    return components.map((component) => ({ name: component.name, text: textOf(component.name, component.summary, component.purposes) }));
}

/** The library's patterns as they are embedded, in catalog order; owner patterns are left out */
export function patternTexts(patterns: readonly PatternEntry[]): CatalogText[] {
    return patterns.filter((pattern) => (pattern.source ?? 'library') === 'library').map((pattern) => ({ name: pattern.name, text: textOf(pattern.name, pattern.summary, pattern.purposes) }));
}
