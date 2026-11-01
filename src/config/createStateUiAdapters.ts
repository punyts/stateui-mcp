import { CORE_ICON_NAMES } from '@punyts/stateui-components';
import type { ComponentCatalog, UiAppValidator } from '../application/ports/index.js';
import { StateUiAppValidator } from '../infrastructure/StateUiAppValidator.js';
import { StateUiComponentCatalog } from '../infrastructure/StateUiComponentCatalog.js';
import { loadCatalogFile, loadIconsFile } from '../infrastructure/stateUiLibrary.js';

/** The validator and the catalog, both over the files of `@punyts/stateui-components`, read once per process */
export interface StateUiAdapters {
    readonly validator: UiAppValidator;
    readonly catalog: ComponentCatalog;
    /** The icons the runtime page ships, so an app response leaves their path data out */
    readonly coreIconNames: readonly string[];
}

export function createStateUiAdapters(): StateUiAdapters {
    const catalogFile = loadCatalogFile();
    const catalog = new StateUiComponentCatalog(catalogFile, loadIconsFile());
    const validator = new StateUiAppValidator(catalogFile, (name) => catalog.isIconName(name));
    return { validator, catalog, coreIconNames: CORE_ICON_NAMES };
}
