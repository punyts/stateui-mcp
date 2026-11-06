import { describe, expect, it } from 'vitest';
import { toComponentView } from './componentView.js';
import type { ComposedComponentEntry, RootComponentEntry, ShapeComponentEntry } from './ports/ComponentCatalog.js';

const FILLER = Object.freeze({ required: false, validators: Object.freeze({}), runtime: false, reflect: false, row: false, exposed: false });

const NUMBER_FIELD: RootComponentEntry = Object.freeze({
    name: 'numberField',
    tier: 'root',
    size: 'molecule',
    summary: 'A labelled number field',
    category: 'forms',
    purposes: Object.freeze(['enter an amount']),
    example: Object.freeze({ component: 'numberField' }),
    locales: Object.freeze(['de']),
    tokens: Object.freeze([Object.freeze({ path: 'field.error.color', type: 'color', default: '{color.danger.base}' })]),
    shape: Object.freeze({
        summary: 'A labelled number field',
        properties: Object.freeze({
            step: Object.freeze({ ...FILLER, type: 'number', default: 0, validators: Object.freeze({ range: Object.freeze({ min: 0 }) }) }),
            format: Object.freeze({ ...FILLER, type: 'string', default: 'number', values: Object.freeze(['number', 'currency']) }),
            currency: Object.freeze({ ...FILLER, type: 'string', requiredWhen: Object.freeze({ property: 'format', equals: 'currency' }) }),
            stepper: Object.freeze({ ...FILLER, type: 'boolean', default: true, reflect: true }),
            error: Object.freeze({ ...FILLER, type: 'string', default: '', runtime: true }),
            _label: Object.freeze({ ...FILLER, type: 'string', default: 'Label', kind: 'content' })
        }),
        shared: Object.freeze(['size', 'density']),
        events: Object.freeze(['change']),
        commands: Object.freeze(['reset']),
        layout: false,
        tokens: Object.freeze([Object.freeze({ path: 'field.error.color', group: 'field', type: 'color', default: '{color.danger.base}' })])
    }),
    slots: Object.freeze([]),
    events: Object.freeze(['change']),
    commands: Object.freeze(['reset'])
});

const CONFIRM_DIALOG: ComposedComponentEntry = Object.freeze({
    name: 'confirmDialog',
    tier: 'composed',
    size: 'organism',
    summary: 'Ask before an action',
    category: 'overlays',
    purposes: Object.freeze(['confirm a delete']),
    example: Object.freeze({ component: 'confirmDialog' }),
    locales: Object.freeze([]),
    tokens: Object.freeze([]),
    tree: Object.freeze({ component: 'modal' }),
    exposes: Object.freeze([Object.freeze({ path: 'title' })])
});

describe('toComponentView', () => {
    it('should keep only the property keys that say something', () => {
        // Act
        const view = toComponentView(NUMBER_FIELD);

        // Assert
        expect(view['properties']).toEqual({
            step: { type: 'number', default: 0, validators: { range: { min: 0 } } },
            format: { type: 'string', default: 'number', values: ['number', 'currency'] },
            currency: { type: 'string', requiredWhen: { property: 'format', equals: 'currency' } },
            stepper: { type: 'boolean', default: true },
            error: { type: 'string', runtime: true, default: '' },
            _label: { type: 'string', default: 'Label', kind: 'content' }
        });
    });

    it("should compact the properties of a map's items the same way, and keep string items as they are", () => {
        // Arrange
        const table: RootComponentEntry = Object.freeze({
            ...NUMBER_FIELD,
            name: 'table',
            shape: Object.freeze({
                ...NUMBER_FIELD.shape,
                properties: Object.freeze({
                    columns: Object.freeze({
                        ...FILLER,
                        type: 'map',
                        items: Object.freeze({
                            _title: Object.freeze({ ...FILLER, type: 'string', kind: 'content' }),
                            align: Object.freeze({ ...FILLER, type: 'string', default: 'start', values: Object.freeze(['start', 'end']), reflect: true })
                        })
                    }),
                    _errors: Object.freeze({ ...FILLER, type: 'map', items: 'string' })
                })
            })
        });

        // Act
        const view = toComponentView(table);

        // Assert
        expect(view['properties']).toEqual({
            columns: { type: 'map', items: { _title: { type: 'string', kind: 'content' }, align: { type: 'string', default: 'start', values: ['start', 'end'] } } },
            _errors: { type: 'map', items: 'string' }
        });
    });

    it('should keep the options of the graphics validators whole, so a fields object shows the keys it takes', () => {
        // Arrange
        const viewBox = Object.freeze({
            x: Object.freeze({ type: 'number', required: true }),
            y: Object.freeze({ type: 'number', required: true }),
            width: Object.freeze({ type: 'number', required: true, validators: Object.freeze({ range: Object.freeze({ min: 0 }) }) }),
            height: Object.freeze({ type: 'number', required: true, validators: Object.freeze({ range: Object.freeze({ min: 0 }) }) })
        });
        const fileRef = Object.freeze({ types: Object.freeze(['image/png']), dataUrl: true });
        const figure: ShapeComponentEntry = Object.freeze({
            name: 'figure',
            tier: 'shape',
            size: 'atom',
            summary: 'A test figure',
            category: 'graphics',
            purposes: Object.freeze(['draw a figure']),
            example: Object.freeze({ component: 'figure' }),
            locales: Object.freeze([]),
            tokens: Object.freeze([]),
            shape: Object.freeze({
                summary: 'A test figure',
                properties: Object.freeze({
                    viewBox: Object.freeze({ ...FILLER, type: 'object', validators: Object.freeze({ fields: viewBox }) }),
                    fill: Object.freeze({ ...FILLER, type: 'string', validators: Object.freeze({ color: true }) }),
                    origin: Object.freeze({ ...FILLER, type: 'array', validators: Object.freeze({ vector: 2 }) }),
                    src: Object.freeze({ ...FILLER, type: Object.freeze(['string', 'object']), validators: Object.freeze({ fileRef }) })
                }),
                shared: Object.freeze([]),
                events: Object.freeze(['press']),
                commands: Object.freeze([]),
                layout: false
            }),
            events: Object.freeze(['press'])
        });

        // Act
        const view = toComponentView(figure);

        // Assert
        expect(view['properties']).toEqual({
            viewBox: { type: 'object', validators: { fields: viewBox } },
            fill: { type: 'string', validators: { color: true } },
            origin: { type: 'array', validators: { vector: 2 } },
            src: { type: ['string', 'object'], validators: { fileRef } }
        });
    });

    it('should give the events, commands and tokens once and drop the purposes, a false layout and empty slots', () => {
        // Act
        const view = toComponentView(NUMBER_FIELD);

        // Assert
        expect(Object.keys(view)).toEqual(['name', 'tier', 'category', 'size', 'summary', 'example', 'properties', 'shared', 'events', 'commands', 'tokens', 'locales']);
        expect(view['tokens']).toEqual([{ path: 'field.error.color', type: 'color', default: '{color.danger.base}' }]);
        expect(view['shared']).toEqual(['size', 'density']);
    });

    it('should be much smaller than the catalog entry', () => {
        // Act
        const view = toComponentView(NUMBER_FIELD);

        // Assert
        expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(NUMBER_FIELD).length * 0.6);
    });

    it('should give a composed component its tree and exposed paths, without empty tokens or locales', () => {
        // Act
        const view = toComponentView(CONFIRM_DIALOG);

        // Assert
        expect(view).toEqual({
            name: 'confirmDialog',
            tier: 'composed',
            category: 'overlays',
            size: 'organism',
            summary: 'Ask before an action',
            example: { component: 'confirmDialog' },
            tree: { component: 'modal' },
            exposes: [{ path: 'title' }]
        });
    });
});
