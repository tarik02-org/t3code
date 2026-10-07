#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { listGitTags } from "./resolve-previous-release-tag.ts";

export interface ForkStableReleaseMetadata {
  readonly version: string;
  readonly tag: string;
  readonly name: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));

export class ForkStableReleaseGitHubOutputConfigError extends Schema.TaggedError<ForkStableReleaseGitHubOutputConfigError>()(
  "ForkStableReleaseGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve the GITHUB_OUTPUT path for fork stable release metadata.";
  }
}

export class ForkStableReleaseGitHubOutputAppendError extends Schema.TaggedError<ForkStableReleaseGitHubOutputAppendError>()(
  "ForkStableReleaseGitHubOutputAppendError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append fork stable release metadata to ${this.outputPath}.`;
  }
}

export function resolveForkStableReleaseMetadata(
  date: string,
  tags: ReadonlyArray<string>,
): ForkStableReleaseMetadata {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const daySlot = day * 100;
  const tagPattern = new RegExp(`^v?${year}\\.${month}\\.([0-9]+)$`);
  let maxSequence = 0;

  for (const tag of tags) {
    const match = tagPattern.exec(tag);
    if (!match) {
      continue;
    }

    const patch = Number(match[1]);
    if (patch < daySlot || patch >= daySlot + 100) {
      continue;
    }

    maxSequence = Math.max(maxSequence, patch - daySlot + 1);
  }

  const nextSequence = maxSequence + 1;
  const patch = daySlot + nextSequence - 1;
  const version = `${year}.${month}.${patch}`;
  return {
    version,
    tag: `v${version}`,
    name: `T3 Code v${version}`,
  };
}

const writeForkStableReleaseOutput = Effect.fn("writeForkStableReleaseOutput")(function* (
  metadata: ForkStableReleaseMetadata,
  writeGithubOutput: boolean,
) {
  const entries = [
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
  ] as const;

  if (!writeGithubOutput) {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const githubOutputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new ForkStableReleaseGitHubOutputConfigError({ cause })),
  );
  const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
  yield* fs
    .writeFileString(githubOutputPath, serialized, { flag: "a" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ForkStableReleaseGitHubOutputAppendError({ outputPath: githubOutputPath, cause }),
      ),
    );
});

const command = Command.make(
  "resolve-fork-stable-release",
  {
    date: Flag.String("date").pipe(
      Flag.withSchema(DateSchema),
      Flag.withDescription("Release date in UTC, formatted as YYYYMMDD."),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("Repository whose tags are read. Defaults to the working directory."),
      Flag.optional,
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
    versionOnly: Flag.Boolean("version-only").pipe(
      Flag.withDescription("Print only the resolved version."),
      Flag.withDefault(false),
    ),
  },
  ({ date, root, githubOutput, versionOnly }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tags = yield* listGitTags(Option.getOrUndefined(Option.map(root, path.resolve)));
      const metadata = resolveForkStableReleaseMetadata(date, tags);
      if (versionOnly) {
        yield* Console.log(metadata.version);
        return;
      }
      yield* writeForkStableReleaseOutput(metadata, githubOutput);
    }),
).pipe(Command.withDescription("Resolve the next date-based fork stable release version."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
