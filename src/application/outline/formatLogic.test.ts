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

    it('should return no lines when the document has no logic', () => {
        expect(formatLogic(undefined, () => undefined)).toEqual([]);
    });
});
