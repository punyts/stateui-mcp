import { describe, it, expect } from 'vitest';
import { createStateUiAdapters } from '../config/createStateUiAdapters.js';
import { loadCatalogFile, loadIconsFile } from './stateUiLibrary.js';
import { DEFAULT_ICON_LIMIT, MAX_ICON_LIMIT, StateUiComponentCatalog } from './StateUiComponentCatalog.js';

const catalog = new StateUiComponentCatalog(loadCatalogFile(), loadIconsFile());

describe('StateUiComponentCatalog', () => {
    describe('list', () => {
        it('should list every component with its tier, size and summary', () => {
            const names = catalog.list().map((component) => component.name);

            expect(names).toEqual(expect.arrayContaining(['page', 'panel', 'form', 'textField', 'list', 'confirmDialog']));
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
