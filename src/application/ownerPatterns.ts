import type { OwnerPattern, PatternCatalog } from './ports/PatternCatalog.js';
import type { UiPartRepository } from './ports/UiPartRepository.js';

/**
 * The library's patterns together with the owner's `patterns` parts (written by `ui_pattern_write`, which checks them),
 * read at each call so a pattern written a moment ago is found
 */
export async function withOwnerPatterns(patterns: PatternCatalog, parts: Pick<UiPartRepository, 'list' | 'findByName'>): Promise<PatternCatalog> {
    const owner: OwnerPattern[] = [];
    for (const summary of await parts.list('patterns')) {
        const part = await parts.findByName('patterns', summary.name);
        if (part !== undefined) owner.push({ name: part.name, body: part.body as unknown as OwnerPattern['body'] });
    }
    return patterns.withOwner(owner);
}
