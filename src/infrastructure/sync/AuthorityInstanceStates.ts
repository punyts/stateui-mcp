import type { Access, Authority, AuthorityConnection, AuthoritySession } from '@punyts/state-sync/authority';
import type { InstancePlacement } from '../../application/ports/InstancePlacement.js';
import type { ExternalReads, ExternalUses } from './ExternalReads.js';
import type { InstanceShape, InstanceStates, InstanceWriteOptions } from '../../application/ports/InstanceStates.js';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { instanceKeyText, isPersonId, testPersonOf } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { instanceOfAddress, OWNER_IDS, userStateAddress } from '../../domain/StateAddress.js';
import type { OwnerNames } from '../../domain/StateAddress.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiPart } from '../../domain/UiPart.js';
import { KeyedLock } from '../storage/KeyedLock.js';
import type { AppAuthorities } from './AppAuthorities.js';
import type { DatasetHub } from './DatasetHub.js';
import { appNamespace, InstanceNamespaceStorage } from './FileNamespaceStorage.js';
import type { InstanceProblemReport } from './FileNamespaceStorage.js';
import { assembleInstance, bindingScopes, definitionText } from './InstanceStart.js';
import type { InstanceStart } from './InstanceStart.js';

interface Running {
    /** The newest start: the document the views are sent, with the shared records of the last assembly */
    start: InstanceStart;
    /** Its storage, made when its authority starts: saving under the epoch it was owned under then */
    storage?: InstanceNamespaceStorage;
    readonly instances: UiInstanceRepository;
    /** The definition as JSON text (`definitionText`), to see a definition change */
    readonly document: string;
    /** The authority, attached to the dataset hub; made on first use */
    ready?: Promise<Authority>;
    readonly key: InstanceKey;
}

/**
 * The running instances of the owner's apps, on `AppAuthorities`: the owner's test runs (`testPersonOf`), which the
 * tools read and write and a view reaches when it names no person, whose shared datasets are copies that a reset drops;
 * the owner's real use (whose person is the owner); and those of other people (the people an app is shared with). Only
 * views' sockets reach the last two (`authority` with a person). Each call assembles the app again; when the assembled
 * document differs from the one the instance runs (the app or a part it reaches was written), the instance's authority
 * is closed, its state saved as its instance, and started again over the new definition, so the
 * views reconnect to it. A change of only the records of a shared dataset is not a definition change: the dataset hub
 * (`DatasetHub`), which the instance's authority is attached to when it starts, writes it into the running state, a
 * test run's copy included.
 *
 * With a placement (several servers on one database), an instance runs only on the server that owns its address: the
 * tools claim it first, a view anywhere gets a session from the owner (`connect`), its saves are fenced by the owner's
 * epoch, and the owner node starts and releases it by address (`hosted`, `release`)
 */
export class AuthorityInstanceStates implements InstanceStates {
    private readonly running = new Map<string, Running>();
    private readonly lock = new KeyedLock();
    /**
     * The person of the owner's test runs (docs/design/stateui-test-runs.md): the tools' instance, and a view's when it
     * names no person. Its definition is the one the views are sent
     */
    private readonly tester: string;

    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly authorities: AppAuthorities,
        private readonly ownerId: string,
        private readonly report: InstanceProblemReport,
        private readonly hub?: DatasetHub,
        /** The instances of a person other than the owner; absent: only the owner's own instances exist */
        private readonly personInstances?: (person: string) => UiInstanceRepository,
        /** What instances read of other apps (`uses.external`), subscribed while they run */
        private readonly external?: ExternalReads,
        /** Where instances are ordered when several servers share the storage; absent: all of them here */
        private readonly placement?: InstancePlacement,
        /** The names owners go by in addresses; their ids by default */
        private readonly owners: OwnerNames = OWNER_IDS
    ) {
        this.tester = testPersonOf(ownerId);
    }

    async shape(app: UiPart<'apps'>): Promise<InstanceShape> {
        const { start } = await this.started(app);
        return { document: start.document, bindings: bindingScopes(start) };
    }

    async write(app: UiPart<'apps'>, path: string, value: JsonValue | undefined, options: InstanceWriteOptions = {}): Promise<string | undefined> {
        await this.claim(this.key(app));
        const running = await this.started(app);
        await this.open(running);
        return this.authorities.writeInstance(running.start, running.storage as InstanceNamespaceStorage, path, value, options.logic === false ? { logic: false } : {});
    }

    async state(app: UiPart<'apps'>): Promise<JsonObject> {
        await this.claim(this.key(app));
        const running = await this.started(app);
        await this.open(running);
        return this.authorities.instanceState(running.start, running.storage as InstanceNamespaceStorage);
    }

    /** Stops the app's instances, real use and other people's too, and runs `whileStopped` before the test run may start again */
    async stop(app: UiPart<'apps'>, whileStopped: () => Promise<void>): Promise<void> {
        const key = this.key(app);
        // what the owner holds would be saved over what runs while it is stopped: it is stopped here
        await this.claim(key);
        await this.stopOthers(app.id, () => true);
        const text = instanceKeyText(key);
        await this.lock.run(text, async () => {
            await this.forget(text);
            await whileStopped();
        });
    }

    /**
     * The authority of the app's running instance for a view's socket: the test run's, the owner's own, or another
     * person's (`isPersonId`). Started, or restarted over a changed definition, first
     */
    async authority(app: UiPart<'apps'>, person: string = this.tester): Promise<Authority> {
        this.checkPerson(person);
        await this.claim(this.key(app, person));
        return this.open(await this.started(app, person));
    }

    /**
     * A view's session with a person's instance of the app: with the instance here, or, with a placement, with the
     * server that owns it (here when nobody does). The session closes when the instance restarts or moves, and the
     * view connects again
     */
    async connect(app: UiPart<'apps'>, person: string, connection: AuthorityConnection, access?: Access): Promise<AuthoritySession> {
        this.checkPerson(person);
        const here = async (): Promise<Authority> => this.open(await this.started(app, person));
        if (this.placement === undefined) return (await here()).connect(connection, access);
        return this.placement.connect(this.addressOf(this.key(app, person)), this.ownerId, connection, access, here);
    }

    /**
     * The authority of the instance at an address of this owner, for the owner node when this server takes the
     * namespace: started (saving under the epoch it is owned under) when it is not running. Undefined when the address
     * is not one of this owner's apps
     */
    async hosted(address: string): Promise<Authority | undefined> {
        const found = this.instanceAt(address);
        if (found === undefined) return undefined;
        const app = await this.parts.findById('apps', found.appId);
        if (app === undefined) return undefined;
        return this.open(await this.started(app, found.person));
    }

    /**
     * Starts again over its definition every instance running here of these apps whose definition changed: for a part
     * changed by another server, where no view of this server asks for the app (its views may all be elsewhere)
     */
    async refresh(apps: readonly UiPart<'apps'>[]): Promise<void> {
        for (const app of apps) {
            const people = [...this.running.values()].filter((running) => running.key.appId === app.id).map((running) => running.key.person);
            for (const person of new Set(people)) await this.started(app, person);
        }
    }

    /** The owner node let the namespace at an address go: its instance stops here, and its views connect again */
    async release(address: string): Promise<void> {
        const found = this.instanceAt(address);
        if (found === undefined) return;
        const text = instanceKeyText(this.keyOf(found.appId, found.person));
        await this.lock.run(text, () => this.forget(text));
    }

    /** The app and person of an address of this owner (the owner's own id for the owner's own instance) */
    private instanceAt(address: string): { appId: string; person: string } | undefined {
        const found = instanceOfAddress(address, this.owners);
        if (found === undefined) return undefined;
        if (found.person !== this.ownerId && found.person !== this.tester && (this.personInstances === undefined || !isPersonId(found.person))) return undefined;
        return found;
    }

    private checkPerson(person: string): void {
        if (person !== this.ownerId && person !== this.tester && (this.personInstances === undefined || !isPersonId(person))) throw new Error(`No person "${person}"`);
    }

    private addressOf(key: InstanceKey): string {
        return userStateAddress(key.person, key.appId, this.owners);
    }

    /** With a placement, makes this server the owner of the instance's namespace, so its authority runs here */
    private async claim(key: InstanceKey): Promise<void> {
        if (this.placement === undefined) return;
        if (!(await this.placement.claim(this.addressOf(key), this.ownerId))) throw new Error("The app's instance is busy on another server; try again");
    }

    /** Closes a running instance (its views reconnect) and forgets it. Under the instance's lock */
    private async forget(text: string): Promise<void> {
        const running = this.running.get(text);
        if (running === undefined) return;
        this.hub?.detach(appNamespace(running.key));
        this.external?.detach(running.key);
        await this.authorities.forgetInstance(running.key);
        this.running.delete(text);
    }

    /**
     * Stops the app's running instances of other people that `stale` picks, each under its own lock. Their views
     * reconnect, which starts them again over the app's definition as it is then
     */
    private async stopOthers(appId: string, stale: (running: Running) => boolean): Promise<void> {
        const others = [...this.running].filter(([, running]) => running.key.appId === appId && running.key.person !== this.tester && stale(running));
        for (const [text] of others) {
            await this.lock.run(text, async () => {
                const running = this.running.get(text);
                if (running !== undefined && stale(running)) await this.forget(text);
            });
        }
    }

    /** The running instance's authority, attached to the dataset hub once */
    private open(running: Running): Promise<Authority> {
        if (running.ready !== undefined) return running.ready;
        const { start } = running;
        const epoch = this.placement?.epochOf(this.addressOf(running.key));
        if (this.placement !== undefined && epoch === undefined) return Promise.reject(new Error("The app's instance runs on another server"));
        const storage = new InstanceNamespaceStorage(start, running.instances, this.report, Date.now, epoch);
        running.storage = storage;
        const ready = this.authorities.instance(start, storage).then(async (authority) => {
            await this.hub?.attach(appNamespace(start.key), start.key.person, authority, start.bindings, (writes) => this.authorities.receiveInstance(start.key, authority, writes));
            this.authorities.deriveInstance(start.key);
            this.external?.attach(start.key, authority, (start.document as { external?: ExternalUses }).external);
            return authority;
        });
        running.ready = ready;
        ready.catch(() => {
            if (running.ready === ready) delete running.ready;
        });
        return ready;
    }

    /** The instances of a person other than the owner: the test person's too, which needs the factory */
    private instancesOf(person: string): UiInstanceRepository {
        if (this.personInstances === undefined) throw new Error(`No instances of "${person}" here`);
        return this.personInstances(person);
    }

    private key(app: UiPart<'apps'>, person: string = this.tester): InstanceKey {
        return this.keyOf(app.id, person);
    }

    private keyOf(appId: string, person: string): InstanceKey {
        return { person, ownerId: this.ownerId, appId };
    }

    private async started(app: UiPart<'apps'>, person: string = this.tester): Promise<Running> {
        const key = this.key(app, person);
        const text = instanceKeyText(key);
        const running = await this.lock.run(text, async () => {
            const start = await assembleInstance(this.parts, app, key);
            const document = definitionText(start);
            const current = this.running.get(text);
            if (current !== undefined && current.document === document) {
                current.start = start;
                return current;
            }
            if (current !== undefined) await this.forget(text);
            const instances = person === this.ownerId ? this.instances : this.instancesOf(person);
            const started: Running = { start, instances, document, key };
            this.running.set(text, started);
            return started;
        });
        // The definition the test runs run is the one the views are sent: other instances over an older one restart
        if (person === this.tester) await this.stopOthers(app.id, (other) => other.document !== running.document);
        return running;
    }
}
