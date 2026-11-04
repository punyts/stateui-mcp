import type { LiveStateReader } from '../../application/ports/LiveStateReader.js';
import type { UiStateSnapshot } from '../../domain/UiApp.js';
import type { PreviewHub } from './PreviewHub.js';

/** How long a view has to answer before the stored state is used instead */
export const LIVE_STATE_TIMEOUT_MS = 2_000;

/** Reads the state from the open views through the hub: each view answers with the state it holds */
export class HubLiveState implements LiveStateReader {
    constructor(
        private readonly hub: Pick<PreviewHub, 'requestState'>,
        private readonly timeoutMs: number = LIVE_STATE_TIMEOUT_MS
    ) {}

    read(appId: string): Promise<UiStateSnapshot | undefined> {
        return this.hub.requestState(appId, this.timeoutMs);
    }
}
