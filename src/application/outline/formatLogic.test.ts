import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../domain/JsonValue.js';
import { formatLogic } from './formatLogic.js';

const LOGIC = Object.freeze({
    machines: {
        addContact: {
            state: '$.app.children.addContact.phase',
            initial: 'editing',
            transitions: [
                {
                    from: 'editing',
                    when: { path: '$.app.children.addContact.saved', is: true },
                    do: [{ command: 'save-data', into: '$.data.contacts', value: { form: '^addContact.body' }, as: 'save' }],
                    to: 'saving'
                },
                { from: 'saving', when: { result: 'save', is: 'accepted' }, do: [{ command: 'notify', target: 'toast' }], to: 'editing' }
            ]
        }
    },
    rules: {
        count: { when: { path: '$.data.contacts' }, do: [{ command: 'set', target: '$.data.stats.count', value: 1 }] },
        noDrafts: { when: { path: '$.data.contacts.{id}', if: "$trigger.name == 'draft'" }, do: [{ command: 'reject', reason: 'No drafts' }] }
    }
}) as unknown as JsonValue;

describe('formatLogic', () => {
    it('should list machines with their current state, transitions, rules and guards', () => {
        const lines = formatLogic(LOGIC, (path) => (path === '$.app.children.addContact.phase' ? 'saving' : undefined));

        expect(lines).toEqual([
            'logic',
            '  machine addContact: saving (at $.app.children.addContact.phase)',
            '    editing → saving when $.app.children.addContact.saved is true: save-data as save',
            '    saving → editing when result save is accepted: notify toast',
            '  rule count when $.data.contacts: set',
            `  guard noDrafts when $.data.contacts.{id} if $trigger.name == 'draft': reject "No drafts"`
        ]);
    });

    it('should show the initial state when the state path has no value', () => {
        const lines = formatLogic(LOGIC, () => undefined);

        expect(lines[1]).toBe('  machine addContact: editing (at $.app.children.addContact.phase)');
    });

    it('should list tables with their rows, and timers, was and call targets', () => {
        // Arrange
        const logic = {
            machines: {
                lookup: {
                    state: '$.app.lookup',
                    initial: 'idle',
                    transitions: [
                        { from: 'idle', when: { path: '$.app.query', was: 'none', debounce: 300 }, do: [{ command: 'call', target: 'find', as: 'found' }], to: 'waiting' },
                        { from: 'waiting', when: { after: 5000 }, to: 'idle' }
                    ]
                }
            },
            tables: {
                shipping: {
                    inputs: {
                        country: { path: '$.data.order.country', values: ['NL', '*'] },
                        total: { path: '$.data.order.total', breaks: [50] },
                        note: '$.data.order.note'
                    },
                    outputs: { fee: '$.data.order.shipping' },
                    rows: [
                        { country: 'NL', total: '>=50', fee: 0 },
                        { country: '*', fee: '{{ $total / 10 }}' }
                    ]
                },
                rate: {
                    inputs: { country: { path: '$.data.order.country', values: { keys: '$.data.countries' } } },
                    outputs: { fee: '$.data.order.fee' },
                    rows: { from: '$.data.rates' }
                }
            }
        } as unknown as JsonValue;

        // Act
        const lines = formatLogic(logic, () => undefined);

        // Assert
        expect(lines).toEqual([
            'logic',
            '  machine lookup: idle (at $.app.lookup)',
            '    idle → waiting when $.app.query was none debounce 300 ms: call find as found',
            '    waiting → idle after 5000 ms',
            '  table shipping inputs country (NL, *), total (breaks 50), note → fee $.data.order.shipping',
            '    country NL, total >=50 → fee 0',
            '    otherwise → fee {{ $total / 10 }}',
            '  table rate inputs country (keys of $.data.countries) rows from $.data.rates → fee $.data.order.fee'
        ]);
    });

    it('should list compute units, and effects with their status', () => {
        // Arrange
        const logic = {
            computes: { tax: { inputs: { amount: '$.data.lines.{id}.amount' }, run: 'pricing.tax', outputs: { tax: '$.data.lines.{id}.tax' } } },
            effects: {
                fetchOrders: {
                    request: '$.data.orders.request',
                    run: 'orders.fetch',
                    status: '$.data.orders.status',
                    records: { into: '$.data.orders.records', key: 'id' },
                    window: '^orders',
                    cache: 20
                },
                ping: { request: '$.data.ping', run: 'ping', status: '$.data.pong' }
            }
        } as unknown as JsonValue;
        const state: Record<string, JsonValue> = { '$.data.orders.status': { token: 'abc', state: 'ready', total: 120, at: '2026-01-01T00:00:00.000Z' } };

        // Act
        const lines = formatLogic(logic, (path) => state[path]);

        // Assert
        expect(lines).toEqual([
            'logic',
            '  compute tax runs pricing.tax inputs amount → tax $.data.lines.{id}.tax',
            '  effect fetchOrders runs orders.fetch on $.data.orders.request records into $.data.orders.records by id window ^orders cache 20',
            '    status ready, total 120, token abc (at $.data.orders.status)',
            '  effect ping runs ping on $.data.ping',
            '    status idle (at $.data.pong)'
        ]);
    });

    it('should return no lines when the document has no logic', () => {
        expect(formatLogic(undefined, () => undefined)).toEqual([]);
    });
});
