import type { UiAppResponse } from '../../application/dtos/UiAppResponse.js';
import type { GetUiApp } from '../../application/use-cases/GetUiApp.js';
import type { IssuedCommand } from '../../application/use-cases/RunCommand.js';
import type { PreviewBrowser } from './BrowserPreview.js';
import type { PreviewHub, ViewMessage } from './PreviewHub.js';

/** What the views are told about an app: the app message, built from the stored app */
export function toAppMessage(app: UiAppResponse, reason: 'attach' | 'document' | 'state', statePath?: string): ViewMessage {
    return {
        type: 'app',
        reason,
        ...(statePath !== undefined && { statePath }),
        revision: app.revision,
        document: app.document,
        stateSnapshot: app.stateSnapshot,
        icons: app.icons
    };
}

/** Pushes changes to the open views. The tools call it after a write, so every view follows the agent at once */
export class LiveViews {
    constructor(
        private readonly getUiApp: GetUiApp,
        private readonly hub: PreviewHub,
        private readonly browser: Pick<PreviewBrowser, 'closePage'>
    ) {}

    /** The app message for a view that just connected, or `undefined` when the app does not exist */
    async attachMessage(appId: string): Promise<ViewMessage | undefined> {
        const result = await this.getUiApp.execute(appId);
        return result.kind === 'found' ? toAppMessage(result.app, 'attach') : undefined;
    }

    /** After a document write (`document`) or a state write (`state`, with the path it wrote): sends the stored app to every open view */
    async appChanged(appId: string, reason: 'document' | 'state', statePath?: string): Promise<number> {
        if (this.hub.viewCount(appId) === 0) return 0;
        const result = await this.getUiApp.execute(appId);
        if (result.kind !== 'found') return 0;
        return this.hub.publish(appId, toAppMessage(result.app, reason, statePath));
    }

    /** Delivers a command to every open view, the headless page included, and returns how many views were open */
    command(appId: string, command: IssuedCommand): number {
        return this.hub.publish(appId, {
            type: 'command',
            id: command.id,
            target: command.target,
            command: command.command,
            ...(command.value !== undefined && { value: command.value }),
            expiresAt: command.expiresAt
        });
    }

    async deleted(appId: string): Promise<void> {
        this.hub.forget(appId);
        await this.browser.closePage(appId);
    }
}
