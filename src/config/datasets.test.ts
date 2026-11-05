import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { QueryData } from '../application/use-cases/QueryData.js';
import { DATA_WRITE_ATTEMPTS, WriteData } from '../application/use-cases/WriteData.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../testing/InMemoryUiPartRepository.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const { validator } = createStateUiAdapters();
const REPORT = Object.freeze({ info: (): void => undefined });

const PRODUCT = deepFreeze({ fields: { name: { type: 'string', required: true }, price: { type: 'number' } } }) as unknown as UiPartBodies['models'];
const STOCK = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp', price: 30 }, p2: { name: 'Chair', price: 50 } } }) as unknown as UiPartBodies['data'];

let parts: IndexedUiPartRepository;
let writeData: WriteData;
let queryData: QueryData;

async function records(): Promise<Record<string, unknown>> {
    return ((await parts.findByName('data', 'stock'))?.body as unknown as { records: Record<string, unknown> }).records;
}

beforeEach(async () => {
    parts = new IndexedUiPartRepository(new InMemoryUiPartRepository());
    let next = 0;
    writeData = new WriteData(parts, validator, () => `id${++next}`, REPORT);
    queryData = new QueryData(parts, REPORT);
    await parts.create({ kind: 'models', name: 'product', body: PRODUCT });
    await parts.create({ kind: 'data', name: 'stock', body: STOCK });
});

describe('WriteData', () => {
    it('should add, set, merge, remove and move records in one write, keeping their order', async () => {
        // Act
        const result = await writeData.execute({
            name: 'stock',
            operations: [
                { op: 'add', value: { name: 'Desk', price: 120 } },
                { op: 'set', path: 'p1.price', value: 35 },
                { op: 'merge', path: 'p2', value: { price: 55 } },
                { op: 'add', value: { name: 'Shelf' } },
                { op: 'remove', path: 'rid2.name' },
                { op: 'set', path: 'rid2.name', value: 'Bookshelf' },
                { op: 'move', path: 'rid1', before: 'p1' }
            ],
            expectedRevision: 1
        });

        // Assert
        expect(result).toEqual({ kind: 'written', revision: 2, added: ['rid1', 'rid2'], created: false });
        expect(Object.entries(await records())).toEqual([
            ['rid1', { name: 'Desk', price: 120 }],
            ['p1', { name: 'Lamp', price: 35 }],
            ['p2', { name: 'Chair', price: 55 }],
            ['rid2', { name: 'Bookshelf' }]
        ]);
    });

    it('should refuse a write that leaves a record invalid, name the record and the field, and write nothing', async () => {
        // Act
        const wrongType = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p1.price', value: 'cheap' }] });
        const missing = await writeData.execute({ name: 'stock', operations: [{ op: 'add', value: { price: 5 } }] });

        // Assert
        expect(wrongType.kind).toBe('invalid');
        const [error] = wrongType.kind === 'invalid' ? wrongType.errors : [];
        expect(error?.statePath).toMatch(/^\$\.records\.p1/);
        expect(error?.message).toContain('price');
        expect(missing.kind === 'invalid' ? missing.errors.map((found) => found.statePath ?? '') : []).toEqual([expect.stringMatching(/^\$\.records\.rid1/)]);
        expect((await parts.findByName('data', 'stock'))?.revision).toBe(1);
        expect(await records()).toEqual(STOCK.records);
    });

    it('should not check a record the write leaves alone', async () => {
        // Arrange
        await parts.write('data', 'stock', { model: 'product', records: { p1: { name: 'Lamp', price: 'old' }, p2: { name: 'Chair' } } } as never, 1);

        // Act
        const other = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p2.price', value: 50 }] });
        const all = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: '', value: { p3: { name: 'Desk', price: 'no' } } }] });

        // Assert
        expect(other).toEqual({ kind: 'written', revision: 3, added: [], created: false });
        expect(all.kind).toBe('invalid');
    });

    it('should refuse an operation that does not apply, an add without a record, and a missing dataset', async () => {
        // Act
        const results = [
            await writeData.execute({ name: 'stock', operations: [{ op: 'remove', path: 'p9' }] }),
            await writeData.execute({ name: 'stock', operations: [{ op: 'add', value: 'Lamp' }] }),
            await writeData.execute({ name: 'nothing', operations: [{ op: 'remove', path: 'p1' }] })
        ];

        // Assert
        expect(results.map((result) => result.kind)).toEqual(['invalid', 'invalid', 'not-found']);
        expect((await parts.findByName('data', 'stock'))?.revision).toBe(1);
    });

    it('should raise the revision by one with every committed write', async () => {
        // Act
        const revisions = [];
        for (const price of [31, 32, 33]) {
            const written = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p1.price', value: price }] });
            revisions.push(written.kind === 'written' ? written.revision : undefined);
        }

        // Assert
        expect([1, ...revisions]).toEqual([1, 2, 3, 4]);
    });

    it('should refuse a stale expectedRevision, but apply writes to different records without one', async () => {
        // Arrange
        await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p1.price', value: 31 }] });

        // Act
        const stale = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p2.price', value: 51 }], expectedRevision: 1 });
        const together = await Promise.all([
            writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p1.price', value: 40 }] }),
            writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p2.price', value: 60 }] })
        ]);

        // Assert
        expect(stale).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect(together.map((result) => result.kind)).toEqual(['written', 'written']);
        expect(await records()).toEqual({ p1: { name: 'Lamp', price: 40 }, p2: { name: 'Chair', price: 60 } });
        expect((await parts.findByName('data', 'stock'))?.revision).toBe(4);
    });

    it('should give up with a conflict after the attempts when another writer always wins', async () => {
        // Arrange
        const write = parts.write.bind(parts);
        let calls = 0;
        parts.write = (async () => {
            calls += 1;
            return { kind: 'conflict', currentRevision: 7 };
        }) as typeof parts.write;

        // Act
        const result = await writeData.execute({ name: 'stock', operations: [{ op: 'set', path: 'p1.price', value: 40 }] });
        parts.write = write;

        // Assert
        expect(result).toEqual({ kind: 'conflict', currentRevision: 7 });
        expect(calls).toBe(DATA_WRITE_ATTEMPTS);
    });
});

describe('QueryData', () => {
    beforeEach(async () => {
        const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`p${index + 1}`, { name: `Item ${index + 1}`, price: (index + 1) * 10 }]));
        await parts.write('data', 'stock', { model: 'product', records: twelve } as never, 1);
    });

    it('should return the window of 2 records from offset 10 and the total of 12', async () => {
        // Act
        const found = await queryData.execute({ name: 'stock', window: { first: 10, count: 5 } });

        // Assert
        expect(found).toEqual({
            kind: 'found',
            revision: 2,
            records: [
                { key: 'p11', record: { name: 'Item 11', price: 110 } },
                { key: 'p12', record: { name: 'Item 12', price: 120 } }
            ],
            first: 10,
            total: 12
        });
    });

    it('should filter and sort with the logic query language', async () => {
        // Act
        const found = await queryData.execute({ name: 'stock', filter: '$record.price > 85', sort: '-price', window: { first: 0, count: 2 } });

        // Assert
        expect(found.kind === 'found' ? found.records.map((row) => row.key) : []).toEqual(['p12', 'p11']);
        expect(found.kind === 'found' ? found.total : 0).toBe(4);
    });

    it('should refuse a filter that does not evaluate and not find a missing dataset', async () => {
        // Act
        const broken = await queryData.execute({ name: 'stock', filter: '$record.price >' });
        const missing = await queryData.execute({ name: 'nothing' });

        // Assert
        expect(broken.kind).toBe('invalid');
        expect(missing).toEqual({ kind: 'not-found' });
    });
});
