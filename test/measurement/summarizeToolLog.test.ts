import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, isWriteTool, parseLog, summarize } from '../../scripts/summarizeToolLog.mjs';
import { loadCatalogFile } from '../../src/infrastructure/stateUiLibrary.js';

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

describe('summarizeToolLog', () => {
    it('should give the three numbers of the fixture build', () => {
        // Arrange
        const entries = parseLog(readFileSync(here('fixtures/tool-log.jsonl'), 'utf8'));

        // Act
        const summary = summarize(entries);

        // Assert: catalog characters 4000 + 800 + 400 + 200 + 600 = 6000, the search call included;
        // failed writes are the three failed ui_app_write calls and the refused ui_state_set;
        // first-write errors are 3 (a1's first write) + 2 (a2's first write), the retry's 2 left out
        expect(summary).toEqual({ catalogTokens: 1500, failedWrites: 4, firstWriteErrors: 5 });
    });

    it('should not count a retry after a failed write to the same target, but count a first write to another target', () => {
        // Arrange
        const entries = [
            { tool: 'ui_app_write', ok: false, target: 'a', errorCount: 4 },
            { tool: 'ui_app_write', ok: false, target: 'a', errorCount: 4 },
            { tool: 'ui_app_write', ok: false, target: 'b', errorCount: 1 }
        ];

        // Act
        const summary = summarize(entries);

        // Assert
        expect(summary.firstWriteErrors).toBe(5);
        expect(summary.failedWrites).toBe(3);
    });

    it('should know the write tools of today and after the owner-tree epics', () => {
        expect(['ui_app_write', 'ui_app_create', 'ui_app_delete', 'ui_state_set', 'ui_theme_configure', 'ui_part_rename'].every(isWriteTool)).toBe(true);
        expect(['ui_validate', 'ui_state_get', 'ui_components_search', 'ui_preview'].some(isWriteTool)).toBe(false);
    });

    it('should name the line that is not JSON', () => {
        expect(() => parseLog('{"tool":"a","ok":true}\nnot json\n')).toThrow('Line 2 is not JSON');
    });

    it('should give the median and range over builds', () => {
        // Act
        const all = aggregate([
            { catalogTokens: 300, failedWrites: 2, firstWriteErrors: 1 },
            { catalogTokens: 100, failedWrites: 0, firstWriteErrors: 4 },
            { catalogTokens: 200, failedWrites: 1, firstWriteErrors: 2 }
        ]);

        // Assert
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
