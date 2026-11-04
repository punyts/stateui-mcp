import { libraryFromCatalog } from '@punyts/stateui-app/core';
import type { CatalogSource } from '@punyts/stateui-app/core';
import { createAuthority, createMemoryNamespaceStorage } from '@punyts/state-sync/authority';
import type { Authority } from '@punyts/state-sync/authority';
import { describe, expect, it, vi } from 'vitest';
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

    it('should give a client change and a tool write the value they replaced as $previous', async () => {
        // Arrange
        const document = {
            ...DOCUMENT,
            logic: { rules: { moved: { when: { path: '$.data.stats.contacts', was: 0 }, do: [{ command: 'set', target: '$.data.moved', value: '{{ $previous }}>{{ $trigger }}' }] } } }
        } as unknown as UiDocument;
        const first = await setup(document);
        const second = await setup(document);

        // Act
        first.session.receive(change('$.data.stats.contacts', 3));
        second.logic.write('$.data.stats.contacts', 5);
        second.logic.write('$.data.stats.contacts', 6);

        // Assert
        expect(first.authority.get('$.data.moved')).toBe('0>3');
        expect(second.authority.get('$.data.moved')).toBe('0>5');
    });

    it('should fire an after transition on a timer and stop its timers with the logic', async () => {
        vi.useFakeTimers();
        try {
            // Arrange
            const document = {
                ...DOCUMENT,
                logic: {
                    machines: {
                        toast: {
                            state: '$.app.toast',
                            initial: 'hidden',
                            transitions: [
                                { from: 'hidden', when: { path: '$.data.stats.contacts' }, to: 'shown' },
                                { from: 'shown', when: { after: 1000 }, to: 'hidden' }
                            ]
                        }
                    }
                }
            } as unknown as UiDocument;
            const first = await setup(document);
            const second = await setup(document);

            // Act
            first.logic.write('$.data.stats.contacts', 1);
            second.logic.write('$.data.stats.contacts', 1);
            second.logic.dispose();
            vi.advanceTimersByTime(1000);

            // Assert
            expect(first.authority.get('$.app.toast')).toBe('hidden');
            expect(second.authority.get('$.app.toast')).toBe('shown');
        } finally {
            vi.useRealTimers();
        }
    });

    it('should give a call the answer of its procedure', async () => {
        // Arrange
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: {}, app: {} }, createParents: true });
        const asked: [string, JsonValue][] = [];
        const logic = new AppLogic(authority, library, () => undefined, () => undefined, async (name, payload) => {
            asked.push([name, payload]);
            return { status: 'accepted', value: 42 };
        });
        logic.setDocument({
            data: {},
            app: { component: 'page' },
            logic: {
                machines: {
                    ask: {
                        state: '$.data.phase',
                        initial: 'idle',
                        transitions: [
                            { from: 'idle', when: { path: '$.data.question' }, do: [{ command: 'call', target: 'answer', value: '$trigger', as: 'reply' }], to: 'waiting' },
                            { from: 'waiting', when: { result: 'reply', is: 'accepted' }, do: [{ command: 'set', target: '$.data.answer', value: '$result.value' }], to: 'idle' }
                        ]
                    }
                }
            }
        } as unknown as UiDocument);

        // Act
        logic.write('$.data.question', 'life');
        const waiting = authority.get('$.data.phase');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        expect(waiting).toBe('waiting');
        expect(asked).toEqual([['answer', 'life']]);
        expect(authority.get('$.data.answer')).toBe(42);
        expect(authority.get('$.data.phase')).toBe('idle');
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

/** A shell and two screens; a rule opens `product` with the picked id, and one names a screen that does not exist */
const SCREENS_DOCUMENT = Object.freeze({
    data: { pick: '', lost: '' },
    app: { component: 'page', children: { title: { component: 'text' } } },
    screens: {
        home: { root: { component: 'page', children: { title: { component: 'text' } } } },
        product: { params: { id: { type: 'string', required: true } }, root: { component: 'page' } }
    },
    start: 'home',
    logic: {
        rules: {
            open: { when: { path: '$.data.pick' }, do: [{ command: 'navigate', target: 'product', value: { id: '{{ $trigger }}' } }] },
            lost: { when: { path: '$.data.lost' }, do: [{ command: 'navigate', target: 'cart' }] }
        }
    }
}) as unknown as UiDocument;

describe('AppLogic navigate', () => {
    it('should run navigate on the server and write $.route', async () => {
        const { authority, logic, failures } = await setup(SCREENS_DOCUMENT);

        logic.write('$.data.pick', 'p2');

        expect(authority.get('$.route')).toEqual({ screen: 'product', params: { id: 'p2' } });
        expect(failures).toEqual([]);
    });

    it('should fail a navigate to a screen that does not exist, and write nothing', async () => {
        const { authority, logic, events, failures } = await setup(SCREENS_DOCUMENT);

        logic.write('$.data.lost', 'x');

        expect(authority.get('$.route')).toBeUndefined();
        expect(failures).toEqual(['no screen is named "cart"']);
        expect(events.map(([name]) => name)).toEqual(['logic.failed']);
    });
});
