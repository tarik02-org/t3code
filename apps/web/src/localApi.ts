import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type ContextMenuStyle,
  type LocalApi,
} from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { isMacPlatform } from "./lib/utils";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";

let cachedApi: LocalApi | undefined;

async function readContextMenuStyle(): Promise<ContextMenuStyle> {
  try {
    const settings = window.desktopBridge
      ? await window.desktopBridge.getClientSettings()
      : readBrowserClientSettings();
    return settings?.contextMenuStyle ?? DEFAULT_CLIENT_SETTINGS.contextMenuStyle;
  } catch {
    return DEFAULT_CLIENT_SETTINGS.contextMenuStyle;
  }
}

function shouldUseNativeContextMenu(style: ContextMenuStyle): boolean {
  if (style === "custom") {
    return false;
  }
  if (style === "native") {
    return true;
  }
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return Boolean(window.desktopBridge) && isMacPlatform(platform);
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        const style = await readContextMenuStyle();
        if (shouldUseNativeContextMenu(style) && window.desktopBridge) {
          try {
            return (await window.desktopBridge.showContextMenu(items, position)) as T | null;
          } catch {
            return null;
          }
        }
        return showContextMenuFallback(items, position);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
