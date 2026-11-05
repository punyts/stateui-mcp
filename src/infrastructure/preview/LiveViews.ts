import type { UiAppResponse } from '../../application/dtos/UiAppResponse.js';
import type { GetUiApp } from '../../application/use-cases/GetUiApp.js';
import type { IssuedCommand } from '../../application/use-cases/RunCommand.js';
import type { PartKind } from '../../domain/partName.js';
import type { InstanceViews } from './InstanceViews.js';
import type { PreviewBrowser } from './BrowserPreview.js';
import type { PreviewHub, ViewMessage } from './PreviewHub.js';

/** What the views are told about an app: the app message, built from the stored app. The state reaches them by sync */
export function toAppMessage(app: UiAppResponse, reason: 'attach' | 'document'): ViewMessage {
    return { type: 'app', reason, revision: app.revision, document: app.document, icons: app.icons };
}

/**
 * Pushes document changes to the open views. The tools call it after a document write, so every view follows the agent
 * at once; state writes reach the views through the app's sync authority. With `instances`, the views of the owner's
 * apps (parts) get the assembled app, and a part change reaches every view of an app that uses the part (`partChanged`)
 */
export class LiveViews {
    constructor(
        private readonly getUiApp: GetUiApp,
        private readonly hub: PreviewHub,
        private readonly browser: Pick<PreviewBrowser, 'closePage'>,
        private readonly instances?: InstanceViews
    ) {}

    /** The app message for a view that just connected, or `undefined` when the app does not exist */
    async attachMessage(appId: string): Promise<ViewMessage | undefined> {
        const result = await this.getUiApp.execute(appId);
        if (result.kind === 'found') return toAppMessage(result.app, 'attach');
        const part = await this.instances?.find(appId);
        return part === undefined ? undefined : this.instances?.message(part, 'attach');
    }

    /**
     * After a part was created, written, renamed or deleted: sends the assembled document of every app that shows the
     * part (the app itself, or an app that reaches it) to its open views. The page loads a changed theme, locale,
     * screen or component again in full and writes a change of the shell's nodes in place. A definition change also
     * restarts the instance's authority, so the views reconnect and get its state as a snapshot. Returns how many views
     * were sent a document
     */
    async partChanged(kind: PartKind, name: string): Promise<number> {
        if (this.instances === undefined) return 0;
        let delivered = 0;
        for (const app of await this.instances.appsShowing(kind, name)) {
            if (this.hub.viewCount(app.id) === 0) continue;
            delivered += this.hub.publish(app.id, await this.instances.message(app, 'document'));
        }
        return delivered;
    }

    /** After a document write: sends the stored app to every open view */
    async documentChanged(appId: string): Promise<number> {
        if (this.hub.viewCount(appId) === 0) return 0;
        const result = await this.getUiApp.execute(appId);
        if (result.kind !== 'found') return 0;
        return this.hub.publish(appId, toAppMessage(result.app, 'document'));
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
