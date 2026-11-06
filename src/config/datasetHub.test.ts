import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authority } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { WriteData } from '../application/use-cases/WriteData.js';
import type { DataOperation } from '../application/use-cases/WriteData.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import type { JsonValue } from '../domain/JsonValue.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import { AuthorityInstanceStates } from '../infrastructure/sync/AuthorityInstanceStates.js';
import { DatasetHub } from '../infrastructure/sync/DatasetHub.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const OWNER = '00000000-0000-4000-8000-0000000000bb';
const { validator, library } = createStateUiAdapters();
const QUIET = Object.freeze({ info: (): void => undefined });

const PARTS = deepFreeze([
    ['models', 'product', { fields: { name: { type: 'string', required: true }, price: { type: 'number' }, gross: { type: 'number' } } }],
    ['models', 'line', { fields: { qty: { type: 'integer', required: true } } }],
    ['data', 'catalog', { model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair', price: 90 } } }],
    [
        'logic',
        'pricing',
        {
            needs: { products: { model: 'product' } },
            params: {},
            rules: { gross: { when: { path: '$.data.products.{id}.price' }, do: [{ command: 'set', target: '$.data.products.{id}.gross', value: '{{ $trigger * 2 }}' }] } }
        }
    ]
] as const);

/** A shop app: the shared catalog as `products`, a persona cart and the pricing module; `logic` is the app's own */
function shop(logic?: object): UiPartBodies['apps'] {
    return deepFreeze({
        uses: { data: { products: { dataset: 'catalog' }, cart: { model: 'line', scope: 'persona' } }, logic: { pricing: {} } },
        start: 'home',
        shell: { component: 'page', children: { main: { component: 'outlet' } } },
        screens: { home: { root: { component: 'text', _text: 'Shop' } } },
        ...(logic !== undefined && { logic })
    }) as unknown as UiPartBodies['apps'];
}

/** Shop A saves a record with a bad field when `$.data.request` is set, and keeps the reason in `$.data.error` */
const SAVE_BAD = deepFreeze({
    rules: {
        add: { when: { path: '$.data.request', is: true }, do: [{ command: 'save-data', into: '$.data.products', key: 'p9', value: { name: 7 }, as: 'saved' }] },
        sorry: { when: { result: 'saved', is: 'rejected' }, do: [{ command: 'set', target: '$.data.error', value: '$result.reason' }] }
    }
});

interface Message {
    type: string;
    result?: string;
    reason?: string;
}

let dir: string;
let folders: PartFolders;
let parts: IndexedUiPartRepository;
let writeData: WriteData;
let failWrites: boolean;
let report: ReturnType<typeof vi.fn<(message: string, details?: unknown) => void>>;
let hub: DatasetHub;
let authorities: AppAuthorities;
let states: AuthorityInstanceStates;
let shopA: UiPart<'apps'>;
let shopB: UiPart<'apps'>;
let shopC: UiPart<'apps'>;

async function part(name: string): Promise<UiPart<'apps'>> {
    const found = await parts.findByName('apps', name);
    if (found === undefined) throw new Error(`no ${name}`);
    return found;
}

/** The catalog as stored on disk, read by a repository of its own */
async function stored(): Promise<{ revision: number; records: JsonValue }> {
    const found = await new FilePartRepository(folders, new KeyedLock()).findByName('data', 'catalog');
    if (found === undefined) throw new Error('no catalog');
    return { revision: found.revision, records: (found.body as unknown as { records: JsonValue }).records };
}

let counter = 0;

/** A view of an instance: sends client changes and keeps the messages it gets */
function view(authority: Authority): { change(path: string, value: unknown): void; received: Message[] } {
    const received: Message[] = [];
    const session = authority.connect({ send: (text) => received.push(JSON.parse(text) as Message), close: () => undefined });
    session.receive(JSON.stringify({ type: 'hello', namespace: authority.namespace, revision: authority.revision(), clientId: `view-${++counter}`, protocol: 1 }));
    received.length = 0;
    return {
        change: (path, value) => session.receive(JSON.stringify({ type: 'change', change: { id: `c-${++counter}`, path, op: 'set', value, base: authority.revision() } })),
        received
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-dataset-hub-'));
    folders = new PartFolders(dir);
    const lock = new KeyedLock();
    parts = new IndexedUiPartRepository(new FilePartRepository(folders, lock));
    const writePart = new WritePart(parts, parts, validator, QUIET);
    for (const [kind, name, body] of [...PARTS, ['apps', 'shop-a', shop(SAVE_BAD)], ['apps', 'shop-b', shop()], ['apps', 'shop-c', shop()]] as const) {
        const written = await writePart.execute({ kind, name, body } as never);
        if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
    }
    let next = 0;
    writeData = new WriteData(parts, validator, () => `id${++next}`, QUIET);
    failWrites = false;
    report = vi.fn<(message: string, details?: unknown) => void>();
    hub = new DatasetHub(
        parts,
        (name: string, operations: readonly DataOperation[]) => (failWrites ? Promise.reject(new Error('EIO: disk error')) : writeData.execute({ name, operations })),
        { info: report }
    );
    authorities = new AppAuthorities(() => undefined, undefined, { library, report: QUIET }, hub);
    states = new AuthorityInstanceStates(parts, new FileUiInstanceRepository(folders, lock, OWNER), authorities, OWNER, QUIET.info, hub);
    [shopA, shopB, shopC] = [await part('shop-a'), await part('shop-b'), await part('shop-c')];
});

afterEach(async () => {
    await authorities?.close();
    await rm(dir, { recursive: true, force: true });
});

describe('DatasetHub', () => {
    it('should write a client change through to the dataset and apply it to the other instance', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const b = await states.authority(shopB);
        const viewA = view(a);
        const viewB = view(b);

        // Act
        viewA.change('$.data.products.p2.name', 'Armchair');
        await hub.settled();
        viewB.change('$.data.products.p3', { name: 'Desk', price: 100 });
        await hub.settled();

        // Assert
        const expected = { p1: { name: 'Lamp', price: 30, gross: 60 }, p2: { name: 'Armchair', price: 90, gross: 180 }, p3: { name: 'Desk', price: 100, gross: 200 } };
        expect((await stored()).records).toEqual(expected);
        expect(a.get('$.data.products')).toEqual(expected);
        expect(b.get('$.data.products')).toEqual(expected);
        // the gross rule derived p1's and p2's gross when shop A started (a write each), then one write per change: shop
        // B's rule wrote p3's gross before the hub wrote p3 through, so the record went whole
        expect((await stored()).revision).toBe(5);
    });

    it('should write the values a rule derives at start through to the dataset, and give them to the next instance', async () => {
        // Act
        const a = await states.authority(shopA);
        await hub.settled();
        const b = await states.authority(shopB);
        await hub.settled();

        // Assert
        const expected = { p1: { name: 'Lamp', price: 30, gross: 60 }, p2: { name: 'Chair', price: 90, gross: 180 } };
        expect((await stored()).records).toEqual(expected);
        expect(a.get('$.data.products')).toEqual(expected);
        expect(b.get('$.data.products')).toEqual(expected);
        // shop B derived the same values, so it wrote nothing more
        expect((await stored()).revision).toBe(3);
    });

    it('should settle when a module rule on both instances writes the same derived value, with one delivery per change per other instance', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const b = await states.authority(shopB);
        const c = await states.authority(shopC);
        await hub.settled();
        const receive = vi.spyOn(authorities, 'receiveInstance');
        const viewA = view(a);

        // Act
        viewA.change('$.data.products.p1.price', 40);
        await hub.settled();

        // Assert
        const lamp = { name: 'Lamp', price: 40, gross: 80 };
        for (const authority of [a, b, c]) expect(authority.get('$.data.products.p1')).toEqual(lamp);
        expect((await stored()).records).toMatchObject({ p1: lamp });
        const delivered = receive.mock.calls.map(([key]) => key.appId);
        expect(delivered.filter((appId) => appId === shopB.id)).toHaveLength(1);
        expect(delivered.filter((appId) => appId === shopC.id)).toHaveLength(1);
        expect(delivered.filter((appId) => appId === shopA.id)).toHaveLength(0);
    });

    it('should reject a client change that leaves a record invalid, naming the record and the field', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const viewA = view(a);

        // Act
        viewA.change('$.data.products.p1.price', 'cheap');
        await hub.settled();

        // Assert
        const ack = viewA.received.find((message) => message.type === 'ack');
        expect(ack?.result).toBe('rejected');
        expect(ack?.reason).toContain('"price"');
        expect(ack?.reason).toContain('"p1"');
        expect(a.get('$.data.products.p1.price')).toBe(30);
        // the two writes are the grosses the pricing rule derived at start
        expect(await stored()).toEqual({ revision: 3, records: { p1: { name: 'Lamp', price: 30, gross: 60 }, p2: { name: 'Chair', price: 90, gross: 180 } } });
    });

    it('should give a save-data with a bad field the rejected result and leave the dataset file unchanged', async () => {
        // Arrange
        await states.authority(shopA);
        await hub.settled();
        const before = await stored();

        // Act
        const refused = await states.write(shopA, '$.data.request', true);
        await hub.settled();

        // Assert
        expect(refused).toBeUndefined();
        const error = String((await states.authority(shopA)).get('$.data.error'));
        expect(error).toContain('"p9"');
        expect(error).toContain('"name"');
        expect((await states.authority(shopA)).get('$.data.products.p9')).toBeUndefined();
        expect(await stored()).toEqual(before);
    });

    it('should refuse a tool write that leaves a record invalid', async () => {
        // Act
        const refused = await states.write(shopB, '$.data.products.p2', { price: 5 });

        // Assert
        expect(refused).toContain('"name"');
        expect((await states.authority(shopB)).get('$.data.products.p2')).toEqual({ name: 'Chair', price: 90, gross: 180 });
    });

    it('should put the stored records back into the instance and report when the write-through fails', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const b = await states.authority(shopB);
        const viewA = view(a);
        failWrites = true;

        // Act
        viewA.change('$.data.products.p2.name', 'Sofa');
        await hub.settled();

        // Assert
        expect(a.get('$.data.products')).toEqual((await stored()).records);
        expect(b.get('$.data.products.p2.name')).toBe('Chair');
        expect(report).toHaveBeenCalledWith('Shared data not written', expect.objectContaining({ dataset: 'catalog', reason: 'EIO: disk error' }));
    });

    it('should apply a write of the dataset from elsewhere to every instance, whose rules derive and write back, without restarting them', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const b = await states.authority(shopB);
        await hub.settled();

        // Act
        await writeData.execute({ name: 'catalog', operations: [{ op: 'remove', path: 'p1' }, { op: 'set', path: 'p2.price', value: 95 }] });
        await hub.settled();

        // Assert
        const expected = { p2: { name: 'Chair', price: 95, gross: 190 } };
        expect(a.get('$.data.products')).toEqual(expected);
        expect(b.get('$.data.products')).toEqual(expected);
        expect((await stored()).records).toEqual(expected);
        expect(await states.authority(shopA)).toBe(a);
        expect((await states.shape(shopA)).document['data']).toMatchObject({ products: expected });
    });

    it('should not share a persona binding', async () => {
        // Arrange
        const a = await states.authority(shopA);
        const b = await states.authority(shopB);
        const viewA = view(a);

        // Act
        viewA.change('$.data.cart.l1', { qty: 2 });
        await hub.settled();

        // Assert
        expect(a.get('$.data.cart.l1')).toEqual({ qty: 2 });
        expect(b.get('$.data.cart.l1')).toBeUndefined();
        // the two writes are the grosses the pricing rule derived at start, not the cart
        expect((await stored()).revision).toBe(3);
    });
});
