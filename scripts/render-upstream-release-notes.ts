#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";

import { runGit } from "./validate-fork-history.ts";

export class UpstreamReleaseNotesWriteError extends Schema.TaggedError<UpstreamReleaseNotesWriteError>()(
  "UpstreamReleaseNotesWriteError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write upstream release notes to ${this.outputPath}.`;
  }
}

export const renderUpstreamReleaseNotes = Effect.fn("renderUpstreamReleaseNotes")(
  function* (input: {
    readonly previousTag: string;
    readonly releaseRef: string;
    readonly upstreamRef: string;
  }) {
    const cwd = yield* HostProcessWorkingDirectory;
    const previousBase = yield* runGit(["merge-base", input.previousTag, input.upstreamRef], cwd);
    const releaseBase = yield* runGit(["merge-base", input.releaseRef, input.upstreamRef], cwd);
    const commits = yield* runGit(
      ["log", "--first-parent", "--format=- %s (%h)", `${previousBase}..${releaseBase}`],
      cwd,
    );
    const compareUrl = `https://github.com/pingdotgg/t3code/compare/${previousBase}...${releaseBase}`;

    return [
      "## Upstream changes",
      "",
      commits || "- No upstream commits since the previous release.",
      "",
      `Upstream base: \`${releaseBase}\``,
      `Full upstream comparison: ${compareUrl}`,
      "",
    ].join("\n");
  },
);

const command = Command.make(
  "render-upstream-release-notes",
  {
    previousTag: Flag.String("previous-tag").pipe(
      Flag.withDescription("Previous release tag whose upstream base starts the range."),
    ),
    releaseRef: Flag.String("release-ref").pipe(
      Flag.withDescription("Release commit whose upstream base ends the range."),
    ),
    upstreamRef: Flag.String("upstream-ref").pipe(
      Flag.withDescription("Upstream main ref used to find both bases."),
    ),
    output: Flag.String("output").pipe(Flag.withDescription("Markdown file to write.")),
  },
  ({ previousTag, releaseRef, upstreamRef, output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const body = yield* renderUpstreamReleaseNotes({ previousTag, releaseRef, upstreamRef });
      yield* fs
        .writeFileString(output, body)
        .pipe(
          Effect.mapError(
            (cause) => new UpstreamReleaseNotesWriteError({ outputPath: output, cause }),
          ),
        );
    }),
).pipe(
  Command.withDescription("Render the upstream changes between two fork releases as Markdown."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
