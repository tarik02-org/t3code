import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  HostProcessArchitecture,
  HostProcessArguments,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    os: Schema.optionalKey(Schema.Array(Schema.String)),
    cpu: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const NotSymlink = Schema.Struct({ code: Schema.Literal("EINVAL") });
const isNotSymlink = Schema.is(NotSymlink);
const decodeManifest = Schema.decodeEffect(Manifest);
const decodeDestination = Schema.decodeUnknownEffect(Schema.String);

class RuntimeDependencyOutsideStore extends Schema.TaggedError<RuntimeDependencyOutsideStore>()(
  "RuntimeDependencyOutsideStore",
  { source: Schema.String },
) {
  override get message() {
    return `Runtime dependency is outside the pnpm virtual store: ${this.source}`;
  }
}

const matchesPlatform = (values: readonly string[] | undefined, current: string) =>
  values === undefined ||
  (!values.includes(`!${current}`) &&
    (values.every((value) => value.startsWith("!")) || values.includes(current)));

const stage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const args = yield* HostProcessArguments;
  const destination = path.resolve(yield* decodeDestination(args[2]));
  const root = yield* HostProcessWorkingDirectory;
  const store = path.join(root, "node_modules/.pnpm");
  const copied = new Set<string>();

  const readManifest = Effect.fn("readManifest")(function* (directory: string) {
    const contents = yield* fs.readFileString(path.join(directory, "package.json"));
    return yield* decodeManifest(contents);
  });

  const readSymlink = (source: string) =>
    fs.readLink(source).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "Unknown" && isNotSymlink(error.reason.cause),
        () => Effect.succeed(Option.none<string>()),
      ),
    );

  // FileSystem.copy rewrites relative symlinks into source-tree references.
  // Copy entries individually so the staged pnpm layout remains self-contained.
  const copyTree = Effect.fn("copyTree")(function* (
    source: string,
    target: string,
    nativeBuild: string | undefined,
  ): Effect.fn.Return<void, PlatformError> {
    if (path.basename(source) === ".bin") return;
    if (nativeBuild !== undefined) {
      const relative = path.relative(nativeBuild, source);
      if (
        relative !== "" &&
        !relative.startsWith("..") &&
        relative !== "Release" &&
        !relative.startsWith(`Release${path.sep}`)
      )
        return;
    }
    const link = yield* readSymlink(source);
    if (Option.isSome(link)) {
      yield* fs.symlink(link.value, target);
      return;
    }
    const info = yield* fs.stat(source);
    if (info.type === "Directory") {
      yield* fs.makeDirectory(target, { recursive: true });
      for (const entry of yield* fs.readDirectory(source)) {
        yield* copyTree(path.join(source, entry), path.join(target, entry), nativeBuild);
      }
      yield* fs.chmod(target, info.mode);
    } else {
      yield* fs.copyFile(source, target);
    }
  });

  const copyDependency = Effect.fn("copyDependency")(function* (
    source: string,
  ): Effect.fn.Return<void, PlatformError | Schema.SchemaError | RuntimeDependencyOutsideStore> {
    const real = yield* fs.realPath(source);
    const manifest = yield* readManifest(real);
    if (!matchesPlatform(manifest.os, platform) || !matchesPlatform(manifest.cpu, architecture))
      return;
    const relative = path.relative(store, real);
    const directory = relative.split(path.sep)[0];
    if (directory === undefined || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new RuntimeDependencyOutsideStore({ source });
    }
    if (copied.has(directory)) return;
    copied.add(directory);

    const modules = path.join(store, directory, "node_modules");
    const target = path.join(destination, "node_modules/.pnpm", directory, "node_modules");
    // Keep compiled native binaries and peer variants; omit node-pty's build metadata.
    yield* copyTree(
      modules,
      target,
      path.basename(real) === "node-pty" ? path.join(real, "build") : undefined,
    );
    for (const entry of yield* fs.readDirectory(modules)) {
      if (entry === ".bin") continue;
      const candidate = path.join(modules, entry);
      if (Option.isSome(yield* readSymlink(candidate))) {
        yield* copyDependency(candidate);
      } else if (entry.startsWith("@") && (yield* fs.stat(candidate)).type === "Directory") {
        for (const scoped of yield* fs.readDirectory(candidate)) {
          const scopedPath = path.join(candidate, scoped);
          if (Option.isSome(yield* readSymlink(scopedPath))) yield* copyDependency(scopedPath);
        }
      }
    }
  });

  const stageDependency = Effect.fn("stageDependency")(function* (source: string, target: string) {
    yield* copyDependency(source);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const real = yield* fs.realPath(source);
    yield* fs.symlink(
      path.relative(path.dirname(target), path.join(destination, path.relative(root, real))),
      target,
    );
  });

  for (const [project, select] of [
    ["apps/server", selectCliRuntimeExternalDependencies],
    ["apps/desktop", selectDesktopRuntimeExternalDependencies],
  ] as const) {
    const manifest = yield* readManifest(path.join(root, project));
    for (const name of Object.keys(select(manifest.dependencies ?? {}))) {
      yield* stageDependency(
        path.join(root, project, "node_modules", name),
        path.join(destination, project, "node_modules", name),
      );
    }
  }

  // Cursor also searches the public hoist directory for its platform helper.
  const cursor = path.join(root, "node_modules/@cursor", `sdk-${platform}-${architecture}`);
  if (yield* fs.exists(cursor)) {
    yield* stageDependency(
      cursor,
      path.join(destination, "node_modules/@cursor", path.basename(cursor)),
    );
  }
  yield* Console.log(`Staged ${copied.size} runtime dependency variants.`);
});

NodeRuntime.runMain(stage.pipe(Effect.provide(NodeServices.layer)));
