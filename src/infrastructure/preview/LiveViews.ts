import type { IssuedCommand } from '../../application/use-cases/RunCommand.js';
import type { PartKind } from '../../domain/partName.js';
import type { InstanceViews } from './InstanceViews.js';
import type { PreviewBrowser } from './BrowserPreview.js';
import type { PreviewHub, ViewMessage } from './PreviewHub.js';

/**
 * Pushes part changes to the open views: the views of the owner's apps (parts) get the assembled app, and a part change
 * reaches every view of an app that uses the part (`partChanged`). State writes reach the views through the instance's
 * sync authority
 */
export class LiveViews {
    constructor(
        private readonly hub: PreviewHub,
        private readonly browser: Pick<PreviewBrowser, 'closePage'>,
        private readonly instances: InstanceViews
    ) {}

    /** The app message for a view that just connected, or `undefined` when the app part does not exist */
    async attachMessage(appId: string): Promise<ViewMessage | undefined> {
        const part = await this.instances.find(appId);
        return part === undefined ? undefined : this.instances.message(part, 'attach');
    }

    /**
     * After a part was created, written, renamed or deleted: sends the assembled document of every app that shows the
     * part (the app itself, or an app that reaches it) to its open views. The page loads a changed theme, locale,
     * screen or component again in full and writes a change of the app node in place. A definition change also
     * restarts the instance's authority, so the views reconnect and get its state as a snapshot. Returns how many views
     * were sent a document
     */
    async partChanged(kind: PartKind, name: string): Promise<number> {
        let delivered = 0;
        for (const app of await this.instances.appsShowing(kind, name)) {
            if (this.hub.viewCount(app.id) === 0) continue;
            delivered += this.hub.publish(app.id, await this.instances.message(app, 'document'));
        }
        return delivered;
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
