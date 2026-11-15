export { parseOptions, HELP_TEXT } from './config/options.js';
export type { CliOptions } from './config/options.js';
export { DEFAULT_STATENET_URL, DEFAULT_VIEW_URL, loadHostScript, startServer, statenetViewPage } from './config/startServer.js';
export { installShowcase, SHOWCASE_APP } from './config/showcase.js';
export { HttpError, startHttpServer } from './infrastructure/http/HttpServer.js';
export type { HttpServerOptions, HttpTenant, RunningHttpServer, TenantAnswer } from './infrastructure/http/HttpServer.js';
export { escapeHtml, PAGE_CSS } from './infrastructure/http/pages.js';
export { COMMON_HEADERS, hostPageCsp, isSameOrigin, requestHostName } from './infrastructure/http/security.js';
export { loadChunk3d, loadRuntimeBundle } from './infrastructure/http/runtimeBundle.js';
export { loadCatalogFile } from './infrastructure/stateUiLibrary.js';
export { BrowserPreview } from './infrastructure/preview/BrowserPreview.js';
export type { PreviewBrowser } from './infrastructure/preview/BrowserPreview.js';
export type { RunningServer, ServerOptions } from './config/startServer.js';
export { createServices, LOCAL_OWNER_ID } from './config/createServices.js';
export type { AppLogicLimits } from './infrastructure/sync/AppLogic.js';
export type { Services, ServicesOptions } from './config/createServices.js';
export { createStateUiMcpServer, createStateUiTools, STATEUI_MCP_SERVER_NAME } from './infrastructure/mcp/StateUiMcpServer.js';
export type { StateUiToolDependencies } from './infrastructure/mcp/StateUiMcpServer.js';
export { buildServerInstructions } from './infrastructure/mcp/instructions.js';
export type { ToolOutcome, UiToolDefinition } from './infrastructure/mcp/toolKit.js';
export { copyAppParts } from './application/copyAppParts.js';
export type { CopiedPart, CopyAppOptions, CopyAppResult } from './application/copyAppParts.js';
export { DEFAULT_PERSONA, isPersonaName } from './domain/InstanceKey.js';
export { appNamespace } from './infrastructure/sync/FileNamespaceStorage.js';
export type { RevokedApp } from './infrastructure/http/HttpServer.js';
export { StatenetViews } from './infrastructure/statenet/StatenetViews.js';
export type { StatenetViewsOptions } from './infrastructure/statenet/StatenetViews.js';
export { StatenetLink, diffState, diffWrites } from './infrastructure/statenet/StatenetLink.js';
export { DIRECTORY_NAMESPACE, OPEN_EMIT, SERVER_EMIT, VIEW_EMIT } from './domain/viewRelay.js';
export type { DirectoryEntry } from './domain/viewRelay.js';
/** The units of an app's logic in run order, each with the paths it reads and writes; for an editor that shows who uses a path */
export { logicRunOrder } from '@punyts/stateui-app/core';
export type { LogicDocument, LogicUnitPlace } from '@punyts/stateui-app/core';
/** Storage other than files (a database): the ports a workspace's storage implements and the rules it shares with the files */
export { installShowcaseInto } from './config/showcase.js';
export type { InstallShowcaseIntoOptions } from './config/showcase.js';
export type { ServicesStorage } from './config/createServices.js';
/** A server procedure Full-mode logic calls by name, and where the call comes from */
export type { AppProcedure, AppProcedureContext } from './infrastructure/sync/AppCalls.js';
/** Search the component catalog by meaning: the port a server with embeddings implements */
export type { CatalogKind, CatalogMeaning, CatalogMeanings, CatalogText } from './application/ports/CatalogMeanings.js';
export { PART_ID_PROBLEM, PART_ID_TAKEN } from './application/ports/UiPartRepository.js';
export type {
    CreateUiPartInput,
    CreateUiPartResult,
    UiPartDeleteResult,
    UiPartInvalid,
    UiPartRenameResult,
    UiPartRepository,
    UiPartRewrite,
    UiPartRewritten,
    UiPartSummary,
    UiPartWriteResult
} from './application/ports/UiPartRepository.js';
export type { InstanceDiff, InstanceRead, InstanceWriteFence, PersonaDataset, UiInstanceRepository } from './application/ports/UiInstanceRepository.js';
export type { InstancePlacement } from './application/ports/InstancePlacement.js';
export type { AddUiFileInput, AddUiFileResult, ReleaseUiFileOutcome, UiFileRepository, UiFileUsage } from './application/ports/UiFileRepository.js';
export type { SaveFileResult, UiFileStore } from './application/ports/UiFileStore.js';
export type { AppFolderStore } from './application/ports/AppFolderStore.js';
export type { UiErrorLog } from './application/ports/UiErrorLog.js';
export type { UiViewLoad } from './application/ports/UiPreviewLog.js';
export type { UiBuildError } from './domain/UiBuildError.js';
export type { UiFile } from './domain/UiFile.js';
export { MAX_BYTES_PER_APP, MAX_FILE_BYTES, MAX_FILES_PER_APP } from './domain/UiFile.js';
export { MAX_PREVIEW_ERRORS } from './domain/limits.js';
export { createUiPart, isPartBody, isPartKind, PART_BODY_PROBLEM, partInputProblem, partNameProblem, renameUiPart, reviseUiPart } from './domain/UiPart.js';
export type { UiPart, UiPartBodies } from './domain/UiPart.js';
export { PART_KINDS } from './domain/partName.js';
export type { PartKind } from './domain/partName.js';
export { isRevisionCurrent } from './domain/revision.js';
export { isAppId } from './infrastructure/storage/PartFolders.js';
export { diffInstance } from '@punyts/stateui-app/core';
/** Statenet addresses: `<ownerId>/<appId>/<scope>` */
export { appStateAddress, formatAddress, parseAddress, userStateAddress } from './domain/StateAddress.js';
export type { StateAddress, StateScope } from './domain/StateAddress.js';
