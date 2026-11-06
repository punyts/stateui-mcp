import type {
    ComponentCatalog,
    InstanceStates,
    PatternCatalog,
    AppFolderStore,
    UiAppValidator,
    UiFileRepository,
    UiFileStore,
    UiInstanceRepository,
    UiPartRepository,
    UiPreviewLog
} from '../application/ports/index.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { OutlinePartApp } from '../application/use-cases/OutlinePartApp.js';
import { ConfigureApp } from '../application/use-cases/ConfigureApp.js';
import { CreatePartApp } from '../application/use-cases/CreateApp.js';
import { CreateScreen } from '../application/use-cases/CreateScreen.js';
import { DeletePart } from '../application/use-cases/DeletePart.js';
import { GetComponent } from '../application/use-cases/GetComponent.js';
import { GetPart } from '../application/use-cases/GetPart.js';
import { SearchComponents } from '../application/use-cases/SearchComponents.js';
import { SearchPatterns } from '../application/use-cases/SearchPatterns.js';
import { ListParts } from '../application/use-cases/ListParts.js';
import { ListIcons } from '../application/use-cases/ListIcons.js';
import { ListTokens } from '../application/use-cases/ListTokens.js';
import { ReadFile } from '../application/use-cases/ReadFile.js';
import { ReadFileText } from '../application/use-cases/ReadFileText.js';
import { RecordPreviewErrors } from '../application/use-cases/RecordPreviewErrors.js';
import { RecordPreviewLoad } from '../application/use-cases/RecordPreviewLoad.js';
import { RunCommand } from '../application/use-cases/RunCommand.js';
import { SetPartState } from '../application/use-cases/SetState.js';
import { ResetInstance } from '../application/use-cases/ResetState.js';
import { FindPartApp, GetPartState, RunPartCommand } from '../application/use-cases/RunPartApp.js';
import { WriteModel } from '../application/use-cases/WriteModel.js';
import { WriteLogic } from '../application/use-cases/WriteLogic.js';
import { WriteComposed } from '../application/use-cases/WriteComposed.js';
import { WritePattern } from '../application/use-cases/WritePattern.js';
import { SweepAppFiles } from '../application/use-cases/SweepAppFiles.js';
import { UploadFile } from '../application/use-cases/UploadFile.js';
import { ValidatePartApp } from '../application/use-cases/ValidateApp.js';
import { QueryData } from '../application/use-cases/QueryData.js';
import { RenamePart } from '../application/use-cases/RenamePart.js';
import { WriteData } from '../application/use-cases/WriteData.js';
import { CreateTheme, WriteTheme } from '../application/use-cases/WriteTheme.js';
import { WriteLocale } from '../application/use-cases/WriteLocale.js';
import { WriteNodes } from '../application/use-cases/WriteNodes.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import { WritePersonaData } from '../application/use-cases/WritePersonaData.js';
import type { UsageSource } from '../application/UsageIndex.js';

/** The adapters the use cases run on */
export interface UiBuilderPorts {
    /** The owner's parts with their usage index (`IndexedUiPartRepository` over `FilePartRepository` in the server) */
    readonly parts: UiPartRepository & UsageSource;
    /** The default persona's instances of owner apps (`FileUiInstanceRepository`) */
    readonly instances: UiInstanceRepository;
    /** The running instances of owner apps (`AuthorityInstanceStates`) */
    readonly instanceStates: InstanceStates;
    readonly validator: UiAppValidator;
    readonly previewLog: UiPreviewLog;
    readonly catalog: ComponentCatalog;
    /** The library's patterns, which `ui_app_create` and `ui_screen_create` may start from */
    readonly patterns: PatternCatalog;
    readonly fileRepository: UiFileRepository;
    readonly fileStore: UiFileStore;
    /** The side folders of app parts, removed with the app */
    readonly appFolders: AppFolderStore;
}

/** What the use cases need besides ports: the clock, ids and the reporter */
export interface UiBuilderOptions {
    readonly now: () => Date;
    readonly newId: () => string;
    readonly report: UseCaseReport;
}

export interface UiBuilderUseCases {
    readonly searchComponents: SearchComponents;
    readonly searchPatterns: SearchPatterns;
    readonly getComponent: GetComponent;
    readonly listIcons: ListIcons;
    readonly listTokens: ListTokens;
    readonly recordPreviewErrors: RecordPreviewErrors;
    readonly recordPreviewLoad: RecordPreviewLoad;
    readonly uploadFile: UploadFile;
    readonly readFile: ReadFile;
    readonly readFileText: ReadFileText;
    readonly createPartApp: CreatePartApp;
    readonly configureApp: ConfigureApp;
    readonly createScreen: CreateScreen;
    readonly createTheme: CreateTheme;
    readonly writeTheme: WriteTheme;
    readonly writeModel: WriteModel;
    readonly writeLogic: WriteLogic;
    readonly writeComposed: WriteComposed;
    readonly writePattern: WritePattern;
    readonly writeNodes: WriteNodes;
    readonly writeLocale: WriteLocale;
    readonly listParts: ListParts;
    readonly getPart: GetPart;
    /** Deleting an app removes its instance */
    readonly deletePart: DeletePart;
    readonly writePart: WritePart;
    readonly renamePart: RenamePart;
    readonly writeData: WriteData;
    readonly queryData: QueryData;
    readonly validatePartApp: ValidatePartApp;
    readonly resetInstance: ResetInstance;
    readonly writePersonaData: WritePersonaData;
    readonly setPartState: SetPartState;
    /** The app part a run-time tool names */
    readonly findPartApp: FindPartApp;
    readonly getPartState: GetPartState;
    readonly runPartCommand: RunPartCommand;
    readonly outlinePartApp: OutlinePartApp;
}

/** The use cases over their ports. Plain factories, no container */
export function createUiBuilderUseCases(ports: UiBuilderPorts, options: UiBuilderOptions): UiBuilderUseCases {
    const { parts, instances, instanceStates, validator, previewLog, catalog, patterns, fileRepository, fileStore, appFolders } = ports;
    const { now, newId, report } = options;
    const readFile = new ReadFile(fileRepository, fileStore, report);
    const runCommand = new RunCommand(catalog, previewLog, now, newId, report);
    const writePart = new WritePart(parts, parts, validator, report);
    return {
        searchComponents: new SearchComponents(catalog, parts),
        searchPatterns: new SearchPatterns(patterns, parts),
        getComponent: new GetComponent(catalog),
        listIcons: new ListIcons(catalog),
        listTokens: new ListTokens(catalog),
        recordPreviewErrors: new RecordPreviewErrors(previewLog, now, report),
        recordPreviewLoad: new RecordPreviewLoad(previewLog, report),
        uploadFile: new UploadFile(fileRepository, fileStore, new SweepAppFiles(fileRepository, fileStore, parts, instanceStates, now, report), newId, report),
        readFile,
        readFileText: new ReadFileText(readFile),
        createTheme: new CreateTheme(parts, writePart, validator, patterns, report),
        writeTheme: new WriteTheme(parts, writePart, validator, catalog, report),
        writeModel: new WriteModel(parts, parts, writePart, report),
        writeLogic: new WriteLogic(parts, validator, writePart, report),
        writeComposed: new WriteComposed(parts, writePart, catalog, report),
        writePattern: new WritePattern(parts, writePart, patterns, report),
        createPartApp: new CreatePartApp(parts, validator, patterns, report),
        configureApp: new ConfigureApp(parts, validator, report),
        createScreen: new CreateScreen(parts, validator, patterns, report),
        writeNodes: new WriteNodes(parts, validator, report),
        writeLocale: new WriteLocale(parts, validator, report),
        listParts: new ListParts(parts, report),
        getPart: new GetPart(parts, validator, report),
        deletePart: new DeletePart(parts, parts, report, { instances, states: instanceStates, folder: appFolders }),
        writePart,
        renamePart: new RenamePart(parts, parts, report),
        writeData: new WriteData(parts, validator, newId, report),
        queryData: new QueryData(parts, report),
        validatePartApp: new ValidatePartApp(parts, parts, validator, report),
        findPartApp: new FindPartApp(parts),
        resetInstance: new ResetInstance(parts, instances, report, instanceStates),
        writePersonaData: new WritePersonaData(parts, instances, validator, report),
        setPartState: new SetPartState(parts, instanceStates, validator, report),
        getPartState: new GetPartState(instanceStates, previewLog, now, report),
        runPartCommand: new RunPartCommand(instanceStates, runCommand),
        outlinePartApp: new OutlinePartApp(instanceStates, validator, report)
    };
}
