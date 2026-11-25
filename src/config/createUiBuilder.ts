import { isReported, report } from '@punyts/core';
import type { CatalogMeanings } from '../application/ports/CatalogMeanings.js';
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
import { ReleaseFile } from '../application/use-cases/ReleaseFile.js';
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
import { WriteIcons } from '../application/use-cases/WriteIcons.js';
import { WriteLocale } from '../application/use-cases/WriteLocale.js';
import { WriteNodes } from '../application/use-cases/WriteNodes.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import { WritePersonData } from '../application/use-cases/WritePersonData.js';
import type { UsageSource } from '../application/UsageIndex.js';
import { msSince } from '../infrastructure/msSince.js';

/** The adapters the use cases run on */
export interface UiBuilderPorts {
    /** The owner's parts with their usage index (`IndexedUiPartRepository` over `FilePartRepository` in the server) */
    readonly parts: UiPartRepository & UsageSource;
    /**
     * The instances of the owner's test runs (docs/design/stateui-test-runs.md), which the tools reset and write person
     * records in
     */
    readonly instances: UiInstanceRepository;
    /** The owner's own instances, removed with an app as the test runs' are */
    readonly ownInstances: Pick<UiInstanceRepository, 'reset'>;
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
    /** Removes every person's stored instance of an app, with the app; none: only the owner's own is removed */
    readonly removeApp?: (appId: string) => Promise<void>;
    /** Ranks the library by meaning when a catalog search is weak; none: keywords only */
    readonly meanings?: CatalogMeanings;
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
    /** Removes a file nothing references any more (`DELETE /apps/:appId/files/:fileId`) */
    readonly releaseFile: ReleaseFile;
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
    readonly writeIcons: WriteIcons;
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
    readonly writePersonData: WritePersonData;
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
    return reportedUseCases({
        searchComponents: new SearchComponents(catalog, parts, ports.meanings),
        searchPatterns: new SearchPatterns(patterns, parts, ports.meanings),
        getComponent: new GetComponent(catalog),
        listIcons: new ListIcons(catalog, parts),
        listTokens: new ListTokens(catalog),
        recordPreviewErrors: new RecordPreviewErrors(previewLog, now, report),
        recordPreviewLoad: new RecordPreviewLoad(previewLog, report),
        uploadFile: new UploadFile(fileRepository, fileStore, new SweepAppFiles(fileRepository, fileStore, parts, instanceStates, now, report), newId, report),
        readFile,
        releaseFile: new ReleaseFile(fileRepository, fileStore, parts, instanceStates, report),
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
        writeIcons: new WriteIcons(parts, validator, report),
        listParts: new ListParts(parts, report),
        getPart: new GetPart(parts, validator, report),
        deletePart: new DeletePart(parts, parts, report, { instances: [ports.ownInstances, instances], states: instanceStates, folder: appFolders, ...(ports.removeApp !== undefined && { removeApp: ports.removeApp }) }),
        writePart,
        renamePart: new RenamePart(parts, parts, report),
        writeData: new WriteData(parts, validator, newId, report),
        queryData: new QueryData(parts, report),
        validatePartApp: new ValidatePartApp(parts, parts, validator, report),
        findPartApp: new FindPartApp(parts),
        resetInstance: new ResetInstance(parts, instances, report, instanceStates),
        writePersonData: new WritePersonData(parts, instances, validator, report, instanceStates),
        setPartState: new SetPartState(parts, instanceStates, validator, report),
        getPartState: new GetPartState(instanceStates, previewLog, now, report),
        runPartCommand: new RunPartCommand(instanceStates, runCommand),
        outlinePartApp: new OutlinePartApp(instanceStates, validator, report)
    });
}

const USE_CASE_CATEGORY = 'stateui-mcp.usecase';

interface Executable {
    execute(...args: unknown[]): unknown;
}

/** The outcome a use case's result names (its `kind`), or `done` for a result without one */
function outcomeOf(result: unknown): string {
    const kind = typeof result === 'object' && result !== null ? (result as { kind?: unknown }).kind : undefined;
    return typeof kind === 'string' ? kind : 'done';
}

/**
 * The use cases, each `execute` reported under `stateui-mcp.usecase`: the use case's name, the duration and the
 * outcome (the result's `kind`, or `failed` when it threw). Never its input or its result. A use case another one
 * calls (`writePart`) is reported there too. Off, it adds one check per run
 */
function reportedUseCases<T extends object>(useCases: T): T {
    for (const [name, useCase] of Object.entries(useCases) as [string, Executable][]) {
        const execute = useCase.execute.bind(useCase);
        useCase.execute = (...args: unknown[]): unknown => {
            if (!isReported(USE_CASE_CATEGORY)) return execute(...args);
            const start = performance.now();
            const done = (outcome: string): void => report(USE_CASE_CATEGORY, 'Use case run', { useCase: name, ms: msSince(start), outcome });
            let result: unknown;
            try {
                result = execute(...args);
            } catch (error) {
                done('failed');
                throw error;
            }
            if (!(result instanceof Promise)) {
                done(outcomeOf(result));
                return result;
            }
            return result.then(
                (value: unknown) => {
                    done(outcomeOf(value));
                    return value;
                },
                (error: unknown) => {
                    done('failed');
                    throw error;
                }
            );
        };
    }
    return useCases;
}
