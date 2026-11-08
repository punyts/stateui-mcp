import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { toComponentView } from '../application/componentView.js';
import { InvalidSearchArgumentError } from '../application/ports/ComponentCatalog.js';
import { createStateUiAdapters } from '../config/createStateUiAdapters.js';
import { hasSearchKeys, loadCatalogFile, loadIconsFile } from './stateUiLibrary.js';
import { DEFAULT_ICON_LIMIT, MAX_ICON_LIMIT, MAX_SEARCH_LIMIT, StateUiComponentCatalog, WEAK_SCORE_FLOOR } from './StateUiComponentCatalog.js';

const catalog = new StateUiComponentCatalog(loadCatalogFile(), loadIconsFile());

describe('StateUiComponentCatalog', () => {
    describe('list', () => {
        it('should list every component with its tier, size and summary', () => {
            const names = catalog.list().map((component) => component.name);

            expect(names).toEqual(expect.arrayContaining(['app', 'panel', 'form', 'textField', 'list', 'confirmDialog']));
            expect(catalog.list().every((component) => component.summary !== '' && component.size !== '')).toBe(true);
        });
    });

    describe('get', () => {
        it('should return a root component with its shape, slots, events and commands', () => {
            const entry = catalog.get('list');

            expect(entry?.tier).toBe('root');
            if (entry?.tier !== 'root') return;
            expect(Object.keys(entry.shape)).toContain('properties');
            expect(entry.slots.map((slot) => slot['name'])).toEqual(['row', 'empty']);
            expect(entry.events).toEqual(['select', 'activate', 'sort']);
            expect(entry.commands).toEqual(['clearSelection', 'selectAll']);
        });

        it('should return a composed component with its tree and exposed paths', () => {
            const entry = catalog.get('confirmDialog');

            expect(entry?.tier).toBe('composed');
            if (entry?.tier !== 'composed') return;
            expect(entry.tree['component']).toBe('modal');
            expect(entry.exposes.length).toBeGreaterThan(0);
        });

        it('should list the component tokens with their type and default, and none for a component without', () => {
            // Arrange / Act
            const image = catalog.get('image');
            const panel = catalog.get('panel');

            // Assert
            expect(image?.tokens).toEqual([{ path: 'image.fill', type: 'color', default: '{color.surface.sunken}' }]);
            expect(panel?.tokens).toEqual(expect.arrayContaining([{ path: 'panel.padding', type: 'inset', default: '{space.inset.md} {space.inset.md}' }]));
            expect(catalog.get('confirmDialog')?.tokens).toEqual([]);
        });

        it('should return undefined for an unknown name', () => {
            expect(catalog.get('nothing')).toBeUndefined();
        });
    });

    describe('searchIcons', () => {
        it('should rank an exact name first and report the total before the limit', () => {
            const result = catalog.searchIcons({ query: 'trash', limit: 3 });

            expect(result.matches[0]?.name).toBe('trash');
            expect(result.matches).toHaveLength(3);
            expect(result.total).toBeGreaterThan(3);
        });

        it('should find an icon through an alias', () => {
            const result = catalog.searchIcons({ query: 'delete' });

            expect(result.matches.map((match) => match.name)).toContain('trash');
        });

        it('should require every word of the query', () => {
            const both = catalog.searchIcons({ query: 'arrow left', limit: MAX_ICON_LIMIT });

            expect(both.matches.length).toBeGreaterThan(0);
            expect(both.matches.every((match) => [match.name, match.category.toLowerCase(), ...match.tags].some((text) => text.includes('arrow')))).toBe(
                true
            );
        });

        it('should filter by category and by filled variant', () => {
            const filled = catalog.searchIcons({ filled: true, limit: MAX_ICON_LIMIT });
            const first = filled.matches[0];
            const sameCategory = catalog.searchIcons({ category: first?.category ?? '', limit: MAX_ICON_LIMIT });

            expect(filled.matches.every((match) => match.hasFilled)).toBe(true);
            expect(sameCategory.matches.every((match) => match.category === first?.category)).toBe(true);
        });

        it('should match a word of the category after name and tag matches', () => {
            const result = catalog.searchIcons({ query: 'weather', limit: MAX_ICON_LIMIT });

            expect(result.matches.length).toBeGreaterThan(0);
            expect(result.matches.some((match) => match.category === 'Weather')).toBe(true);
            const firstCategoryOnly = result.matches.findIndex(
                (match) => !match.name.includes('weather') && !match.tags.some((tag) => tag.includes('weather'))
            );
            const lastNameOrTag = result.matches.findLastIndex(
                (match) => match.name.includes('weather') || match.tags.some((tag) => tag.includes('weather'))
            );
            if (firstCategoryOnly !== -1) expect(firstCategoryOnly).toBeGreaterThan(lastNameOrTag);
        });

        it('should default the limit to 30', () => {
            expect(catalog.searchIcons({}).matches).toHaveLength(DEFAULT_ICON_LIMIT);
        });

        it('should cap the limit', () => {
            expect(catalog.searchIcons({ limit: 100000 }).matches).toHaveLength(MAX_ICON_LIMIT);
            expect(catalog.searchIcons({ limit: 0 }).matches).toHaveLength(0);
        });

        it('should return nothing for a word that matches no icon', () => {
            expect(catalog.searchIcons({ query: 'zzzzzzzzqqqq' })).toEqual({ matches: [], total: 0 });
        });
    });

    describe('iconPaths', () => {
        it('should return path data by name, resolve aliases and leave unknown names out', () => {
            const paths = catalog.iconPaths(['trash', 'delete', 'not-an-icon']);

            expect(Object.keys(paths)).toEqual(['trash', 'delete']);
            expect(paths['trash']).toMatch(/^M/);
            expect(paths['delete']).toBe(paths['trash']);
        });
    });

    describe('listTokens', () => {
        it('should list the semantic tokens with type, default, group and a one-line description', () => {
            const tokens = catalog.listTokens();

            expect(tokens.length).toBeGreaterThan(50);
            expect(tokens.find((token) => token.path === 'color.text.muted')).toMatchObject({
                type: 'color',
                default: '{palette.neutral.600}',
                group: 'color'
            });
            expect(tokens.find((token) => token.path === 'radius.md')).toMatchObject({ type: 'dimension', default: '6px', group: 'radius' });
            for (const token of tokens) expect(token.description, token.path).toMatch(/^[^\r\n]+$/);
        });

        it('should leave out the primitive tokens', () => {
            const groups = new Set(catalog.listTokens().map((token) => token.group));

            for (const primitive of ['palette', 'scale', 'font']) expect(groups.has(primitive)).toBe(false);
            expect(groups).toContain('color');
        });
    });

    describe('listOverlays', () => {
        it('should list the shipped overlays by kind with the groups the kind may touch', () => {
            const overlays = catalog.listOverlays();

            expect(overlays.filter((overlay) => overlay.kind === 'mode').map((overlay) => overlay.name)).toEqual(['light', 'dark', 'contrast']);
            expect(overlays.filter((overlay) => overlay.kind === 'brand').map((overlay) => overlay.name)).toEqual(['default']);
            expect(overlays.filter((overlay) => overlay.kind === 'motion').map((overlay) => overlay.name)).toEqual(['full', 'reduced']);
            expect(overlays.find((overlay) => overlay.name === 'dark')?.groups).toEqual(['color', 'elevation']);
            expect(overlays.find((overlay) => overlay.name === 'reduced')?.groups).toEqual(['motion']);
        });
    });

    describe('loading', () => {
        it('should read the library files once per process', () => {
            expect(loadCatalogFile()).toBe(loadCatalogFile());
            expect(loadIconsFile()).toBe(loadIconsFile());
        });

        it('should give the validator and the catalog the same icon list', () => {
            const adapters = createStateUiAdapters();

            expect(adapters.catalog.iconPaths(['trash'])).toEqual(catalog.iconPaths(['trash']));
        });
    });
});

interface Need {
    readonly need: string;
    readonly expected: string;
}

const NEEDS: readonly Need[] = Object.freeze(JSON.parse(readFileSync(new URL('../../test/measurement/needs.json', import.meta.url), 'utf8')) as Need[]);

const namesFor = (need: string, limit?: number): string[] => catalog.search({ need, ...(limit === undefined ? {} : { limit }) }).results.map((hit) => hit.name);

describe('StateUiComponentCatalog search', () => {
    it('should return dateRangeField first for "pick a date range", with that phrase matched', () => {
        const result = catalog.search({ need: 'pick a date range' });

        expect(result.results[0]?.name).toBe('dateRangeField');
        expect(result.results[0]?.matched).toContain('pick a date range');
        expect(result.weak).toBe(false);
    });

    it('should return dateRangeField first for "choose start and end dates" by a purpose phrase', () => {
        const result = catalog.search({ need: 'choose start and end dates' });

        expect(result.results[0]?.name).toBe('dateRangeField');
        expect(result.results[0]?.matched).toContain('choose start and end dates');
    });

    it('should return stepper or wizard in the top three for "step through checkout"', () => {
        const top = namesFor('step through checkout', 3);

        expect(top.some((name) => name === 'stepper' || name === 'wizard')).toBe(true);
    });

    it('should find every need of the measurement fixture within five, and at least 80% within three', () => {
        const ranks = NEEDS.map(({ need, expected }) => ({ need, expected, rank: namesFor(need).indexOf(expected) }));

        expect(ranks.filter((entry) => entry.rank < 0)).toEqual([]);
        expect(ranks.filter((entry) => entry.rank < 3).length / ranks.length).toBeGreaterThanOrEqual(0.8);
    });

    it('should call a need weak when its only match is one word of one summary, and not when it is one purpose word', () => {
        // "faq" is only in the summary of accordion; "budget" only in a purpose phrase of progress
        const summaryOnly = catalog.search({ need: 'faq' });
        const purposeOnly = catalog.search({ need: 'budget' });

        expect(summaryOnly.results[0]?.name).toBe('accordion');
        expect(summaryOnly.weak).toBe(true);
        expect(purposeOnly.results[0]?.name).toBe('progress');
        expect(purposeOnly.weak).toBe(false);
        expect(WEAK_SCORE_FLOOR).toBeGreaterThan(0);
    });

    it('should answer a nonsense need with the weak result, the category index and the nearest category', () => {
        const result = catalog.search({ need: 'xyzzy' });

        expect(result.weak).toBe(true);
        expect(result.categories).toEqual(catalog.categoryIndex());
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.every((hit) => hit.matched.length === 0)).toBe(true);
    });

    it('should pick the fallback category by shared letter trigrams with the need', () => {
        const result = catalog.search({ need: 'navigatio' });

        expect(result.weak).toBe(true);
        expect(new Set(result.results.map((hit) => hit.category))).toEqual(new Set(['navigation']));
    });

    it('should treat a whitespace-only need as a need with no match', () => {
        const result = catalog.search({ need: '   ' });

        expect(result.weak).toBe(true);
        expect(result.categories).toBeDefined();
        expect(result.results.length).toBeGreaterThan(0);
    });

    it('should answer no match within a category with the entries of that category and no index', () => {
        const result = catalog.search({ need: 'xyzzy', category: 'feedback' });

        expect(result.weak).toBe(true);
        expect(result.categories).toBeUndefined();
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.every((hit) => hit.category === 'feedback')).toBe(true);
    });

    it('should narrow by category and by tier before ranking', () => {
        const forms = catalog.search({ need: 'pick a date', category: 'forms', limit: 20 });
        const composed = catalog.search({ need: 'confirm before deleting', tier: 'composed', limit: 20 });

        expect(forms.results.every((hit) => hit.category === 'forms')).toBe(true);
        expect(composed.results.every((hit) => hit.tier === 'composed')).toBe(true);
        expect(composed.results[0]?.name).toBe('confirmDialog');
    });

    it('should default the limit to five and cap it at twenty', () => {
        expect(catalog.search({ need: 'show' }).results.length).toBeLessThanOrEqual(5);
        expect(catalog.search({ need: 'show', limit: 50 }).results.length).toBe(MAX_SEARCH_LIMIT);
    });

    it('should give every result an example', () => {
        const results = [...catalog.search({ need: 'show', limit: 20 }).results, ...catalog.search({ need: 'xyzzy', limit: 20 }).results];

        expect(results.every((hit) => typeof hit.example === 'object' && hit.example !== null && hit.example['component'] !== undefined)).toBe(true);
    });

    it('should reject an unknown category with the allowed list, and an unknown tier with the tiers of the catalog', () => {
        expect(() => catalog.search({ need: 'x', category: 'tables' })).toThrow(InvalidSearchArgumentError);
        expect(() => catalog.search({ need: 'x', category: 'tables' })).toThrow(/layout, navigation, forms/);
        expect(() => catalog.search({ need: 'x', tier: 'atom' })).toThrow(/composed, root, shape/);
    });
});

describe('StateUiComponentCatalog categoryIndex', () => {
    it('should list each category with members, in list order, with its count and three typical members', () => {
        const index = catalog.categoryIndex();

        expect(index.map((entry) => entry.category)).toEqual(['layout', 'navigation', 'forms', 'data', 'feedback', 'overlays', 'content', 'conversation', 'graphics']);
        expect(index.reduce((sum, entry) => sum + entry.count, 0)).toBe(loadCatalogFile().components.length);
        expect(index.every((entry) => entry.typical.length === Math.min(3, entry.count))).toBe(true);
    });

    it('should have a graphics entry with the drawing and the 2D shapes (graphics G1.3), and scene3d and its seven 3D nodes (G3.4, repeat3d G3.6, label3d G3.6b)', () => {
        const graphics = catalog.categoryIndex().find((entry) => entry.category === 'graphics');

        expect(graphics?.count).toBe(20);
        expect(catalog.search({ need: 'label a part of a 3D model', category: 'graphics', limit: 20 }).results.map((hit) => hit.name)).toContain('label3d');
        expect(catalog.search({ need: 'draw one 3D mesh per record', category: 'graphics', limit: 20 }).results.map((hit) => hit.name)).toContain('repeat3d');
        expect(catalog.search({ need: 'show a 3D product model', category: 'graphics', limit: 20 }).results.map((hit) => hit.name)).toEqual(expect.arrayContaining(['scene3d', 'model']));
        expect(catalog.search({ need: 'draw a seat map', category: 'graphics', limit: 20 }).results.map((hit) => hit.name)).toEqual(expect.arrayContaining(['drawing', 'drawRepeat']));
    });

    it('should pick the members with the most purposes, ties by name', () => {
        const conversation = loadCatalogFile().components.filter((component) => component.category === 'conversation');
        const expected = [...conversation]
            .sort((a, b) => b.purposes.length - a.purposes.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .slice(0, 3)
            .map((component) => component.name);

        expect(catalog.categoryIndex().find((entry) => entry.category === 'conversation')?.typical).toEqual(expected);
    });
});

describe('the catalog file check', () => {
    it('should accept components that carry category and purposes and reject one without', () => {
        expect(hasSearchKeys([{ category: 'forms', purposes: ['a', 'b', 'c'] }])).toBe(true);
        expect(hasSearchKeys([{ category: 'forms' }])).toBe(false);
        expect(hasSearchKeys([{ purposes: ['a', 'b', 'c'] }])).toBe(false);
    });
});

describe('StateUiComponentCatalog shape components', () => {
    const SHAPE_ENTRY = {
        name: 'chartBar',
        tier: 'shape' as const,
        size: 'atom',
        summary: 'A bar of a bar chart',
        category: 'graphics',
        purposes: ['show one value as a bar', 'compare amounts side by side', 'draw a bar of a chart'],
        shape: { summary: 'A bar of a bar chart', properties: { value: { type: 'number', required: true } }, shared: [], events: ['press'], commands: [], layout: false },
        events: ['press'],
        locales: [],
        example: { component: 'chartBar', value: 0 },
        tokens: [{ path: 'bar.fill', group: 'bar', type: 'color', default: '{color.accent.base}' }]
    };
    const file = loadCatalogFile();
    const withShape = new StateUiComponentCatalog({ ...file, components: [...file.components, SHAPE_ENTRY] }, loadIconsFile());

    it('should give a shape entry with tier shape, its shape, events and tokens and no slots or commands', () => {
        const entry = withShape.get('chartBar');

        expect(entry?.tier).toBe('shape');
        const view = toComponentView(entry as NonNullable<typeof entry>);
        expect(view).toMatchObject({ name: 'chartBar', tier: 'shape', category: 'graphics', events: ['press'], tokens: [{ path: 'bar.fill', type: 'color', default: '{color.accent.base}' }] });
        expect(view).toHaveProperty('properties.value');
        expect(view).not.toHaveProperty('slots');
        expect(view).not.toHaveProperty('commands');
    });

    it('should find a shape entry by its purposes and narrow the search to tier shape', () => {
        const result = withShape.search({ need: 'compare amounts as bars', tier: 'shape' });

        expect(result.results[0]?.name).toBe('chartBar');
        expect(result.results.every((hit) => hit.tier === 'shape')).toBe(true);
        expect(withShape.search({ need: 'compare amounts as bars' }).results[0]?.tier).toBe('shape');
    });
});
