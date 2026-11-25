import { testPersonOf } from '../../domain/InstanceKey.js';
import type { Authority, AuthorityConnection, AuthoritySession } from '@punyts/state-sync/authority';
import { appIconNames } from '@punyts/stateui-app/core';
import type { ComponentCatalog } from '../../application/ports/ComponentCatalog.js';
import type { UiPartRepository, UiPartSummary } from '../../application/ports/UiPartRepository.js';
import type { UsageSource } from '../../application/UsageIndex.js';
import { collectIconNames } from '../../application/collectIconNames.js';
import type { PartKind } from '../../domain/partName.js';
import type { UiPart } from '../../domain/UiPart.js';
import type { AuthorityInstanceStates } from '../sync/AuthorityInstanceStates.js';
import { appNamespace } from '../sync/FileNamespaceStorage.js';
import type { ViewMessage } from './PreviewHub.js';

/** The app message of a view */
export type AppViewMessage = Extract<ViewMessage, { type: 'app' }>;

/**
 * The live views of the owner's apps (parts): what a view of an app part is sent and which authority its socket
 * talks to. A view shows the assembled app (`assembleApp`: the app node, the screens, the themes, the bound data and
 * modules) with the owner's own instance laid over it, and syncs with that instance's authority.
 *
 * The document of a view is not one part, so its revision is counted here: it rises by one each time the assembled
 * document of the app differs from the one sent before (the app or a part it reaches was written). The count starts at
 * 1 when the server starts, as the views reconnect then
 */
export class InstanceViews {
    private readonly revisions = new Map<string, { readonly text: string; readonly revision: number }>();

    constructor(
        private readonly parts: Pick<UiPartRepository, 'findById' | 'findByName' | 'list'>,
        private readonly usage: UsageSource,
        private readonly states: Pick<AuthorityInstanceStates, 'shape' | 'authority' | 'connect'>,
        private readonly catalog: ComponentCatalog,
        private readonly coreIconNames: readonly string[],
        private readonly ownerId: string,
        /** The owner as their state's addresses and `/paths` name them (`OwnerNames.of`): a number in a statenet that issues them */
        readonly owner: string = ownerId
    ) {}

    /** The owner's app parts, for the list of apps */
    list(): Promise<readonly UiPartSummary[]> {
        return this.parts.list('apps');
    }

    /** The app part with this id, or undefined */
    find(appId: string): Promise<UiPart<'apps'> | undefined> {
        return this.parts.findById('apps', appId);
    }

    /**
     * The sync namespace of a person's instance of the app, which the page's sync client names: the owner's test runs'
     * unless a person is named (docs/design/stateui-test-runs.md)
     */
    namespace(app: UiPart<'apps'>, person: string = testPersonOf(this.ownerId)): string {
        return appNamespace({ person, ownerId: this.ownerId, appId: app.id });
    }

    /**
     * The assembled app as a view message, with the path data of the icons it uses beyond the core set. A name is the
     * app's own icon first: those ride in the document's `icons`, so only the other names are looked up in the icon set
     */
    async message(app: UiPart<'apps'>, reason: AppViewMessage['reason']): Promise<AppViewMessage> {
        const { document } = await this.states.shape(app);
        const core = new Set(this.coreIconNames);
        const own = appIconNames(document['icons']);
        const wanted = [...collectIconNames(document, this.catalog)].filter((name) => !own.has(name) && !core.has(name)).sort();
        return { type: 'app', reason, revision: this.revisionOf(app.id, JSON.stringify(document)), document, icons: { ...this.catalog.iconPaths(wanted) } };
    }

    /**
     * What a run-time tool waits for and checks: the revision of the view message the app's assembled document
     * makes now (the one the views are sent next, or were sent last), and its screens
     */
    async view(app: UiPart<'apps'>): Promise<{ readonly revision: number; readonly screens: readonly string[] }> {
        const { document } = await this.states.shape(app);
        const screens = document['screens'];
        return {
            revision: this.revisionOf(app.id, JSON.stringify(document)),
            screens: screens !== null && typeof screens === 'object' && !Array.isArray(screens) ? Object.keys(screens) : []
        };
    }

    /** The revision of the last message made for the app; undefined before the first */
    revision(appId: string): number | undefined {
        return this.revisions.get(appId)?.revision;
    }

    /**
     * The authority of a person's instance of the app (the owner's test runs' unless a person is named); a changed
     * definition restarts it, which closes the views' sockets
     */
    authority(app: UiPart<'apps'>, person: string = testPersonOf(this.ownerId)): Promise<Authority> {
        return this.states.authority(app, person);
    }

    /**
     * A view's session with a person's instance of the app, wherever the instance runs (another server's, with a
     * placement), the owner's test runs' when no person is named; it closes when the instance restarts or moves, and
     * the view connects again
     */
    connect(app: UiPart<'apps'>, person: string | undefined, connection: AuthorityConnection): Promise<AuthoritySession> {
        return this.states.connect(app, person ?? testPersonOf(this.ownerId), connection);
    }

    /** The app parts that show a change of this part: the app itself, and every app that reaches the part */
    async appsShowing(kind: PartKind, name: string): Promise<UiPart<'apps'>[]> {
        const names = new Set<string>(kind === 'apps' ? [name] : []);
        for (const app of (await this.usage.usage()).appsUsing(kind, name)) names.add(app);
        const apps: UiPart<'apps'>[] = [];
        for (const app of names) {
            const part = await this.parts.findByName('apps', app);
            if (part !== undefined) apps.push(part);
        }
        return apps;
    }

    private revisionOf(appId: string, text: string): number {
        const last = this.revisions.get(appId);
        if (last !== undefined && last.text === text) return last.revision;
        const revision = (last?.revision ?? 0) + 1;
        this.revisions.set(appId, { text, revision });
        return revision;
    }
}
