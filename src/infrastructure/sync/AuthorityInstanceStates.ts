import type { Access, Authority, AuthorityConnection, AuthoritySession } from '@punyts/state-sync/authority';
import type { InstancePlacement } from '../../application/ports/InstancePlacement.js';
import type { ExternalReads, ExternalUses } from './ExternalReads.js';
import type { InstanceShape, InstanceStates, InstanceWriteOptions } from '../../application/ports/InstanceStates.js';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { DEFAULT_PERSONA, instanceKeyText, isPersonaName } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { userStateAddress } from '../../domain/StateAddress.js';
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
 * The running instances of the owner's apps, on `AppAuthorities`: the default persona's, which the tools read and
 * write, and those of other personas (the people an app is shared with), which only views' sockets reach (`authority`
 * with a persona). Each call assembles the app again;
 * when the assembled document differs from the one the instance runs (the app or a part it reaches was written), the
 * instance's authority is closed, its state saved as its instance, and started again over the new definition, so the
 * views reconnect to it. A change of only the records of a shared dataset is not a definition change: the dataset hub
 * (`DatasetHub`), which the instance's authority is attached to when it starts, writes it into the running state.
 *
 * With a placement (several servers on one database), an instance runs only on the server that owns its address: the
 * tools claim it first, a view anywhere gets a session from the owner (`connect`), its saves are fenced by the owner's
 * epoch, and the owner node starts and releases it by address (`hosted`, `release`)
 */
export class AuthorityInstanceStates implements InstanceStates {
    private readonly running = new Map<string, Running>();
    private readonly lock = new KeyedLock();

    constructor(
        private readonly parts: UiPartRepository,
        private readonly instances: UiInstanceRepository,
        private readonly authorities: AppAuthorities,
        private readonly ownerId: string,
        private readonly report: InstanceProblemReport,
        private readonly hub?: DatasetHub,
        /** The instances of a persona other than the default one; absent: only the default persona exists */
        private readonly personaInstances?: (persona: string) => UiInstanceRepository,
        /** What instances read of other apps (`uses.external`), subscribed while they run */
        private readonly external?: ExternalReads,
        /** Where instances are ordered when several servers share the storage; absent: all of them here */
        private readonly placement?: InstancePlacement
    ) {}

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

    /** Stops the app's instances, the other personas' too, and runs `whileStopped` before the default one may start again */
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
     * The authority of the app's running instance for a view's socket: the default persona's, or another persona's
     * (`isPersonaName`). Started, or restarted over a changed definition, first
     */
    async authority(app: UiPart<'apps'>, persona: string = DEFAULT_PERSONA): Promise<Authority> {
        this.checkPersona(persona);
        await this.claim(this.key(app, persona));
        return this.open(await this.started(app, persona));
    }

    /**
     * A view's session with a persona's instance of the app: with the instance here, or, with a placement, with the
     * server that owns it (here when nobody does). The session closes when the instance restarts or moves, and the
     * view connects again
     */
    async connect(app: UiPart<'apps'>, persona: string, connection: AuthorityConnection, access?: Access): Promise<AuthoritySession> {
        this.checkPersona(persona);
        const here = async (): Promise<Authority> => this.open(await this.started(app, persona));
        if (this.placement === undefined) return (await here()).connect(connection, access);
        return this.placement.connect(this.addressOf(this.key(app, persona)), this.ownerId, connection, access, here);
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
        return this.open(await this.started(app, found.persona));
    }

    /**
     * Starts again over its definition every instance running here of these apps whose definition changed: for a part
     * changed by another server, where no view of this server asks for the app (its views may all be elsewhere)
     */
    async refresh(apps: readonly UiPart<'apps'>[]): Promise<void> {
        for (const app of apps) {
            const personas = [...this.running.values()].filter((running) => running.key.appId === app.id).map((running) => running.key.persona);
            for (const persona of new Set(personas)) await this.started(app, persona);
        }
    }

    /** The owner node let the namespace at an address go: its instance stops here, and its views connect again */
    async release(address: string): Promise<void> {
        const found = this.instanceAt(address);
        if (found === undefined) return;
        const text = instanceKeyText(this.keyOf(found.appId, found.persona));
        await this.lock.run(text, () => this.forget(text));
    }

    /** The app and persona of an address of this owner (the owner's own id is its default persona) */
    private instanceAt(address: string): { appId: string; persona: string } | undefined {
        const [ownerId, appId, scope] = address.split('/');
        if (ownerId === undefined || appId === undefined || scope !== 'user') return undefined;
        const persona = ownerId === this.ownerId ? DEFAULT_PERSONA : ownerId;
        if (persona !== DEFAULT_PERSONA && (this.personaInstances === undefined || !isPersonaName(persona))) return undefined;
        return { appId: appId.toLowerCase(), persona };
    }

    private checkPersona(persona: string): void {
        if (persona !== DEFAULT_PERSONA && (this.personaInstances === undefined || !isPersonaName(persona))) throw new Error(`No persona "${persona}"`);
    }

    private addressOf(key: InstanceKey): string {
        return userStateAddress(key.ownerId, key.persona, key.appId);
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
     * Stops the app's running instances of other personas that `stale` picks, each under its own lock. Their views
     * reconnect, which starts them again over the app's definition as it is then
     */
    private async stopOthers(appId: string, stale: (running: Running) => boolean): Promise<void> {
        const others = [...this.running].filter(([, running]) => running.key.appId === appId && running.key.persona !== DEFAULT_PERSONA && stale(running));
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
            await this.hub?.attach(appNamespace(start.key), authority, start.bindings, (writes) => this.authorities.receiveInstance(start.key, authority, writes));
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

    private key(app: UiPart<'apps'>, persona: string = DEFAULT_PERSONA): InstanceKey {
        return this.keyOf(app.id, persona);
    }

    private keyOf(appId: string, persona: string): InstanceKey {
        return { persona, ownerId: this.ownerId, appId };
    }

    private async started(app: UiPart<'apps'>, persona: string = DEFAULT_PERSONA): Promise<Running> {
        const key = this.key(app, persona);
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
            const instances = persona === DEFAULT_PERSONA ? this.instances : (this.personaInstances as (persona: string) => UiInstanceRepository)(persona);
            const started: Running = { start, instances, document, key };
            this.running.set(text, started);
            return started;
        });
        // The definition the default persona runs is the one the views are sent: other personas' instances over an older one restart
        if (persona === DEFAULT_PERSONA) await this.stopOthers(app.id, (other) => other.document !== running.document);
        return running;
    }
}
