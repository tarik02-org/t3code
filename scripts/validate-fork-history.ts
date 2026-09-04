#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const ForkRef = NonEmptyString;
const PackageManifest = Schema.Struct({ version: NonEmptyString });
const PackageManifestFiles = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;
const ReleaseStateFiles = new Set([...PackageManifestFiles, "pnpm-lock.yaml", "nix/package.nix"]);

const gitProcessContext = {
  executable: Schema.Literal("git"),
  argumentCount: NonNegativeInt,
  cwd: Schema.String,
};

export class GitHistoryProcessError extends Schema.TaggedErrorClass<GitHistoryProcessError>()(
  "GitHistoryProcessError",
  {
    ...gitProcessContext,
    operation: Schema.Literals(["spawn", "read-stdout", "read-stderr", "wait-for-exit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Git history validation failed during ${this.operation}.`;
  }
}

export class GitHistoryProcessExitError extends Schema.TaggedErrorClass<GitHistoryProcessExitError>()(
  "GitHistoryProcessExitError",
  {
    ...gitProcessContext,
    exitCode: Schema.Number,
    stdoutLength: NonNegativeInt,
    stderrLength: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Git history validation command exited with code ${this.exitCode}.`;
  }
}

export class InvalidForkHistoryError extends Schema.TaggedErrorClass<InvalidForkHistoryError>()(
  "InvalidForkHistoryError",
  {
    reason: Schema.Literals([
      "not-based-on-upstream",
      "contains-merges",
      "unexpected-release-files",
      "invalid-release-state-subject",
      "package-versions-disagree",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Fork history is invalid (${this.reason}): ${this.detail}`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const runGit = Effect.fn("validateForkHistory.runGit")(function* (args: ReadonlyArray<string>) {
  const cwd = process.cwd();
  const context = {
    executable: "git" as const,
    argumentCount: args.length,
    cwd,
  };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd })).pipe(
    Effect.mapError(
      (cause) =>
        new GitHistoryProcessError({
          ...context,
          operation: "spawn",
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new GitHistoryProcessError({
              ...context,
              operation: "read-stdout",
              cause,
            }),
        ),
      ),
      collectStreamAsString(child.stderr).pipe(
        Effect.mapError(
          (cause) =>
            new GitHistoryProcessError({
              ...context,
              operation: "read-stderr",
              cause,
            }),
        ),
      ),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(
          (cause) =>
            new GitHistoryProcessError({
              ...context,
              operation: "wait-for-exit",
              cause,
            }),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new GitHistoryProcessExitError({
      ...context,
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
  }

  return stdout.trim();
});

const decodePackageManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));

export const validateForkHistory = Effect.fn("validateForkHistory")(function* (input: {
  readonly ref: string;
  readonly upstreamRef: string;
}) {
  const head = yield* runGit(["rev-parse", input.ref]);
  const upstreamBase = yield* runGit(["rev-parse", input.upstreamRef]);
  const mergeBase = yield* runGit(["merge-base", head, upstreamBase]);
  if (mergeBase !== upstreamBase) {
    return yield* new InvalidForkHistoryError({
      reason: "not-based-on-upstream",
      detail: `${mergeBase} does not equal ${upstreamBase}`,
    });
  }

  const mergeCommits = yield* runGit(["rev-list", "--merges", `${upstreamBase}..${head}`]);
  if (mergeCommits.length > 0) {
    return yield* new InvalidForkHistoryError({
      reason: "contains-merges",
      detail: mergeCommits,
    });
  }

  const changedFiles = (yield* runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", head]))
    .split(/\r?\n/)
    .filter((file) => file.length > 0);
  const unexpectedFiles = changedFiles.filter((file) => !ReleaseStateFiles.has(file));
  if (unexpectedFiles.length > 0) {
    return yield* new InvalidForkHistoryError({
      reason: "unexpected-release-files",
      detail: unexpectedFiles.join("\n"),
    });
  }

  const commitSubject = yield* runGit(["show", "-s", "--format=%s", head]);
  if (
    !commitSubject.startsWith("prepare stable release ") &&
    !commitSubject.startsWith("chore(release):")
  ) {
    return yield* new InvalidForkHistoryError({
      reason: "invalid-release-state-subject",
      detail: commitSubject,
    });
  }

  const versions = yield* Effect.forEach(
    PackageManifestFiles,
    (file) =>
      runGit(["show", `${head}:${file}`]).pipe(
        Effect.flatMap((source) => decodePackageManifest(source)),
      ),
    { concurrency: "unbounded" },
  );
  const versionValues = versions.map((manifest) => manifest.version);
  if (new Set(versionValues).size !== 1) {
    return yield* new InvalidForkHistoryError({
      reason: "package-versions-disagree",
      detail: versionValues.join(", "),
    });
  }

  return { head, upstreamBase, version: versionValues[0] } as const;
});

const command = Command.make(
  "validate-fork-history",
  {
    ref: Flag.string("ref").pipe(
      Flag.withSchema(ForkRef),
      Flag.withDescription("Git ref to validate."),
      Flag.withDefault("HEAD"),
    ),
    upstreamRef: Flag.string("upstream-ref").pipe(
      Flag.withSchema(ForkRef),
      Flag.withDescription("Upstream main ref used as the history base."),
      Flag.withDefault("refs/remotes/upstream/main"),
    ),
  },
  ({ ref, upstreamRef }) =>
    validateForkHistory({ ref, upstreamRef }).pipe(
      Effect.flatMap(({ head, upstreamBase, version }) =>
        Console.log(`valid history ${head} based on ${upstreamBase} (release ${version})`),
      ),
    ),
).pipe(Command.withDescription("Validate the linear fork release-state history."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
