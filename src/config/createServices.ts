import { randomUUID } from 'node:crypto';
import { createAuthorityUpstream, createRelay } from '@punyts/state-sync/authority';
import type { Authority, Upstream } from '@punyts/state-sync/authority';
import type { InstancePlacement } from '../application/ports/InstancePlacement.js';
import type { CatalogMeanings } from '../application/ports/CatalogMeanings.js';
import { CORE_ICON_NAMES } from '@punyts/stateui-components';
import type { LogicFunctions } from '@punyts/stateui-app/core';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import type { CategoryIndexEntry } from '../application/ports/ComponentCatalog.js';
import type { ThemePresetSummary } from '../application/ports/PatternCatalog.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import type { UiPartRepository } from '../application/ports/UiPartRepository.js';
import type { UiPart } from '../domain/UiPart.js';
import { WriteData } from '../application/use-cases/WriteData.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';
import { createUiBuilderUseCases } from './createUiBuilder.js';
import type { UiBuilderUseCases } from './createUiBuilder.js';
import { BrowserPreview } from '../infrastructure/preview/BrowserPreview.js';
import type { PreviewBrowser } from '../infrastructure/preview/BrowserPreview.js';
import { InstanceViews } from '../infrastructure/preview/InstanceViews.js';
import { LivePreviewLog } from '../infrastructure/preview/LivePreviewLog.js';
import { LiveViews } from '../infrastructure/preview/LiveViews.js';
import { PreviewHub } from '../infrastructure/preview/PreviewHub.js';
import { FilePartRepository } from '../infrastructure/storage/FilePartRepository.js';
import { FileUiInstanceRepository } from '../infrastructure/storage/FileUiInstanceRepository.js';
import { PartFolders } from '../infrastructure/storage/PartFolders.js';
import { FileUiErrorLog } from '../infrastructure/storage/FileUiErrorLog.js';
import { FileUiFileRepository } from '../infrastructure/storage/FileUiFileRepository.js';
import { FsAppFolderStore } from '../infrastructure/storage/FsAppFolderStore.js';
import { FsUiFileStore } from '../infrastructure/storage/FsUiFileStore.js';
import { KeyedLock } from '../infrastructure/storage/KeyedLock.js';
import { DEFAULT_PERSONA } from '../domain/InstanceKey.js';
import { parseAddress } from '../domain/StateAddress.js';
import { ExternalReads } from '../infrastructure/sync/ExternalReads.js';
import { AppAuthorities } from '../infrastructure/sync/AppAuthorities.js';
import { AuthorityInstanceStates } from '../infrastructure/sync/AuthorityInstanceStates.js';
import { DatasetHub } from '../infrastructure/sync/DatasetHub.js';
import type { AppCalls, AppProcedure } from '../infrastructure/sync/AppCalls.js';
import type { AppEffects } from '../infrastructure/sync/AppEffects.js';
import type { AppLogicLimits } from '../infrastructure/sync/AppLogic.js';
import type { ToolCallLog } from '../application/ports/ToolCallLog.js';
import type { AppFolderStore } from '../application/ports/AppFolderStore.js';
import type { UiErrorLog } from '../application/ports/UiErrorLog.js';
import type { UiFileRepository } from '../application/ports/UiFileRepository.js';
import type { UiFileStore } from '../application/ports/UiFileStore.js';
import type { UiInstanceRepository } from '../application/ports/UiInstanceRepository.js';

export interface ServicesOptions {
    /** Where the parts, instances and app files live, as files; give this or `storage` */
    readonly dataDir?: string;
    /** The storage of the owner's parts, instances and files, such as a database's, in place of the files in `dataDir` */
    readonly storage?: ServicesStorage;
    readonly report: UseCaseReport;
    /**
     * The origin of the server that serves the view pages at `/apps/<id>` (`startHttpServer`). A function, because
     * the port may be chosen when the server starts. Unused with `viewPage`
     */
    readonly origin: () => string;
    /** The page of an app's live view, when it is not `<origin>/apps/<id>`: the statenet view page that Vite or a CDN serves */
    readonly viewPage?: (appId: string) => string;
    /** Replaces the Playwright browser, for tests */
    readonly browser?: PreviewBrowser;
    /** Extra arguments for the headless Chromium, for tests (none by default; ignored with `browser`) */
    readonly browserArgs?: readonly string[];
    /** The key that encrypts `$.server` at rest */
    readonly serverKey?: Uint8Array;
    /** The server procedures Full-mode logic `call`s by name; other names wait for the agent */
    readonly procedures?: Readonly<Record<string, AppProcedure>>;
    /** The compute, expression and effect functions Full-mode logic runs by name */
    readonly logicFunctions?: LogicFunctions;
    /** A file that gets one JSON line per tool call; absent: no log */
    readonly toolLog?: string;
    /** The id of the local owner, whose default persona's instances are stored under it; default `LOCAL_OWNER_ID` */
    readonly ownerId?: string;
    /** Whether logic `call`s and effects the server has no function for wait for the agent's answer; default true (`AppLogicOptions.agentAnswers`) */
    readonly agentAnswers?: boolean;
    /** Bounds on each instance's logic, for a server that runs logic other people wrote */
    readonly logicLimits?: AppLogicLimits;
    /** Ranks the library by meaning for the catalog searches the keyword index marks weak; none: keywords only */
    readonly catalogMeanings?: CatalogMeanings;
    /**
     * Where instances are ordered when several servers share the storage (`@punyts/statenet`'s owner mesh): absent, every
     * instance runs in this process
     */
    readonly placement?: InstancePlacement;
}

/** The one owner of a local server: the owner of the parts and, as the default persona, their one user */
export const LOCAL_OWNER_ID = '00000000-0000-4000-8000-000000000001';

/** Everything the transports need: the use cases, the live views and the browser */
export interface Services {
    readonly useCases: UiBuilderUseCases;
    /** The owner's parts, for a server that copies an app between owners (`copyAppParts`) */
    readonly parts: UiPartRepository;
    readonly hub: PreviewHub;
    /** The sync authority of each running instance: the views connect to it, the tools write through it */
    readonly authorities: AppAuthorities;
    /** The calls of Full-mode logic that wait for the agent's answer */
    readonly calls: AppCalls;
    /** The effects of Full-mode logic that wait for the agent's answer */
    readonly effects: AppEffects;
    readonly liveViews: LiveViews;
    /** The views of the owner's apps (parts): the assembled app and its instance's authority */
    readonly instanceViews: InstanceViews;
    /**
     * The authority of the instance at an address of this owner (`<persona>/<appId>/user`), started here: for the owner
     * node of a placement when this server takes the namespace. Undefined when it is not one of this owner's apps
     */
    hostInstance(address: string): Promise<Authority | undefined>;
    /** Stops the instance at an address here: the owner node of a placement let its namespace go */
    releaseInstance(address: string): Promise<void>;
    /** The catalog's category index, for the server instructions */
    readonly categoryIndex: readonly CategoryIndexEntry[];
    /** The library's theme preset names, for the server instructions */
    readonly presets: readonly ThemePresetSummary[];
    /** Finishes a part rename that a crash stopped halfway (`rename.pending.json`); true when there was one */
    readonly recoverParts: () => Promise<boolean>;
    readonly browser: PreviewBrowser;
    readonly report: UseCaseReport;
    readonly viewUrl: (appId: string) => string;
    /** Tells of every part change that succeeded (create, write, rename, delete); returns the function that stops it */
    readonly onPartChange: IndexedUiPartRepository['onChange'];
    /** Records every tool call, when `toolLog` is set */
    readonly toolCallLog?: ToolCallLog;
}

/**
 * Where a workspace keeps what the server stores, for a server that does not keep it in files: every adapter is the
 * owner's only, so none of them takes an owner from its caller
 */
export interface ServicesStorage {
    readonly parts: UiPartRepository;
    /** The instances and persona datasets of one persona of the owner's apps */
    instances(persona: string): UiInstanceRepository;
    readonly files: UiFileRepository;
    readonly fileStore: UiFileStore;
    readonly errorLog: UiErrorLog;
    readonly appFolders: AppFolderStore;
    /** Stores a part exactly as given (id, name, revision and dates), for importing parts made elsewhere; nothing when it is there */
    importPart?(part: UiPart): Promise<void>;
    /** Finishes what a crash left halfway; true when there was something. Storage with transactions has nothing to finish */
    recover?(): Promise<boolean>;
}

/** The files of `dataDir` as storage */
function fileStorage(dataDir: string, ownerId: string, now: () => Date): ServicesStorage & { readonly recover: () => Promise<boolean> } {
    const folders = new PartFolders(dataDir);
    const lock = new KeyedLock();
    const partFiles = new FilePartRepository(folders, lock, { now, newId: randomUUID });
    return {
        parts: partFiles,
        instances: (persona) => new FileUiInstanceRepository(folders, lock, ownerId, persona),
        files: new FileUiFileRepository(folders, lock, now),
        fileStore: new FsUiFileStore(folders),
        errorLog: new FileUiErrorLog(folders, lock),
        appFolders: new FsAppFolderStore(folders, lock),
        recover: () => partFiles.recover()
    };
}

/** The composition root of the server: plain factories, no container */
export function createServices(options: ServicesOptions): Services {
    const now = (): Date => new Date();
    const ownerId = options.ownerId ?? LOCAL_OWNER_ID;
    if (options.storage === undefined && options.dataDir === undefined) throw new Error('createServices needs a dataDir or a storage');
    const storage = options.storage ?? fileStorage(options.dataDir as string, ownerId, now);
    const instancesOf = (persona: string): UiInstanceRepository => storage.instances(persona);
    const hub = new PreviewHub(now);
    const { validator, catalog, patterns, library, toolCallLog } = createStateUiAdapters({ report: options.report, ...(options.toolLog !== undefined && { toolLog: options.toolLog }) });
    const parts = new IndexedUiPartRepository(storage.parts);
    // Instances bound to one shared dataset see each other's changes (Full mode)
    const writeData = new WriteData(parts, validator, randomUUID, options.report);
    const datasets = new DatasetHub(parts, (name, operations) => writeData.execute({ name, operations }), options.report);
    const authorities = new AppAuthorities(
        (appId, name, value, viewId) => {
            hub.recordEvent(appId, viewId, name, value);
            hub.touch(appId, viewId);
        },
        options.serverKey,
        {
            library,
            report: options.report,
            ...(options.procedures !== undefined && { procedures: options.procedures }),
            ...(options.logicFunctions !== undefined && { functions: options.logicFunctions }),
            ...(options.agentAnswers !== undefined && { agentAnswers: options.agentAnswers }),
            ...(options.logicLimits !== undefined && { limits: options.logicLimits })
        },
        datasets
    );
    const instances = instancesOf(DEFAULT_PERSONA);
    /**
     * The in-process relay (docs/design/statenet-relays.md, S3): it serves the namespaces of this workspace's running
     * instances by address, a person's state of an app at `<persona>/<appId>/user`, and caches each subscribed path
     * once for every instance that reads it (`uses.external`)
     */
    let states: AuthorityInstanceStates | undefined;
    const relay: Upstream = options.placement?.upstream ?? createRelay(
        createAuthorityUpstream(async (address) => {
            const parsed = parseAddress(address);
            if (parsed === undefined || parsed.scope !== 'user' || states === undefined) return undefined;
            const app = await parts.findById('apps', parsed.appId);
            if (app === undefined) return undefined;
            return states.authority(app, parsed.ownerId === ownerId ? DEFAULT_PERSONA : parsed.ownerId).catch(() => undefined);
        })
    );
    const external = new ExternalReads(relay, (key, authority, writes) => authorities.receiveInstance(key, authority, writes), { report: (message, fields) => options.report.info(message, fields) });
    const instanceStates = new AuthorityInstanceStates(parts, instances, authorities, ownerId, (message, fields) => options.report.info(message, fields), datasets, instancesOf, external, options.placement);
    states = instanceStates;
    const fileRepository = storage.files;
    const fileStore = storage.fileStore;
    const previewLog = new LivePreviewLog(hub, storage.errorLog, fileRepository);
    const useCases = createUiBuilderUseCases(
        { parts, instances, instanceStates, validator, previewLog, catalog, patterns, fileRepository, fileStore, appFolders: storage.appFolders, ...(options.catalogMeanings !== undefined && { meanings: options.catalogMeanings }) },
        { now, newId: randomUUID, report: options.report }
    );
    const viewPage = options.viewPage ?? ((appId: string) => `${options.origin()}/apps/${appId}`);
    const browser = options.browser ?? new BrowserPreview(hub, viewPage, options.browserArgs);
    const instanceViews = new InstanceViews(parts, parts, instanceStates, catalog, CORE_ICON_NAMES, ownerId);
    const liveViews = new LiveViews(hub, browser, instanceViews);
    // Every part change reaches the open views of the apps that show it
    parts.onChange((kind, name) => {
        liveViews.partChanged(kind, name).catch((error: unknown) => {
            options.report.info('Views not refreshed after a part change', { kind, name, reason: error instanceof Error ? error.message : String(error) });
        });
    });
    return {
        useCases,
        parts,
        hub,
        authorities,
        calls: authorities.calls,
        effects: authorities.effects,
        liveViews,
        instanceViews,
        hostInstance: (address) => instanceStates.hosted(address),
        releaseInstance: (address) => instanceStates.release(address),
        categoryIndex: catalog.categoryIndex(),
        presets: patterns.presets().map((name) => ({ name, summary: patterns.preset(name)?.summary ?? '' })),
        recoverParts: () => storage.recover?.() ?? Promise.resolve(false),
        browser,
        report: options.report,
        viewUrl: viewPage,
        onPartChange: (listener) => parts.onChange(listener),
        ...(toolCallLog !== undefined && { toolCallLog })
    };
}
