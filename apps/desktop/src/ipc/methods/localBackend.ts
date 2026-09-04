import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setLocalBackendEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_BACKEND_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localBackend.setEnabled")(function* (enabled) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const change = yield* settings.setLocalBackendEnabled(enabled);
    if (change.changed) {
      yield* lifecycle.relaunch(`localBackendEnabled=${enabled}`);
    }
  }),
});
