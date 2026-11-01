import { describe, it, expect } from 'vitest';
import type { JsonObject } from '../../domain/JsonValue.js';
import { MAX_OUTLINE_LINES, formatOutline } from './formatOutline.js';
import type { OutlineSource } from './formatOutline.js';

function source(root: JsonObject, extra: Partial<OutlineSource> = {}): OutlineSource {
    return {
        root,
        rootKey: undefined,
        appPath: [],
        overlay: undefined,
        snapshotApp: undefined,
        recordCount: () => undefined,
        depth: undefined,
        ...extra
    };
}

function lines(root: JsonObject, extra: Partial<OutlineSource> = {}): string[] {
    return formatOutline(source(root, extra)).text.split('\n');
}

describe('formatOutline', () => {
    it('should print the spec example shape', () => {
        const root: JsonObject = {
            component: 'page',
            _title: 'Orders',
            children: {
                order: {
                    component: 'panel',
                    _title: 'Order',
                    children: {
                        form: {
                            component: 'form',
                            children: {
                                customer: { component: 'textField', _label: 'Customer', '<-value': '$.data.order.customer' },
                                status: { component: 'selectField', _label: 'Status', '<-value': '$.data.order.status' }
                            }
                        },
                        footer: {
                            component: 'toolbar',
                            children: {
                                save: { component: 'button', _title: 'Save' },
                                cancel: { component: 'button', _title: 'Cancel' }
                            }
                        }
                    }
                },
                confirm: { component: 'modal', _title: 'Discard changes?', open: false }
            }
        };

        expect(lines(root)).toEqual([
            'page "Orders"',
            '  panel order "Order"',
            '    form',
            '      textField customer "Customer" <-$.data.order.customer',
            '      selectField status "Status" <-$.data.order.status',
            '    toolbar footer [button save "Save", button cancel "Cancel"]',
            '  modal confirm "Discard changes?" (closed)'
        ]);
    });

    it('should try _title, then _label, then _text and skip empty text', () => {
        const root: JsonObject = {
            component: 'page',
            children: {
                a: { component: 'text', _title: '', _label: 'L', _text: 'T' },
                b: { component: 'text', _text: 'T' },
                c: { component: 'text', _text: '   ' }
            }
        };

        expect(lines(root).slice(1)).toEqual(['  text a "L"', '  text b "T"', '  text c']);
    });

    it('should leave out the content of a linked property and long text should be cut', () => {
        const root: JsonObject = {
            component: 'page',
            children: {
                a: { component: 'text', _text: 'default', '<-_text': '$.data.name' },
                b: { component: 'text', _text: `${'x'.repeat(100)}\nsecond line` }
            }
        };

        const output = lines(root);

        expect(output[1]).toBe('  text a <-$.data.name');
        expect(output[2]).toBe(`  text b "${'x'.repeat(79)}…"`);
    });

    it('should show hidden and closed nodes with marks', () => {
        const root: JsonObject = {
            component: 'page',
            children: { a: { component: 'text', hidden: true }, b: { component: 'drawer', hidden: true, open: false } }
        };

        expect(lines(root).slice(1)).toEqual(['  text a (hidden)', '  drawer b (hidden, closed)']);
    });

    it('should let the snapshot reopen a closed node', () => {
        const root: JsonObject = { component: 'page', children: { dialog: { component: 'modal', open: false } } };

        const output = lines(root, { snapshotApp: { children: { dialog: { open: true } } } });

        expect(output).toEqual(['page', '  modal dialog']);
    });

    it('should print a row template once with the record count of 10,000 records', () => {
        const root: JsonObject = {
            component: 'page',
            children: { rows: { component: 'list', '<-items': '$.data.rows', row: { component: 'text', '<-_text': '$row.name' } } }
        };

        const output = lines(root, { recordCount: (target) => (target === '$.data.rows' ? 10000 : undefined) });

        expect(output).toEqual(['page', '  list rows <-$.data.rows', '    text row <-$row.name (10000 records)']);
    });

    it('should print a row template without a count when no link feeds it', () => {
        const root: JsonObject = { component: 'list', row: { component: 'text' } };

        expect(lines(root)).toEqual(['list', '  text row']);
    });

    it('should keep a toolbar with a nested child on separate lines', () => {
        const root: JsonObject = {
            component: 'toolbar',
            children: { a: { component: 'button', children: { i: { component: 'icon' } } } }
        };

        expect(lines(root)).toEqual(['toolbar', '  button a', '    icon i']);
    });

    it('should use the overlay content below the application root and the node key at a subtree', () => {
        const root: JsonObject = { component: 'panel', _title: 'Order' };

        const output = lines(root, {
            rootKey: 'order',
            appPath: ['children', 'order'],
            overlay: { children: { order: { _title: 'Bestellung' } } }
        });

        expect(output).toEqual(['panel order "Bestellung"']);
    });

    it('should ignore the overlay for a tree outside app', () => {
        const root: JsonObject = { component: 'toolbar', _title: 'T' };

        expect(lines(root, { appPath: undefined, overlay: { _title: 'X' }, snapshotApp: { open: false } })).toEqual(['toolbar "T"']);
    });

    describe('depth', () => {
        const root: JsonObject = {
            component: 'page',
            children: { a: { component: 'panel', children: { b: { component: 'text' } } }, c: { component: 'text' } }
        };

        it('should show a node one level below the limit as one line with its child count', () => {
            expect(lines(root, { depth: 0 })).toEqual(['page', '  panel a (+1 children)', '  text c']);
        });

        it('should show every level when the depth is large', () => {
            expect(lines(root, { depth: 5 })).toEqual(['page', '  panel a', '    text b', '  text c']);
        });
    });

    describe('line cap', () => {
        it('should cut at the cap and say how much was cut', () => {
            const children = Object.fromEntries(Array.from({ length: 450 }, (_unused, index) => [`n${index}`, { component: 'text' }]));

            const outline = formatOutline(source({ component: 'page', children }));

            expect(outline.lineCount).toBe(451);
            expect(outline.cutLines).toBe(51);
            const output = outline.text.split('\n');
            expect(output).toHaveLength(MAX_OUTLINE_LINES + 1);
            expect(output[MAX_OUTLINE_LINES]).toContain('51 more lines not shown');
        });

        it('should not cut an outline of exactly the cap', () => {
            const children = Object.fromEntries(Array.from({ length: MAX_OUTLINE_LINES - 1 }, (_unused, index) => [`n${index}`, { component: 'text' }]));

            const outline = formatOutline(source({ component: 'page', children }));

            expect(outline.lineCount).toBe(MAX_OUTLINE_LINES);
            expect(outline.cutLines).toBe(0);
        });
    });

    it('should return an empty outline for a root that is not a node', () => {
        expect(formatOutline(source({}))).toEqual({ text: '', lineCount: 0, cutLines: 0 });
    });
});
