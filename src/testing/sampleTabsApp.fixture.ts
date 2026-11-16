import type { UiDocument } from '../domain/UiApp.js';
import { deepFreeze } from './sampleFormAndListApp.fixture.js';

/**
 * A valid app of the old single-document form whose root is a hidden-strip `tabs`, so the converter makes each tab
 * a screen: a theme with a mode overlay, an owner component (`Product Card`), two record sets in `data`, a rule that
 * writes into a tab and a German locale. The converter's fixture for the data directory (O2.10)
 */
export const SAMPLE_TABS_APP: UiDocument = deepFreeze({
    theme: { tokens: { color: { accent: { base: '#0050a0' } } } },
    themes: { night: { kind: 'mode', tokens: { color: { surface: { base: '#101820' } } } } },
    app: {
        component: 'tabs',
        strip: 'hidden',
        active: 'home',
        children: {
            home: {
                component: 'panel',
                placement: { _tab: 'Home' },
                children: {
                    intro: { component: 'text', _text: 'Lamps and chairs' },
                    featured: { component: 'Product Card' },
                    open: {
                        component: 'button',
                        _title: 'Open bag',
                        on: { press: { command: 'set', target: '$.app.active', value: 'bag' } }
                    }
                }
            },
            bag: {
                component: 'panel',
                placement: { _tab: 'Your bag' },
                children: {
                    count: { component: 'text', _text: '' },
                    lines: { component: 'list', '<-items': '$.data.bag', row: { component: 'text', '<-_text': '$row.product' } }
                }
            }
        }
    },
    composed: {
        'Product Card': {
            component: 'panel',
            _title: 'Product',
            children: { name: { component: 'text', _text: 'A product' } },
            exposes: { 'children.name._text': 'The product name' }
        }
    },
    data: {
        products: [
            { id: 'p1', name: 'Lamp', price: 30 },
            { id: 'p2', name: 'Chair', price: 90.5 }
        ],
        bag: { l1: { product: 'p1', qty: 1 } }
    },
    logic: {
        rules: {
            counted: {
                when: { path: '$.data.bag' },
                do: [{ command: 'set', target: '$.app.children.bag.children.count._text', value: '{{ count($.data.bag) }} lines' }]
            }
        }
    },
    locales: {
        de: { children: { home: { children: { intro: { _text: 'Lampen und Stühle' } } } } }
    }
}) as unknown as UiDocument;
