import { describe, it, expect } from 'vitest';
import type { AppBlueprint, PartSource } from '@punyts/stateui-app/core';
import { createStateUiAdapters } from '../config/createStateUiAdapters.js';
import { parseShape } from '@punyts/stateui-app/core';
import { StateUiAppValidator } from './StateUiAppValidator.js';
import type { CatalogFile } from './stateUiLibrary.js';
import { MAX_DOCUMENT_BYTES, documentBytes } from '../domain/limits.js';
import type { UiDocument } from '../domain/UiApp.js';
import { isValid } from '../domain/UiBuildError.js';
import { SAMPLE_FORM_AND_LIST_APP } from '../testing/sampleFormAndListApp.fixture.js';

const { validator } = createStateUiAdapters();

const NO_PARTS: PartSource = Object.freeze({});

/** An app whose one screen, home, is a panel that holds `children`: their state paths are `$.screens.home.children...` */
function appWith(children: object): AppBlueprint {
    return {
        start: 'home',
        app: { component: 'app' },
        screens: { home: { root: { component: 'panel', children } } }
    } as unknown as AppBlueprint;
}

function check(blueprint: AppBlueprint, parts: PartSource = NO_PARTS) {
    return validator.validateAssembled(blueprint, parts, 'shop');
}

function pair(error: { code: string; statePath?: string }): [string, string | undefined] {
    return [error.code, error.statePath];
}

describe('StateUiAppValidator', () => {
    describe('validateAssembled', () => {
        it('should pass a plain app with no errors and no warnings', () => {
            expect(check(appWith({ title: { component: 'text', _text: 'Shop' } }))).toEqual([]);
        });

        it('should return one error per code family, each with its state path and the part that holds it', () => {
            const errors = check(
                appWith({
                    ghost: { component: 'nothing' },
                    extra: { component: 'text', nonsense: true },
                    linked: { component: 'text', '<-_text': '$.data.nobody' }
                })
            );

            expect(errors.map(pair)).toEqual(
                expect.arrayContaining([
                    ['SUI-USES-MISSING', '$.screens.home.root.children.ghost'],
                    ['SUI-STATE-UNKNOWN', '$.screens.home.children.extra.nonsense'],
                    ['SUI-LINK-MISSING', '$.screens.home.children.linked']
                ])
            );
            expect(errors.every((error) => error.statePath !== undefined && error.part.kind === 'apps' && error.part.name === 'shop')).toBe(true);
            expect(isValid(errors)).toBe(false);
        });

        it('should check the token and paint names of a drawing against the theme and its paints (graphics G1.3)', () => {
            const errors = check(
                appWith({
                    map: {
                        component: 'drawing',
                        paints: { sky: { stops: { a: { offset: 0, color: '{color.accent.soft}' } } } },
                        children: {
                            known: { component: 'rect', width: 1, height: 1, fill: '{drawing.background}', stroke: 'sky' },
                            token: { component: 'rect', fill: '{color.nope.base}' },
                            paint: { component: 'circle', r: 2, fill: 'sea', interactive: true }
                        }
                    }
                })
            );

            expect(errors.map(pair)).toEqual([
                ['SUI-STATE-TOKEN', '$.screens.home.children.map.children.token.fill'],
                ['SUI-STATE-PAINT', '$.screens.home.children.map.children.paint.fill'],
                ['SUI-STATE-LABEL', '$.screens.home.children.map.children.paint']
            ]);
        });

        it('should report an unknown icon name on an icon-typed property', () => {
            const errors = check(appWith({ go: { component: 'button', icon: 'not-an-icon-at-all' } }));

            expect(errors.map(pair)).toEqual([['SUI-STATE-INVALID', '$.screens.home.children.go.icon']]);
        });

        it('should accept a known icon name and an alias', () => {
            expect(check(appWith({ a: { component: 'button', icon: 'trash' }, b: { component: 'button', icon: 'delete' } }))).toEqual([]);
        });
    });

    describe('unknown component', () => {
        it('should list the nearest component names in the message', () => {
            const [error] = check(appWith({ f: { component: 'textFeild' } }));

            expect(error?.code).toBe('SUI-USES-MISSING');
            expect(error?.message).toContain('nearest names: textField');
        });

        it('should include the owner components among the nearest names', () => {
            const parts = { components: { customerCard: { tree: { component: 'panel' }, exposes: [] } } } as unknown as PartSource;

            const [error] = check(appWith({ c: { component: 'customerCrad' } }), parts);

            expect(error?.message).toContain('customerCard');
        });

        it('should add no hint when nothing is near', () => {
            const [error] = check(appWith({ f: { component: 'qqqqqqqqqqqq' } }));

            expect(error?.message).not.toContain('Nearest');
        });
    });

    describe('<- targets', () => {
        it('should report $row outside a row template', () => {
            expect(check(appWith({ t: { component: 'text', '<-_text': '$row.name' } })).map((error) => error.code)).toContain('SUI-LINK-ROW');
        });

        it('should accept a node reference to an exposed property and reject one to a property that is not', () => {
            const blueprint = (target: string): AppBlueprint => appWith({ customers: { component: 'list' }, detail: { component: 'text', '<-_text': target } });

            expect(check(blueprint('^home.children.customers.current.name'))).toEqual([]);
            expect(check(blueprint('^home.children.customers.divided')).map((error) => error.code)).toEqual(['SUI-LINK-MISSING']);
        });

        it('should report a target that is not $.data, $row or a node reference', () => {
            expect(check(appWith({ t: { component: 'text', '<-_text': '$.app.title' } })).map((error) => error.code)).toContain('SUI-LINK-TARGET');
        });
    });

    describe('size limit', () => {
        const titled = (length: number): AppBlueprint => appWith({ title: { component: 'text', _text: 'x'.repeat(length) } });
        const base = documentBytes(validator.assembleApp(titled(0), NO_PARTS));

        it('should pass an assembled app exactly at the limit', () => {
            const blueprint = titled(MAX_DOCUMENT_BYTES - base);

            expect(documentBytes(validator.assembleApp(blueprint, NO_PARTS))).toBe(MAX_DOCUMENT_BYTES);
            expect(check(blueprint)).toEqual([]);
        });

        it('should reject an assembled app exactly one byte over', () => {
            const blueprint = titled(MAX_DOCUMENT_BYTES - base + 1);

            expect(documentBytes(validator.assembleApp(blueprint, NO_PARTS))).toBe(MAX_DOCUMENT_BYTES + 1);
            expect(check(blueprint).map((error) => [error.code, error.part.name])).toEqual([['SUI-DOC-LIMIT-BYTES', 'shop']]);
        });
    });

    describe('warnings of an assembled app', () => {
        it('should warn about each content path a language of the app node or a screen does not translate', () => {
            const blueprint = {
                start: 'home',
                app: { component: 'app', _title: 'Shop' },
                locales: { de: {} },
                screens: { home: { root: { component: 'text', _text: 'Welcome' }, locales: { fr: {} } } }
            } as unknown as AppBlueprint;

            const warnings = check(blueprint);

            const paths = warnings.map((warning) => warning.statePath).join(' ');
            expect(warnings.every((warning) => warning.code === 'SUI-LOCALE-MISSING' && warning.part.name === 'shop')).toBe(true);
            expect(paths).toContain('$.app');
            expect(paths).toContain('$.screens.home');
            expect(isValid(warnings)).toBe(true);
        });
    });

    describe('resolveNode', () => {
        it('should return the node merged with its component defaults', () => {
            const node = validator.resolveNode(SAMPLE_FORM_AND_LIST_APP, ['app', 'children', 'footer', 'children', 'save']);

            expect(node?.['component']).toBe('button');
            expect(node?.['_title']).toBe('Save');
            expect(node?.['variant']).toBe('solid');
        });

        it('should return undefined for a missing path, a non-node and an unknown component', () => {
            const document: UiDocument = { app: { component: 'panel', children: { ghost: { component: 'nothing' } } } };

            expect(validator.resolveNode(document, ['app', 'nope'])).toBeUndefined();
            expect(validator.resolveNode(document, ['app', 'children'])).toBeUndefined();
            expect(validator.resolveNode(document, ['app', 'children', 'ghost'])).toBeUndefined();
        });
    });

    describe('shape components', () => {
        // A fixture catalog: a shape component (graphics) has a shape and no tag
        const dot = parseShape({ summary: 'A dot', properties: { r: { type: 'number', default: 4 } } }, 'dot.state.json').shape;
        const catalog = {
            components: [{ name: 'dot', tier: 'shape', shape: dot }],
            theme: { tokens: [], overlays: {} },
            patterns: []
        } as unknown as CatalogFile;
        const shapes = new StateUiAppValidator(catalog, () => true);

        it('should check a property of a shape node against its shape', () => {
            expect(shapes.checkProperty('dot', 'r', 2, '$.app.mark')).toEqual({ kind: 'ok', content: false });
            expect(shapes.checkProperty('dot', 'r', 'big', '$.app.mark').kind).toBe('invalid');
            expect(shapes.checkProperty('dot', 'nope', 1, '$.app.mark')).toEqual({ kind: 'unknown-property' });
        });
    });

    describe('no DOM', () => {
        it('should leave the process without a DOM after validating', () => {
            check(appWith({ title: { component: 'text', _text: 'Shop' } }));

            expect((globalThis as { customElements?: unknown }).customElements).toBeUndefined();
            expect((globalThis as { document?: unknown }).document).toBeUndefined();
        });
    });
});
