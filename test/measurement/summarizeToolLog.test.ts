import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, isWriteTool, parseLog, summarize } from '../../scripts/summarizeToolLog.mjs';
import { loadCatalogFile } from '../../src/infrastructure/stateUiLibrary.js';

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

describe('summarizeToolLog', () => {
    it('should give the numbers of the fixture build', () => {
        // Arrange
        const entries = parseLog(readFileSync(here('fixtures/tool-log.jsonl'), 'utf8'));

        // Act
        const summary = summarize(entries);

        // Assert: catalog characters 4000 + 800 + 400 + 200 + 600 = 6000, the search call included, plus the guide's
        // 1200 + 400 (the failed topic too) = 1600, so catalog tokens are 7600 / 4 = 1900 and guide tokens 400;
        // instructions 5200 / 4 = 1300, so tokens read are 1300 + 1900 = 3200;
        // failed writes are the three failed ui_nodes_write calls and the refused ui_state_set (a failed ui_guide is
        // not a write); first-write errors are 3 (a1's first write) + 2 (a2's first write), the retry's 2 left out
        expect(summary).toEqual({ tokensRead: 3200, instructionsTokens: 1300, catalogTokens: 1900, guideTokens: 400, failedWrites: 4, firstWriteErrors: 5 });
    });

    it('should not count a retry after a failed write to the same target, but count a first write to another target', () => {
        // Arrange
        const entries = [
            { tool: 'ui_nodes_write', ok: false, target: 'a', errorCount: 4 },
            { tool: 'ui_nodes_write', ok: false, target: 'a', errorCount: 4 },
            { tool: 'ui_nodes_write', ok: false, target: 'b', errorCount: 1 }
        ];

        // Act
        const summary = summarize(entries);

        // Assert
        expect(summary.firstWriteErrors).toBe(5);
        expect(summary.failedWrites).toBe(3);
    });

    it('should count the instructions once per build and none when the log has no instructions line (K1.5 of the guide-tool epic)', () => {
        // Arrange: a client that initialized twice in one build
        const twice = [{ instructionsChars: 4000 }, { tool: 'ui_guide', ok: true, responseChars: 800 }, { instructionsChars: 4000 }];

        // Act
        const summary = summarize(twice);
        const none = summarize([{ tool: 'ui_component_get', ok: true, responseChars: 400 }]);

        // Assert
        expect(summary).toMatchObject({ instructionsTokens: 1000, catalogTokens: 200, guideTokens: 200, tokensRead: 1200 });
        expect(none).toMatchObject({ instructionsTokens: 0, catalogTokens: 100, guideTokens: 0, tokensRead: 100 });
    });

    it('should know the write tools of today and after the owner-tree epics', () => {
        expect(['ui_nodes_write', 'ui_app_create', 'ui_delete', 'ui_state_set', 'ui_theme_configure', 'ui_part_rename'].every(isWriteTool)).toBe(true);
        expect(['ui_validate', 'ui_state_get', 'ui_components_search', 'ui_preview'].some(isWriteTool)).toBe(false);
    });

    it('should name the line that is not JSON', () => {
        expect(() => parseLog('{"tool":"a","ok":true}\nnot json\n')).toThrow('Line 2 is not JSON');
    });

    it('should give the median and range over builds', () => {
        // Act
        const all = aggregate([
            { tokensRead: 1600, instructionsTokens: 1300, catalogTokens: 300, guideTokens: 100, failedWrites: 2, firstWriteErrors: 1 },
            { tokensRead: 1400, instructionsTokens: 1300, catalogTokens: 100, guideTokens: 0, failedWrites: 0, firstWriteErrors: 4 },
            { tokensRead: 1500, instructionsTokens: 1300, catalogTokens: 200, guideTokens: 50, failedWrites: 1, firstWriteErrors: 2 }
        ]);

        // Assert
        expect(all.tokensRead).toEqual({ median: 1500, min: 1400, max: 1600 });
        expect(all.guideTokens).toEqual({ median: 50, min: 0, max: 100 });
        expect(all.catalogTokens).toEqual({ median: 200, min: 100, max: 300 });
        expect(all.firstWriteErrors).toEqual({ median: 2, min: 1, max: 4 });
    });
});

describe('needs.json', () => {
    it('should list at least 20 needs, each naming a component of the catalog', () => {
        // Arrange
        const needs = JSON.parse(readFileSync(here('needs.json'), 'utf8')) as { need: string; expected: string }[];
        const catalog = loadCatalogFile();
        const names = new Set(catalog.components.map((component) => component.name));

        // Assert
        expect(needs.length).toBeGreaterThanOrEqual(20);
        expect(needs.filter((entry) => entry.need.trim() === '' || !names.has(entry.expected))).toEqual([]);
    });
});
