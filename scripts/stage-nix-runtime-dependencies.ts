// @effect-diagnostics nodeBuiltinImport:off - Node copy preserves pnpm symlinks while filtering build command shims.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    os: Schema.optionalKey(Schema.Array(Schema.String)),
    cpu: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decodeManifest = Schema.decodeSync(Manifest);
const readManifest = (directory: string) =>
  decodeManifest(NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"));

const platform = HostProcessPlatform.defaultValue();
const architecture = HostProcessArchitecture.defaultValue();
const destination = NodePath.resolve(Schema.decodeUnknownSync(Schema.String)(process.argv[2]));
const root = process.cwd();
const store = NodePath.join(root, "node_modules/.pnpm");
const copied = new Set<string>();

const matchesPlatform = (values: readonly string[] | undefined, current: string) =>
  values === undefined ||
  (!values.includes(`!${current}`) &&
    (values.every((value) => value.startsWith("!")) || values.includes(current)));

function copyDependency(source: string): void {
  const real = NodeFS.realpathSync(source);
  const manifest = readManifest(real);
  if (!matchesPlatform(manifest.os, platform) || !matchesPlatform(manifest.cpu, architecture)) {
    return;
  }
  const relative = NodePath.relative(store, real);
  const directory = relative.split(NodePath.sep)[0];
  if (directory === undefined || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new Error(`Runtime dependency is outside the pnpm virtual store: ${source}`);
  }
  if (copied.has(directory)) return;
  copied.add(directory);

  const sourceDirectory = NodePath.join(store, directory);
  const targetDirectory = NodePath.join(destination, "node_modules/.pnpm", directory);
  // Copy the built package, including native binaries, rather than reinstalling
  // it from the fetch store and losing build outputs. Preserve pnpm's peer variants.
  NodeFS.cpSync(
    NodePath.join(sourceDirectory, "node_modules"),
    NodePath.join(targetDirectory, "node_modules"),
    {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => {
        if (NodePath.basename(file) === ".bin") return false;
        // node-pty only loads Release binaries; generated makefiles retain build tools.
        const relativeBuild = NodePath.relative(NodePath.join(real, "build"), file);
        return (
          NodePath.basename(real) !== "node-pty" ||
          relativeBuild === "" ||
          relativeBuild.startsWith("..") ||
          relativeBuild === "Release" ||
          relativeBuild.startsWith(`Release${NodePath.sep}`)
        );
      },
    },
  );
  const modules = NodePath.join(sourceDirectory, "node_modules");
  for (const entry of NodeFS.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const candidate = NodePath.join(modules, entry.name);
    if (entry.isSymbolicLink()) {
      copyDependency(candidate);
    } else if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scoped of NodeFS.readdirSync(candidate, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) copyDependency(NodePath.join(candidate, scoped.name));
      }
    }
  }
}

for (const [project, select] of [
  ["apps/server", selectCliRuntimeExternalDependencies],
  ["apps/desktop", selectDesktopRuntimeExternalDependencies],
] as const) {
  const manifest = readManifest(NodePath.join(root, project));
  for (const name of Object.keys(select(manifest.dependencies ?? {}))) {
    const source = NodePath.join(root, project, "node_modules", name);
    copyDependency(source);
    const target = NodePath.join(destination, project, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.relative(
        NodePath.dirname(target),
        NodePath.join(destination, NodePath.relative(root, NodeFS.realpathSync(source))),
      ),
      target,
    );
  }
}

// Cursor also searches the public hoist directory for its platform helper.
const cursor = NodePath.join(root, "node_modules/@cursor");
if (NodeFS.existsSync(cursor)) {
  for (const name of NodeFS.readdirSync(cursor)) {
    if (name !== `sdk-${platform}-${architecture}`) continue;
    const source = NodePath.join(cursor, name);
    copyDependency(source);
    const target = NodePath.join(destination, "node_modules/@cursor", name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.relative(
        NodePath.dirname(target),
        NodePath.join(destination, NodePath.relative(root, NodeFS.realpathSync(source))),
      ),
      target,
    );
  }
}

await Effect.runPromise(Console.log(`Staged ${copied.size} runtime dependency variants.`));
