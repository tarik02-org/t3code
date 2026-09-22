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

export class GitHistoryProcessError extends Schema.TaggedError<GitHistoryProcessError>()(
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

export class GitHistoryProcessExitError extends Schema.TaggedError<GitHistoryProcessExitError>()(
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

export class InvalidForkHistoryError extends Schema.TaggedError<InvalidForkHistoryError>()(
  "InvalidForkHistoryError",
  {
    reason: Schema.Literals([
      "unrelated-history",
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

// Runs git and reports its exit code instead of failing on it. `merge-base`
// uses a nonzero exit to mean "no common ancestor", which is a real answer
// rather than a process error.
const runGitCommand = Effect.fn("validateForkHistory.runGitCommand")(function* (
  args: ReadonlyArray<string>,
  cwd: string,
) {
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

  return { context, stdout, stderr, exitCode } as const;
});

const runGit = Effect.fn("validateForkHistory.runGit")(function* (
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const result = yield* runGitCommand(args, cwd);
  if (result.exitCode !== 0) {
    return yield* new GitHistoryProcessExitError({
      ...result.context,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });
  }
  return result.stdout.trim();
});

const decodePackageManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));

export const validateForkHistory = Effect.fn("validateForkHistory")(function* (input: {
  readonly ref: string;
  readonly upstreamRef: string;
  readonly requireReleaseState: boolean;
  // Repository to run git in. Defaults to the current working directory; tests
  // point it at a scratch repo instead of changing the process cwd.
  readonly repoDir?: string;
}) {
  const repoDir = input.repoDir ?? process.cwd();
  const head = yield* runGit(["rev-parse", input.ref], repoDir);
  const upstreamBase = yield* runGit(["rev-parse", input.upstreamRef], repoDir);

  // The fork's history only has to descend from upstream; a base behind the
  // mirror tip is a normal state while an actualization is pending, not a
  // broken history. Promotion enforces the exact base itself (see
  // promote-history.yml), so this check must never gate on it.
  const mergeBaseResult = yield* runGitCommand(["merge-base", head, upstreamBase], repoDir);
  if (mergeBaseResult.exitCode !== 0) {
    return yield* new InvalidForkHistoryError({
      reason: "unrelated-history",
      detail: `${head} and ${upstreamBase} have no common ancestor`,
    });
  }
  const historyBase = mergeBaseResult.stdout.trim();

  const mergeCommits = yield* runGit(["rev-list", "--merges", `${historyBase}..${head}`], repoDir);
  if (mergeCommits.length > 0) {
    return yield* new InvalidForkHistoryError({
      reason: "contains-merges",
      detail: mergeCommits,
    });
  }

  const commitSubject = yield* runGit(["show", "-s", "--format=%s", head], repoDir);
  const isReleaseState =
    commitSubject.startsWith("prepare stable release ") ||
    commitSubject.startsWith("chore(release):");
  if (input.requireReleaseState && !isReleaseState) {
    return yield* new InvalidForkHistoryError({
      reason: "invalid-release-state-subject",
      detail: commitSubject,
    });
  }

  if (!isReleaseState) {
    return { head, historyBase, upstreamBase, version: null } as const;
  }

  const changedFiles = (yield* runGit(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", head],
    repoDir,
  ))
    .split(/\r?\n/)
    .filter((file) => file.length > 0);
  const unexpectedFiles = changedFiles.filter((file) => !ReleaseStateFiles.has(file));
  if (unexpectedFiles.length > 0) {
    return yield* new InvalidForkHistoryError({
      reason: "unexpected-release-files",
      detail: unexpectedFiles.join("\n"),
    });
  }

  const versions = yield* Effect.forEach(
    PackageManifestFiles,
    (file) =>
      runGit(["show", `${head}:${file}`], repoDir).pipe(
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

  return { head, historyBase, upstreamBase, version: versionValues[0] } as const;
});

const command = Command.make(
  "validate-fork-history",
  {
    ref: Flag.String("ref").pipe(
      Flag.withSchema(ForkRef),
      Flag.withDescription("Git ref to validate."),
      Flag.withDefault("HEAD"),
    ),
    upstreamRef: Flag.String("upstream-ref").pipe(
      Flag.withSchema(ForkRef),
      Flag.withDescription("Upstream main ref used as the history base."),
      Flag.withDefault("refs/remotes/upstream/main"),
    ),
    requireReleaseState: Flag.Boolean("require-release-state").pipe(
      Flag.withDescription("Require the head commit to be a release-state commit."),
      Flag.withDefault(false),
    ),
  },
  ({ ref, upstreamRef, requireReleaseState }) =>
    validateForkHistory({ ref, upstreamRef, requireReleaseState }).pipe(
      Effect.flatMap(({ head, historyBase, upstreamBase, version }) => {
        const behind =
          historyBase === upstreamBase
            ? ""
            : ` (upstream/main is ahead at ${upstreamBase}; rebase at actualization)`;
        const release = version === null ? "" : ` (release ${version})`;
        return Console.log(`valid history ${head} based on ${historyBase}${release}${behind}`);
      }),
    ),
).pipe(
  Command.withDescription(
    "Validate the linear fork history and, when requested, its release state.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
