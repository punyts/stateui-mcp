import type { ComponentCatalog, UiAppRepository, UiAppValidator, UiFileRepository, UiFileStore, UiPreviewLog } from '../application/ports/index.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { CreateApp } from '../application/use-cases/CreateApp.js';
import { DeleteApp } from '../application/use-cases/DeleteApp.js';
import { GetApp } from '../application/use-cases/GetApp.js';
import { GetComponent } from '../application/use-cases/GetComponent.js';
import { GetState } from '../application/use-cases/GetState.js';
import { GetUiApp } from '../application/use-cases/GetUiApp.js';
import { ListApps } from '../application/use-cases/ListApps.js';
import { ListComponents } from '../application/use-cases/ListComponents.js';
import { ListIcons } from '../application/use-cases/ListIcons.js';
import { ListTokens } from '../application/use-cases/ListTokens.js';
import { OutlineApp } from '../application/use-cases/OutlineApp.js';
import { ReadFile } from '../application/use-cases/ReadFile.js';
import { ReadFileText } from '../application/use-cases/ReadFileText.js';
import { RecordPreviewErrors } from '../application/use-cases/RecordPreviewErrors.js';
import { RunCommand } from '../application/use-cases/RunCommand.js';
import { SetState } from '../application/use-cases/SetState.js';
import { SweepAppFiles } from '../application/use-cases/SweepAppFiles.js';
import { UploadFile } from '../application/use-cases/UploadFile.js';
import { ValidateApp } from '../application/use-cases/ValidateApp.js';
import { WriteApp } from '../application/use-cases/WriteApp.js';

/** The adapters the use cases run on */
export interface UiBuilderPorts {
    readonly repository: UiAppRepository;
    readonly validator: UiAppValidator;
    readonly previewLog: UiPreviewLog;
    readonly catalog: ComponentCatalog;
    readonly fileRepository: UiFileRepository;
    readonly fileStore: UiFileStore;
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
    readonly runCommand: RunCommand;
    readonly recordPreviewErrors: RecordPreviewErrors;
    readonly uploadFile: UploadFile;
    readonly readFile: ReadFile;
    readonly readFileText: ReadFileText;
}

/** The use cases over their ports. Plain factories, no container */
export function createUiBuilderUseCases(ports: UiBuilderPorts, options: UiBuilderOptions): UiBuilderUseCases {
    const { repository, validator, previewLog, catalog, fileRepository, fileStore } = ports;
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
        getState: new GetState(repository, previewLog, now, report),
        setState: new SetState(repository, validator, report),
        runCommand: new RunCommand(repository, catalog, previewLog, now, newId, report),
        recordPreviewErrors: new RecordPreviewErrors(previewLog, now, report),
        uploadFile: new UploadFile(fileRepository, fileStore, new SweepAppFiles(fileRepository, fileStore, now, report), newId, report),
        readFile,
        readFileText: new ReadFileText(readFile)
    };
}
