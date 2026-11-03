import { libraryFromCatalog } from '@punyts/stateui-app/core';
import type { CatalogSource } from '@punyts/stateui-app/core';
import { createAuthority, createMemoryNamespaceStorage } from '@punyts/state-sync/authority';
import type { Authority } from '@punyts/state-sync/authority';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { loadCatalogFile } from '../stateUiLibrary.js';
import { AppLogic } from './AppLogic.js';

const NAMESPACE = 'apps.contacts';
const library = libraryFromCatalog(loadCatalogFile() as unknown as CatalogSource);

const DOCUMENT = Object.freeze({
    data: { contacts: {}, stats: { contacts: 0 } },
    app: {
        component: 'page',
        children: {
            addContact: {
                component: 'modal',
                _title: 'Add contact',
                body: { component: 'form', children: { name: { component: 'textField', _label: 'Name' } } }
            }
        }
    },
    logic: {
        machines: {
            addContact: {
                state: '$.app.children.addContact.phase',
                initial: 'editing',
                transitions: [
                    {
                        from: 'editing',
                        when: { path: '$.app.children.addContact.saved', is: true },
                        do: [
                            { command: 'set', target: '$.app.children.addContact.saved', value: false },
                            { command: 'save-data', into: '$.data.contacts', value: { form: '^addContact.body' }, as: 'save' }
                        ],
                        to: 'saving'
                    },
                    {
                        from: 'saving',
                        when: { result: 'save', is: 'accepted' },
                        do: [
                            { command: 'reset', target: '^addContact.body' },
                            { command: 'set', target: '^addContact.open', value: false },
                            { command: 'notify', target: 'toast', value: { text: 'Contact added' } },
                            { command: 'emit', target: 'contactAdded', value: '$result.key' }
                        ],
                        to: 'editing'
                    },
                    {
                        from: 'saving',
                        when: { result: 'save', is: 'rejected' },
                        do: [{ command: 'set', target: '^addContact.error', value: '{{ $result.reason }}' }],
                        to: 'editing'
                    }
                ]
            }
        },
        rules: {
            contactCount: {
                when: { path: '$.data.contacts' },
                do: [{ command: 'set', target: '$.data.stats.contacts', value: '{{ size($.data.contacts) }}' }]
            },
            noDrafts: {
                when: { path: '$.data.contacts.{id}', if: "$trigger.name == 'draft'" },
                do: [{ command: 'reject', reason: 'Draft is not a name' }]
            }
        }
    }
}) as unknown as UiDocument;

interface Message {
    type: string;
    name?: string;
    value?: JsonValue;
    changes?: { path: string; value?: JsonValue }[];
    result?: string;
    reason?: string;
}

let counter = 0;
const change = (path: string, value: unknown) =>
    JSON.stringify({ type: 'change', change: { id: `c-${++counter}`, path, op: 'set', value, base: 0 } });

async function setup(document: UiDocument = DOCUMENT) {
    const authority: Authority = await createAuthority({
        namespace: NAMESPACE,
        storage: createMemoryNamespaceStorage(),
        initial: { data: JSON.parse(JSON.stringify(document['data'])), app: {} },
        createParents: true
    });
    const events: [string, JsonValue | undefined][] = [];
    const failures: string[] = [];
    const logic = new AppLogic(authority, library, (name, payload) => events.push([name, payload]), (_message, failure) => failures.push(failure.reason));
    logic.setDocument(document);
    const received: Message[] = [];
    const session = authority.connect({ send: (text) => received.push(JSON.parse(text) as Message), close: () => undefined });
    session.receive(JSON.stringify({ type: 'hello', namespace: NAMESPACE, revision: authority.revision(), clientId: 'view-1', protocol: 1 }));
    received.length = 0;
    return { authority, logic, events, failures, received, session };
}

describe('AppLogic', () => {
    it('should write the initial machine state', async () => {
        const { authority } = await setup();

        expect(authority.get('$.app.children.addContact.phase')).toBe('editing');
    });

    it('should save a form when a view sets saved, and push each transition as one message', async () => {
        // Arrange
        const { authority, events, failures, received, session } = await setup();
        session.receive(change('$.app.children.addContact.body.children.name.value', 'Ana'));
        received.length = 0;

        // Act
        session.receive(change('$.app.children.addContact.saved', true));

        // Assert
        const contacts = authority.get('$.data.contacts') as Record<string, { name: string }>;
        expect(Object.values(contacts)).toEqual([{ name: 'Ana' }]);
        expect(authority.get('$.data.stats.contacts')).toBe(1);
        expect(authority.get('$.app.children.addContact.body.children.name.value')).toBe('');
        expect(authority.get('$.app.children.addContact.open')).toBe(false);
        expect(authority.get('$.app.children.addContact.phase')).toBe('editing');
        expect(events).toEqual([['contactAdded', Object.keys(contacts)[0]]]);
        expect(failures).toEqual([]);
        const pushed = received.filter((message) => message.type === 'changes');
        expect(pushed[0]?.changes?.map((item) => item.path)).toEqual([
            '$.app.children.addContact.saved',
            '$.data.contacts.' + Object.keys(contacts)[0],
            '$.app.children.addContact.phase'
        ]);
        expect(received.some((message) => message.type === 'emit' && message.name === 'notify.toast')).toBe(true);
    });

    it('should reject a client change a guard refuses', async () => {
        const { authority, received, session } = await setup();

        session.receive(change('$.data.contacts.c1', { name: 'draft' }));

        expect(authority.get('$.data.contacts')).toEqual({});
        expect(received.find((message) => message.type === 'ack')).toMatchObject({ result: 'rejected', reason: 'Draft is not a name' });
    });

    it('should run the logic for a tool write and refuse one a guard refuses', async () => {
        const { authority, logic } = await setup();

        const accepted = logic.write('$.data.contacts.c1', { name: 'Bo' });
        const refused = logic.write('$.data.contacts.c2', { name: 'draft' });

        expect(accepted).toBeUndefined();
        expect(refused).toBe('Draft is not a name');
        expect(authority.get('$.data.stats.contacts')).toBe(1);
    });

    it('should report a rejected save through its machine', async () => {
        const { authority, session } = await setup();
        session.receive(change('$.app.children.addContact.body.children.name.value', 'draft'));

        session.receive(change('$.app.children.addContact.saved', true));

        expect(authority.get('$.data.contacts')).toEqual({});
        expect(authority.get('$.app.children.addContact.error')).toBe('Draft is not a name');
    });

    it('should stop running when the document has no logic', async () => {
        const { authority, logic } = await setup();
        const { logic: _removed, ...rest } = DOCUMENT as Record<string, JsonValue>;
        logic.setDocument(rest as UiDocument);

        logic.write('$.data.contacts.c1', { name: 'draft' });

        expect(authority.get('$.data.stats.contacts')).toBe(0);
        expect(authority.get('$.data.contacts.c1')).toEqual({ name: 'draft' });
    });
});
