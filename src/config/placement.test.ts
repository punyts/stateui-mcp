import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Access, Authority, AuthorityConnection, AuthoritySession, Upstream } from '@punyts/state-sync/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import type { InstancePlacement } from '../application/ports/InstancePlacement.js';
import type { InstanceWriteFence, PersonDataset, UiInstanceRepository } from '../application/ports/UiInstanceRepository.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import type { JsonObject } from '../domain/JsonValue.js';
import { userStateAddress } from '../domain/StateAddress.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import { AuthorityInstanceStates } from '../infrastructure/sync/AuthorityInstanceStates.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';

const OWNER = '00000000-0000-4000-8000-0000000000bb';
const { validator, library } = createStateUiAdapters();
const QUIET = Object.freeze({ info: (): void => undefined });
const APP = {
    start: 'home',
    app: { component: 'app' },
    screens: { home: { root: { component: 'form', children: { name: { component: 'textField', _label: 'Name' } } } } }
} as unknown as UiPartBodies['apps'];

/** Instances on files that record the fence of every write */
class FencedInstances extends FileUiInstanceRepository implements UiInstanceRepository {
    readonly fences: Array<InstanceWriteFence | undefined> = [];
    override async write(appId: string, definition: JsonObject, current: JsonObject, fence?: InstanceWriteFence) {
        this.fences.push(fence);
        return super.write(appId, definition, current);
    }
    override async writeData(appId: string, binding: string, dataset: PersonDataset, fence?: InstanceWriteFence) {
        this.fences.push(fence);
        return super.writeData(appId, binding, dataset);
    }
}

/** A placement where this server owns what it claims, under epoch 7, and another server owns the rest */
function placement() {
    const owned = new Map<string, number>();
    const claimed: string[] = [];
    const tunnelled: string[] = [];
    const remote: AuthorityConnection[] = [];
    const placed: InstancePlacement = {
        claim: async (address) => {
            claimed.push(address);
            owned.set(address, 7);
            return true;
        },
        epochOf: (address) => owned.get(address),
        connect: async (address: string, _workspaceId: string, connection: AuthorityConnection, access: Access | undefined, here: () => Promise<Authority>): Promise<AuthoritySession> => {
            if (owned.has(address)) return (await here()).connect(connection, access);
            tunnelled.push(address);
            remote.push(connection);
            return { receive: () => undefined, close: () => undefined };
        },
        upstream: { subscribe: () => ({ renew: () => undefined, close: () => undefined }) } as Upstream
    };
    return { placed, owned, claimed, tunnelled, remote };
}

let dir: string;
let parts: IndexedUiPartRepository;
let instances: FencedInstances;
let app: UiPart<'apps'>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stateui-placement-'));
    const folders = new PartFolders(dir);
    const lock = new KeyedLock();
    parts = new IndexedUiPartRepository(new FilePartRepository(folders, lock));
    instances = new FencedInstances(folders, lock, OWNER);
    const written = await new WritePart(parts, parts, validator, QUIET).execute({ kind: 'apps', name: 'notes', body: APP } as never);
    if (written.kind !== 'written') throw new Error(JSON.stringify(written));
    app = (await parts.findByName('apps', 'notes')) as UiPart<'apps'>;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const server = (placed: InstancePlacement) => {
    const authorities = new AppAuthorities(() => undefined, undefined, { library, report: QUIET });
    return { authorities, states: new AuthorityInstanceStates(parts, instances, authorities, OWNER, () => undefined, undefined, undefined, undefined, placed) };
};

describe('instances with a placement', () => {
    it('should claim the instance for a tool, and save it under the epoch it owns it under', async () => {
        // Arrange
        const { placed, claimed } = placement();
        const { states, authorities } = server(placed);
        const address = userStateAddress(OWNER, app.id);

        // Act
        await states.write(app, '$.app.note', 'hello');
        await authorities.close();

        // Assert
        expect(claimed).toContain(address);
        expect(instances.fences.length).toBeGreaterThan(0);
        expect(instances.fences.every((fence) => fence?.epoch === 7)).toBe(true);
    });

    it('should tunnel a view of an instance another server owns, without starting it here', async () => {
        // Arrange
        const { placed, tunnelled } = placement();
        const { states, authorities } = server(placed);

        // Act
        await states.connect(app, OWNER, { send: () => undefined, close: () => undefined });

        // Assert
        expect(tunnelled).toEqual([userStateAddress(OWNER, app.id)]);
        await expect(states.hosted(userStateAddress(OWNER, app.id))).rejects.toThrow('runs on another server');
        await authorities.close();
    });

    it('should start the instance at an address for the owner node, and stop it and close its views when the node lets it go', async () => {
        // Arrange
        const { placed, owned } = placement();
        const { states, authorities } = server(placed);
        const address = userStateAddress(OWNER, app.id);
        owned.set(address, 3);
        const hosted = await states.hosted(address);
        let closed = false;
        await states.connect(app, OWNER, { send: () => undefined, close: () => (closed = true) });

        // Act
        await states.release(address);

        // Assert
        expect(hosted?.namespace).toBeDefined();
        expect(closed).toBe(true);
        expect(await states.hosted('someone/else/app')).toBeUndefined();
        await authorities.close();
    });
});
