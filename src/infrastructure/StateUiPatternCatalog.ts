import type { PatternCatalog, PatternEntry, ThemePresetEntry } from '../application/ports/PatternCatalog.js';
import type { CatalogFile } from './stateUiLibrary.js';

/** `PatternCatalog` over the optional `patterns` and `themePresets` sections of `catalog.json`; empty while they are absent */
export class StateUiPatternCatalog implements PatternCatalog {
    private readonly patterns: ReadonlyMap<string, PatternEntry>;
    private readonly presets: ReadonlyMap<string, ThemePresetEntry>;

    constructor(catalog: Pick<CatalogFile, 'patterns' | 'themePresets'>) {
        this.patterns = new Map((catalog.patterns ?? []).map((pattern) => [pattern.name, pattern]));
        this.presets = new Map((catalog.themePresets ?? []).map((preset) => [preset.name, preset]));
    }

    get(name: string): PatternEntry | undefined {
        return this.patterns.get(name);
    }

    preset(name: string): ThemePresetEntry | undefined {
        return this.presets.get(name);
    }
}
