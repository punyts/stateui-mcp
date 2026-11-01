import type { JsonValue } from '../domain/JsonValue.js';
import type { UiDocument } from '../domain/UiApp.js';

/** Freezes a value and everything under it, so a test cannot change the shared fixture by accident */
export function deepFreeze<T extends JsonValue>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child as JsonValue);
        Object.freeze(value);
    }
    return value;
}

/**
 * A valid form-and-list application: a `page` with a `panel` that holds a `form` (a `textField` and a
 * `selectField`) and a `list` linked to `$.data.customers`, a footer `toolbar` with a Save `button`, and a closed
 * `modal`. Children keys are prefix-free words, never integer-like, so their order is the display order.
 * The fixture of the validator tests (E6.4), reused by the preview tests (E6.7)
 */
export const SAMPLE_FORM_AND_LIST_APP: UiDocument = deepFreeze({
    app: {
        component: 'page',
        _title: 'Customers',
        children: {
            main: {
                component: 'panel',
                _title: 'Customer list',
                children: {
                    form: {
                        component: 'form',
                        children: {
                            name: { component: 'textField', _label: 'Name', required: true },
                            status: {
                                component: 'selectField',
                                _label: 'Status',
                                options: {
                                    active: { _label: 'Active' },
                                    paused: { _label: 'Paused' }
                                }
                            }
                        }
                    },
                    customers: {
                        component: 'list',
                        '<-items': '$.data.customers',
                        row: { component: 'text', '<-_text': '$row.name' }
                    }
                }
            },
            confirm: { component: 'modal', open: false, _title: 'Discard changes?' }
        },
        footer: {
            component: 'toolbar',
            children: {
                save: { component: 'button', _title: 'Save', tone: 'accent' }
            }
        }
    },
    data: {
        customers: [
            { id: 'c1', name: 'Ada Lovelace' },
            { id: 'c2', name: 'Grace Hopper' }
        ]
    }
});
