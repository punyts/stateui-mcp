import type { UiStateSnapshot } from '../../domain/UiApp.js';

/** Reads the synced state from a view that is open now (the headless page or a person's tab) */
export interface LiveStateReader {
    /** The state the open view holds, or `undefined` when no view is open, none has a state, or none answers in time */
    read(appId: string): Promise<UiStateSnapshot | undefined>;
}
