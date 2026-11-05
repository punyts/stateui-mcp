import type { Authority } from '@punyts/state-sync/authority';
import type { InstanceShape, InstanceStates, InstanceWriteOptions } from '../../application/ports/InstanceStates.js';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { DEFAULT_PERSONA, instanceKeyText } from '../../domain/InstanceKey.js';
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
}

/**
 * The default persona's running instances of the owner's apps, on `AppAuthorities`. Each call assembles the app again;
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
        private readonly hub?: DatasetHub
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

    /** The authority of the app's running instance, for a view's socket; started (or restarted over a changed definition) first */
    async authority(app: UiPart<'apps'>): Promise<Authority> {
        return this.open(await this.started(app));
    }

    /** The running instance's authority, attached to the dataset hub once */
    private open(running: Running): Promise<Authority> {
        if (running.ready !== undefined) return running.ready;
        const { start, storage } = running;
        const ready = this.authorities.instance(start, storage).then(async (authority) => {
            await this.hub?.attach(appNamespace(start.key), authority, start.bindings, (writes) => this.authorities.receiveInstance(start.key, authority, writes));
            return authority;
        });
        running.ready = ready;
        ready.catch(() => {
            if (running.ready === ready) delete running.ready;
        });
        return ready;
    }

    private key(app: UiPart<'apps'>): InstanceKey {
        return { persona: DEFAULT_PERSONA, ownerId: this.ownerId, appId: app.id };
    }

    private started(app: UiPart<'apps'>): Promise<Running> {
        const key = this.key(app);
        const text = instanceKeyText(key);
        return this.lock.run(text, async () => {
            const start = await assembleInstance(this.parts, app, key);
            const document = definitionText(start);
            const current = this.running.get(text);
            if (current !== undefined && current.document === document) {
                current.start = start;
                return current;
            }
            if (current !== undefined) {
                this.hub?.detach(appNamespace(key));
                await this.authorities.forgetInstance(key);
            }
            const running: Running = { start, storage: new InstanceNamespaceStorage(start, this.instances, this.report), document };
            this.running.set(text, running);
            return running;
        });
    }
}
