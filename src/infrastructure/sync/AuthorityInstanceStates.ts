import type { Authority } from '@punyts/state-sync/authority';
import type { InstanceShape, InstanceStates, InstanceWriteOptions } from '../../application/ports/InstanceStates.js';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { DEFAULT_PERSONA, instanceKeyText, isPersonaName } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
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
    readonly storage: InstanceNamespaceStorage;
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
 * (`DatasetHub`), which the instance's authority is attached to when it starts, writes it into the running state
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
        private readonly personaInstances?: (persona: string) => UiInstanceRepository
    ) {}

    async shape(app: UiPart<'apps'>): Promise<InstanceShape> {
        const { start } = await this.started(app);
        return { document: start.document, bindings: bindingScopes(start) };
    }

    async write(app: UiPart<'apps'>, path: string, value: JsonValue | undefined, options: InstanceWriteOptions = {}): Promise<string | undefined> {
        const running = await this.started(app);
        await this.open(running);
        const { start, storage } = running;
        return this.authorities.writeInstance(start, storage, path, value, options.logic === false ? { logic: false } : {});
    }

    async state(app: UiPart<'apps'>): Promise<JsonObject> {
        const running = await this.started(app);
        await this.open(running);
        const { start, storage } = running;
        return this.authorities.instanceState(start, storage);
    }

    /** Stops the app's instances, the other personas' too, and runs `whileStopped` before the default one may start again */
    async stop(app: UiPart<'apps'>, whileStopped: () => Promise<void>): Promise<void> {
        const key = this.key(app);
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
        if (persona !== DEFAULT_PERSONA && (this.personaInstances === undefined || !isPersonaName(persona))) throw new Error(`No persona "${persona}"`);
        return this.open(await this.started(app, persona));
    }

    /** Closes a running instance (its views reconnect) and forgets it. Under the instance's lock */
    private async forget(text: string): Promise<void> {
        const running = this.running.get(text);
        if (running === undefined) return;
        this.hub?.detach(appNamespace(running.key));
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
        const { start, storage } = running;
        const ready = this.authorities.instance(start, storage).then(async (authority) => {
            await this.hub?.attach(appNamespace(start.key), authority, start.bindings, (writes) => this.authorities.receiveInstance(start.key, authority, writes));
            this.authorities.deriveInstance(start.key);
            return authority;
        });
        running.ready = ready;
        ready.catch(() => {
            if (running.ready === ready) delete running.ready;
        });
        return ready;
    }

    private key(app: UiPart<'apps'>, persona: string = DEFAULT_PERSONA): InstanceKey {
        return { persona, ownerId: this.ownerId, appId: app.id };
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
            const started: Running = { start, storage: new InstanceNamespaceStorage(start, instances, this.report), document, key };
            this.running.set(text, started);
            return started;
        });
        // The definition the default persona runs is the one the views are sent: other personas' instances over an older one restart
        if (persona === DEFAULT_PERSONA) await this.stopOthers(app.id, (other) => other.document !== running.document);
        return running;
    }
}
