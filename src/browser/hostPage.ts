/**
 * The host script of an app page that its own server serves (`startHttpServer`, `GET /apps/:appId`, as
 * `/assets/host.js`): the live view with the direct channel to that server (`viewChannel.ts`)
 */

import { installHostApi, LiveView } from './host.js';
import { directChannel } from './viewChannel.js';

// A page with no app of its own (no `data-app-id`) only mounts panels the page drives (`stateuiHost.mount`)
if (document.body.dataset['appId']) {
    const live = new LiveView(document.body);
    installHostApi(live);
    live.start((view) => directChannel(view.appId, view.viewId, view.viewKind, view.paths));
} else {
    installHostApi(undefined);
}
