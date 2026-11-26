import { wiredSession } from '../../testing/syncWire.js';
import { FunctionTable, hostCatalog, libraryFromCatalog } from '@punyts/stateui-app/core';
import type { CatalogSource, FunctionCatalog, FunctionCode, LogicComputeFunction, LogicEffectFunction } from '@punyts/stateui-app/core';
import { createAuthority, createMemoryNamespaceStorage } from '@punyts/state-sync/authority';
import type { Authority } from '@punyts/state-sync/authority';
import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { loadCatalogFile } from '../stateUiLibrary.js';
import { AppEffects } from './AppEffects.js';
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
                            { command: 'save-data', into: '$.data.contacts', value: { form: '#addContact.body' }, as: 'save' }
                        ],
                        to: 'saving'
                    },
                    {
                        from: 'saving',
                        when: { result: 'save', is: 'accepted' },
                        do: [
                            { command: 'reset', target: '#addContact.body' },
                            { command: 'set', target: '#addContact.open', value: false },
                            { command: 'notify', target: 'toast', value: { text: 'Contact added' } }
                        ],
                        to: 'editing'
                    },
                    {
                        from: 'saving',
                        when: { result: 'save', is: 'rejected' },
                        do: [{ command: 'set', target: '#addContact.error', value: '{{ $result.reason }}' }],
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
const change = (path: string, value: unknown) => ({ type: 'change', change: { id: `c-${++counter}`, path, op: 'set', value, base: 0 } });

async function setup(document: UiDocument = DOCUMENT, history = 0) {
    const authority: Authority = await createAuthority({
        namespace: NAMESPACE,
        storage: createMemoryNamespaceStorage(),
        initial: { data: JSON.parse(JSON.stringify(document['data'])), app: {} },
        createParents: true,
        history
    });
    const events: [string, JsonValue | undefined][] = [];
    const failures: string[] = [];
    const logic = new AppLogic(authority, library, (name, payload) => events.push([name, payload]), (_message, failure) => failures.push(failure.reason));
    logic.setDocument(document);
    const received: Message[] = [];
    const { send } = wiredSession((push) => authority.connect({ send: push, close: () => undefined }), received);
    send({ type: 'hello', namespace: NAMESPACE, revision: authority.revision(), clientId: 'view-1', protocol: 4 });
    received.length = 0;
    return { authority, logic, events, failures, received, send };
}

describe('AppLogic', () => {
    it('should write the initial machine state', async () => {
        const { authority } = await setup();

        expect(authority.get('$.app.children.addContact.phase')).toBe('editing');
    });

    it('should save a form when a view sets saved, and push each transition as one message', async () => {
        // Arrange
        const { authority, events, failures, received, send } = await setup();
        send(change('$.app.children.addContact.body.children.name.value', 'Ana'));
        received.length = 0;

        // Act
        send(change('$.app.children.addContact.saved', true));
        // the save's result waits until the write is durable
        await authority.whenDurable();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        const contacts = authority.get('$.data.contacts') as Record<string, { name: string }>;
        expect(Object.values(contacts)).toEqual([{ name: 'Ana' }]);
        expect(authority.get('$.data.stats.contacts')).toBe(1);
        expect(authority.get('$.app.children.addContact.body.children.name.value')).toBe('');
        expect(authority.get('$.app.children.addContact.open')).toBe(false);
        expect(authority.get('$.app.children.addContact.phase')).toBe('editing');
        expect(events).toEqual([]);
        expect(failures).toEqual([]);
        const pushed = received.filter((message) => message.type === 'changes');
        expect(pushed[0]?.changes?.map((item) => item.path)).toEqual([
            '$.app.children.addContact.saved',
            '$.data.contacts.' + Object.keys(contacts)[0],
            '$.app.children.addContact.phase'
        ]);
        expect(received.some((message) => message.type === 'emit' && message.name === 'notify.toast')).toBe(true);
    });

    it('should run no logic for an undo of a client change', async () => {
        // Arrange
        const { authority, send } = await setup(DOCUMENT, 10);
        send(change('$.data.contacts.c1', { name: 'Bo' }));
        const counted = authority.get('$.data.stats.contacts');

        // Act
        send({ type: 'undo' });

        // Assert
        expect(counted).toBe(1);
        expect(authority.get('$.data.contacts.c1')).toBeUndefined();
        expect(authority.get('$.data.stats.contacts')).toBe(1);
    });

    it('should reject a client change a guard refuses', async () => {
        const { authority, received, send } = await setup();

        send(change('$.data.contacts.c1', { name: 'draft' }));

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
        const { authority, send } = await setup();
        send(change('$.app.children.addContact.body.children.name.value', 'draft'));

        send(change('$.app.children.addContact.saved', true));

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
        first.send(change('$.data.stats.contacts', 3));
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

    it('should stop logic whose timers fire more often than the limit, and report it once', async () => {
        vi.useFakeTimers();
        try {
            // Arrange: a machine that flips between two states every 10 ms, forever
            const document = {
                ...DOCUMENT,
                logic: {
                    machines: {
                        blink: {
                            state: '$.app.blink',
                            initial: 'on',
                            transitions: [
                                { from: 'on', when: { after: 10 }, to: 'off' },
                                { from: 'off', when: { after: 10 }, to: 'on' }
                            ]
                        }
                    }
                }
            } as unknown as UiDocument;
            const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: {}, app: {} }, createParents: true });
            const failures: string[] = [];
            const logic = new AppLogic(authority, library, () => undefined, (_message, failure) => failures.push(`${failure.name}: ${failure.reason}`), undefined, undefined, undefined, undefined, {
                timerRunsPerSecond: 5
            });
            logic.setDocument(document);

            // Act
            vi.advanceTimersByTime(55);
            const stoppedAt = authority.get('$.app.blink');
            vi.advanceTimersByTime(1000);

            // Assert
            expect(failures).toEqual(['timers: more than 5 timers fired in one second, so the logic stopped until the app changes']);
            expect(authority.get('$.app.blink')).toBe(stoppedAt);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('should run an effect of the host catalog, keeping its records in $.server', async () => {
        // Arrange
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: {}, app: {} }, createParents: true, serverKey: new Uint8Array(32) });
        const requests: JsonValue[] = [];
        const failures: string[] = [];
        const ordersFetch: LogicEffectFunction = async (request) => {
            requests.push(request as JsonValue);
            return { first: 0, total: 1, records: [{ id: 'o1', name: 'First' }] };
        };
        const functions = new FunctionTable([hostCatalog({ ordersFetch: { id: crypto.randomUUID(), kind: 'effect', summary: 'Orders', code: ordersFetch } })], 'server');
        const logic = new AppLogic(authority, library, () => undefined, (_message, failure) => failures.push(failure.reason), undefined, undefined, functions);
        logic.setDocument({
            data: {},
            app: { component: 'page' },
            logic: {
                effects: {
                    fetchOrders: {
                        request: '$.data.orders.request',
                        run: '$.functions.host.ordersFetch',
                        status: '$.data.orders.status',
                        records: { into: '$.server.orders', key: 'id' },
                        window: '$.data.orders.view'
                    }
                }
            }
        } as unknown as UiDocument);

        // Act
        logic.write('$.data.orders.request', { first: 0, count: 10 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        expect(failures).toEqual([]);
        expect(requests).toEqual([{ first: 0, count: 10 }]);
        expect(authority.get('$.server.orders')).toEqual({ o1: { id: 'o1', name: 'First' } });
        expect(authority.get('$.data.orders.view')).toEqual({ records: { 0: { id: 'o1', name: 'First' } }, total: 1 });
        expect(authority.get('$.data.orders.status.state')).toBe('ready');
    });

    it('should start the logic once a lazy catalog has loaded the functions it names, and derive then if asked meanwhile', async () => {
        // Arrange
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: { net: 5 }, app: {} }, createParents: true });
        const id = crypto.randomUUID();
        const double: LogicComputeFunction = ({ net }) => ({ out: Number(net) * 2 });
        let release: (code: FunctionCode) => void = () => undefined;
        const lazy: FunctionCatalog = {
            name: 'lazy',
            entries: [{ id, path: '$.functions.lazy.double', kind: 'compute', runs: ['server'], summary: 'Doubles', inputs: {}, outputs: {} }],
            load: () => new Promise<FunctionCode>((resolve) => (release = resolve))
        };
        const failures: string[] = [];
        const logic = new AppLogic(authority, library, () => undefined, (_message, failure) => failures.push(failure.reason), undefined, undefined, new FunctionTable([lazy], 'server'));
        logic.setDocument(
            { data: {}, app: { component: 'page' }, logic: { computes: { double: { inputs: { net: '$.data.net' }, run: '$.functions.lazy.double', outputs: { out: '$.data.gross' } } } } } as unknown as UiDocument,
            { derive: false }
        );

        // Act
        logic.derive();
        const before = authority.get('$.data.gross');
        release(double);
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        expect(before).toBeUndefined();
        expect(authority.get('$.data.gross')).toBe(10);
        expect(failures).toEqual([]);
    });

    it('should ask the agent for an effect the server does not have and commit the answer it gives', async () => {
        // Arrange
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: {}, app: {} }, createParents: true });
        const queued: JsonValue[] = [];
        const effects = new AppEffects((_appId, _name, payload) => queued.push(payload), () => 'e1');
        const logic = new AppLogic(authority, library, () => undefined, () => undefined, undefined, undefined, undefined, (request, signal) => effects.ask('a1', request, signal));
        logic.setDocument({
            data: {},
            app: { component: 'page' },
            logic: { effects: { fetchOrders: { request: '$.data.orders.request', run: '$.functions.host.ordersFetch', status: '$.data.orders.status', records: { into: '$.data.orders.records', key: 'id' }, window: '$.data.orders.view' } } }
        } as unknown as UiDocument);

        // Act
        logic.write('$.data.orders.request', { page: 1 });
        const loading = authority.get('$.data.orders.status.state');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const answered = effects.answer('a1', 'e1', { answer: { total: 1, records: [{ id: 'o1' }] } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        expect(queued).toEqual([{ id: 'e1', name: 'fetchOrders', token: authority.get('$.data.orders.status.token'), request: { page: 1 } }]);
        expect([loading, answered]).toEqual(['loading', true]);
        expect(authority.get('$.data.orders.records')).toEqual({ o1: { id: 'o1' } });
        expect(authority.get('$.data.orders.status.state')).toBe('ready');
        expect(logic.effects()).toEqual([{ name: 'fetchOrders', token: authority.get('$.data.orders.status.token'), running: false, cached: 0 }]);
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

    it('should run the server units and skip a unit that runs in the browser', async () => {
        // Arrange
        const document = {
            ...DOCUMENT,
            logic: {
                rules: {
                    count: { runs: 'server', when: { path: '$.data.contacts' }, do: [{ command: 'set', target: '$.data.stats.contacts', value: '{{ size($.data.contacts) }}' }] },
                    local: { runs: 'browser', when: { path: '$.data.contacts' }, do: [{ command: 'set', target: '$.data.local', value: true }] },
                    plain: { when: { path: '$.data.contacts' }, do: [{ command: 'set', target: '$.data.plain', value: true }] }
                }
            }
        } as unknown as UiDocument;
        const { authority, send } = await setup(document);

        // Act
        send(change('$.data.contacts.c1', { name: 'Bo' }));

        // Assert
        expect(authority.get('$.data.stats.contacts')).toBe(1);
        expect(authority.get('$.data.plain')).toBe(true);
        expect(authority.get('$.data.local')).toBeUndefined();
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

describe('AppLogic screens', () => {
    it("should read a screen value nobody wrote as the definition's, and a written one as written", async () => {
        // Arrange
        const document = Object.freeze({
            data: { go: '', copied: '' },
            app: { component: 'page' },
            screens: { 'new-order': { root: { component: 'page', children: { qty: { component: 'textField', value: '3' } } } } },
            start: 'new-order',
            logic: { rules: { copy: { when: { path: '$.data.go' }, do: [{ command: 'set', target: '$.data.copied', value: '{{ $.screens.new-order.children.qty.value }}' }] } } }
        }) as unknown as UiDocument;
        const { authority, logic, failures } = await setup(document);

        // Act
        logic.write('$.data.go', 'first');
        const unwritten = authority.get('$.data.copied');
        logic.write('$.screens.new-order.children.qty.value', '7');
        logic.write('$.data.go', 'second');

        // Assert
        expect(unwritten).toBe('3');
        expect(authority.get('$.data.copied')).toBe('7');
        expect(failures).toEqual([]);
    });
});

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

describe('AppLogic data gate', () => {
    async function gated(refuse: (path: string) => string | undefined) {
        const authority: Authority = await createAuthority({
            namespace: NAMESPACE,
            storage: createMemoryNamespaceStorage(),
            initial: { data: JSON.parse(JSON.stringify(DOCUMENT['data'])), app: {} },
            createParents: true
        });
        const applied: string[][] = [];
        const gate = Object.freeze({
            check: (writes: readonly { path: string }[]) => writes.map((write) => refuse(write.path)).find((reason) => reason !== undefined),
            applied: (writes: readonly { path: string }[]) => {
                applied.push(writes.map((write) => write.path));
            }
        });
        const logic = new AppLogic(authority, library, () => undefined, () => undefined, undefined, gate);
        logic.setDocument(DOCUMENT);
        return { authority, logic, applied };
    }

    it('should refuse a tool write the gate refuses, with or without logic, and tell the gate what was written', async () => {
        // Arrange
        const { authority, logic, applied } = await gated((path) => (path.startsWith('$.data.contacts.bad') ? 'not a contact' : undefined));

        // Act
        const refused = [logic.write('$.data.contacts.bad', { name: 'X' }), logic.write('$.data.contacts.bad', { name: 'X' }, false)];
        const written = logic.write('$.data.contacts.c1', { name: 'Ana' });

        // Assert
        expect(refused).toEqual(['not a contact', 'not a contact']);
        expect(written).toBeUndefined();
        expect(authority.get('$.data.contacts')).toEqual({ c1: { name: 'Ana' } });
        // the machine's initial state and the count the stats rule derived at start, then the write and its count
        expect(applied).toEqual([['$.app.children.addContact.phase'], ['$.data.stats.contacts'], ['$.data.contacts.c1'], ['$.data.stats.contacts']]);
    });

    it('should run the rules for writes it receives, without asking the gate', async () => {
        // Arrange
        const { authority, logic } = await gated(() => 'refused');

        // Act
        logic.receive([{ path: '$.data.contacts.c1', op: 'set', value: { name: 'Ana' } }]);

        // Assert
        expect(authority.get('$.data.contacts.c1')).toEqual({ name: 'Ana' });
        // the rule's own commit asks the gate, which refuses it here
        expect(authority.get('$.data.stats.contacts')).toBe(0);
    });
});
