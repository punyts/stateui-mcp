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
                    when: { path: '$.data.order' },
                    inputs: { country: '$.data.order.country' },
                    rows: [
                        { match: { country: 'NL' }, if: '$total >= 50', do: [{ command: 'set', target: '$.data.order.shipping', value: 0 }] },
                        { do: [{ command: 'set', target: '$.data.order.shipping', value: 5 }] }
                    ]
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
            '  table shipping when $.data.order inputs country',
            '    country = NL, if $total >= 50: set',
            '    otherwise: set'
        ]);
    });

    it('should return no lines when the document has no logic', () => {
        expect(formatLogic(undefined, () => undefined)).toEqual([]);
    });
});
