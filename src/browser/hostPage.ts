/**
 * The host script of an app page that its own server serves (`startHttpServer`, `GET /apps/:appId`, as
 * `/assets/host.js`): the live view with the direct channel to that server (`viewChannel.ts`)
 */

import { installHostApi, LiveView } from './host.js';
import { directChannel } from './viewChannel.js';

const live = new LiveView(document.body);
installHostApi(live);
live.start((view) => directChannel(view.appId, view.viewId, view.viewKind));
