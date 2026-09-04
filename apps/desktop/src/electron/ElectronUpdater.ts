import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  AppImageUpdater,
  MacUpdater,
  NsisUpdater,
  type AppUpdater,
  type UpdateDownloadedEvent,
} from "electron-updater";

import { makeInstallUnsignedMacUpdate } from "./installUnsignedMacUpdate.ts";

export type ElectronUpdaterFeedUrl = Parameters<AppUpdater["setFeedURL"]>[0];

function createUpdater(platform: NodeJS.Platform): AppUpdater {
  switch (platform) {
    case "linux":
      return new AppImageUpdater();
    case "darwin":
      return new MacUpdater();
    case "win32":
      return new NsisUpdater();
    default:
      throw new Error(`Unsupported desktop update platform: ${platform}`);
  }
}

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedErrorClass<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedErrorClass<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedErrorClass<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

export const make = Effect.gen(function* () {
  const installUnsignedMacUpdate = yield* makeInstallUnsignedMacUpdate();
  const platform = yield* HostProcessPlatform;
  const updater = createUpdater(platform);
  let downloadedUpdatePath: string | undefined;
  updater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
    downloadedUpdatePath = event.downloadedFile;
  });

  return ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.suspend(() => {
        updater.setFeedURL(options);
        return Effect.void;
      }),
    setAutoDownload: (value) =>
      Effect.suspend(() => {
        updater.autoDownload = value;
        return Effect.void;
      }),
    setAutoInstallOnAppQuit: (value) =>
      Effect.suspend(() => {
        updater.autoInstallOnAppQuit = value;
        return Effect.void;
      }),
    setChannel: (channel) =>
      Effect.suspend(() => {
        updater.channel = channel;
        return Effect.void;
      }),
    setAllowPrerelease: (value) =>
      Effect.suspend(() => {
        updater.allowPrerelease = value;
        return Effect.void;
      }),
    allowDowngrade: Effect.sync(() => updater.allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.suspend(() => {
        updater.allowDowngrade = value;
        return Effect.void;
      }),
    setFullChangelog: (value) =>
      Effect.suspend(() => {
        updater.fullChangelog = value;
        return Effect.void;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.suspend(() => {
        updater.disableDifferentialDownload = value;
        return Effect.void;
      }),
    checkForUpdates: Effect.suspend(() => {
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.suspend(() => {
        const channel = updater.channel;
        if (platform === "darwin") {
          if (downloadedUpdatePath === undefined) {
            return Effect.fail(
              new ElectronUpdaterQuitAndInstallError({
                channel,
                isSilent,
                isForceRunAfter,
                cause: new Error("Downloaded macOS update path is unavailable."),
              }),
            );
          }
          return installUnsignedMacUpdate(downloadedUpdatePath).pipe(
            Effect.mapError(
              (cause) =>
                new ElectronUpdaterQuitAndInstallError({
                  channel,
                  isSilent,
                  isForceRunAfter,
                  cause,
                }),
            ),
          );
        }
        return Effect.try({
          try: () => updater.quitAndInstall(isSilent, isForceRunAfter),
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
      }),
    on: (eventName, listener) => {
      const eventTarget = updater as unknown as {
        on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      };
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          eventTarget.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            eventTarget.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

export const layer = Layer.effect(ElectronUpdater, make).pipe(Layer.provide(NodeServices.layer));
