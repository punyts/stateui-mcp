import type {
    ComponentCatalog,
    InstanceStates,
    LiveStateReader,
    UiAppRepository,
    UiAppValidator,
    UiFileRepository,
    UiFileStore,
    UiInstanceRepository,
    UiPartRepository,
    UiPreviewLog
} from '../application/ports/index.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { CreateApp } from '../application/use-cases/CreateApp.js';
import { DeleteApp } from '../application/use-cases/DeleteApp.js';
import { DeletePart } from '../application/use-cases/DeletePart.js';
import { GetApp } from '../application/use-cases/GetApp.js';
import { GetComponent } from '../application/use-cases/GetComponent.js';
import { GetPart } from '../application/use-cases/GetPart.js';
import { GetState } from '../application/use-cases/GetState.js';
import { GetUiApp } from '../application/use-cases/GetUiApp.js';
import { ListApps } from '../application/use-cases/ListApps.js';
import { ListComponents } from '../application/use-cases/ListComponents.js';
import { ListParts } from '../application/use-cases/ListParts.js';
import { ListIcons } from '../application/use-cases/ListIcons.js';
import { ListTokens } from '../application/use-cases/ListTokens.js';
import { OutlineApp } from '../application/use-cases/OutlineApp.js';
import { ReadFile } from '../application/use-cases/ReadFile.js';
import { ReadFileText } from '../application/use-cases/ReadFileText.js';
import { RecordPreviewErrors } from '../application/use-cases/RecordPreviewErrors.js';
import { RecordPreviewLoad } from '../application/use-cases/RecordPreviewLoad.js';
import { RunCommand } from '../application/use-cases/RunCommand.js';
import { SetPartState, SetState } from '../application/use-cases/SetState.js';
import { ResetInstance, ResetState } from '../application/use-cases/ResetState.js';
import { SweepAppFiles } from '../application/use-cases/SweepAppFiles.js';
import { UploadFile } from '../application/use-cases/UploadFile.js';
import { ValidateApp, ValidatePartApp } from '../application/use-cases/ValidateApp.js';
import { WriteApp } from '../application/use-cases/WriteApp.js';
import { QueryData } from '../application/use-cases/QueryData.js';
import { RenamePart } from '../application/use-cases/RenamePart.js';
import { WriteData } from '../application/use-cases/WriteData.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import { WritePersonaData } from '../application/use-cases/WritePersonaData.js';
import type { UsageSource } from '../application/UsageIndex.js';

/** The adapters the use cases run on */
export interface UiBuilderPorts {
    /** The old one-document-per-app store, which the current tools use until epic 3 removes them */
    readonly repository: UiAppRepository;
    /**
     * The owner's parts with their usage index, beside the app store (`IndexedUiPartRepository` over
     * `FilePartRepository` in the server). With it, `writePart` and `validatePartApp` exist; no tool calls them yet
     */
    readonly parts?: UiPartRepository & UsageSource;
    /** The default persona's instances of owner apps (`FileUiInstanceRepository`); with `parts`, `resetInstance` and `writePersonaData` exist */
    readonly instances?: UiInstanceRepository;
    /** The running instances of owner apps (`AuthorityInstanceStates`); with `parts`, `setPartState` exists */
    readonly instanceStates?: InstanceStates;
    readonly validator: UiAppValidator;
    readonly previewLog: UiPreviewLog;
    readonly catalog: ComponentCatalog;
    readonly fileRepository: UiFileRepository;
    readonly fileStore: UiFileStore;
    readonly liveState: LiveStateReader;
}

/** What the use cases need besides ports: the clock, ids, the reporter and the library's core icons */
export interface UiBuilderOptions {
    readonly now: () => Date;
    readonly newId: () => string;
    readonly report: UseCaseReport;
    /** Icons the runtime page ships; the app message leaves their path data out */
    readonly coreIconNames: readonly string[];
}

export interface UiBuilderUseCases {
    readonly createApp: CreateApp;
    readonly listApps: ListApps;
    readonly deleteApp: DeleteApp;
    readonly listComponents: ListComponents;
    readonly getComponent: GetComponent;
    readonly listIcons: ListIcons;
    readonly listTokens: ListTokens;
    readonly writeApp: WriteApp;
    readonly getApp: GetApp;
    readonly getUiApp: GetUiApp;
    readonly outlineApp: OutlineApp;
    readonly validateApp: ValidateApp;
    readonly getState: GetState;
    readonly setState: SetState;
    readonly resetState: ResetState;
    readonly runCommand: RunCommand;
    readonly recordPreviewErrors: RecordPreviewErrors;
    readonly recordPreviewLoad: RecordPreviewLoad;
    readonly uploadFile: UploadFile;
    readonly readFile: ReadFile;
    readonly readFileText: ReadFileText;
    /** With `parts` only */
    readonly listParts?: ListParts;
    /** With `parts` only */
    readonly getPart?: GetPart;
    /** With `parts` only; with `instances` too, deleting an app removes its instance */
    readonly deletePart?: DeletePart;
    /** With `parts` only */
    readonly writePart?: WritePart;
    /** With `parts` only */
    readonly renamePart?: RenamePart;
    /** With `parts` only */
    readonly writeData?: WriteData;
    /** With `parts` only */
    readonly queryData?: QueryData;
    /** With `parts` only */
    readonly validatePartApp?: ValidatePartApp;
    /** With `parts` and `instances` only */
    readonly resetInstance?: ResetInstance;
    /** With `parts` and `instances` only */
    readonly writePersonaData?: WritePersonaData;
    /** With `parts` and `instanceStates` only */
    readonly setPartState?: SetPartState;
}

/** The use cases over their ports. Plain factories, no container */
export function createUiBuilderUseCases(ports: UiBuilderPorts, options: UiBuilderOptions): UiBuilderUseCases {
    const { repository, parts, instances, instanceStates, validator, previewLog, catalog, fileRepository, fileStore, liveState } = ports;
    const { now, newId, report, coreIconNames } = options;
    const readFile = new ReadFile(fileRepository, fileStore, report);
    return {
        createApp: new CreateApp(repository, validator, report),
        listApps: new ListApps(repository, report),
        deleteApp: new DeleteApp(repository, report),
        listComponents: new ListComponents(catalog),
        getComponent: new GetComponent(catalog),
        listIcons: new ListIcons(catalog),
        listTokens: new ListTokens(catalog),
        writeApp: new WriteApp(repository, validator, report),
        getApp: new GetApp(repository, validator, report),
        getUiApp: new GetUiApp(repository, catalog, previewLog, coreIconNames, now, report),
        outlineApp: new OutlineApp(repository, validator, report),
        validateApp: new ValidateApp(repository, validator, previewLog, now, report),
        getState: new GetState(repository, previewLog, liveState, now, report),
        setState: new SetState(repository, validator, report),
        resetState: new ResetState(repository, report),
        runCommand: new RunCommand(repository, catalog, previewLog, now, newId, report),
        recordPreviewErrors: new RecordPreviewErrors(previewLog, now, report),
        recordPreviewLoad: new RecordPreviewLoad(previewLog, report),
        uploadFile: new UploadFile(fileRepository, fileStore, new SweepAppFiles(fileRepository, fileStore, repository, now, report), newId, report),
        readFile,
        readFileText: new ReadFileText(readFile),
        ...(parts !== undefined && {
            listParts: new ListParts(parts, report),
            getPart: new GetPart(parts, validator, report),
            deletePart: new DeletePart(parts, parts, report, instances),
            writePart: new WritePart(parts, parts, validator, report),
            renamePart: new RenamePart(parts, parts, report),
            writeData: new WriteData(parts, validator, newId, report),
            queryData: new QueryData(parts, report),
            validatePartApp: new ValidatePartApp(parts, parts, validator, report)
        }),
        ...(parts !== undefined &&
            instances !== undefined && {
                resetInstance: new ResetInstance(parts, instances, report),
                writePersonaData: new WritePersonaData(parts, instances, validator, report)
            }),
        ...(parts !== undefined && instanceStates !== undefined && { setPartState: new SetPartState(parts, instanceStates, validator, report) })
    };
}
