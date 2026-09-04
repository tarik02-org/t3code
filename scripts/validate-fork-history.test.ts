import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runGit, validateForkHistory } from "./validate-fork-history.ts";

const writeFile = Effect.fn("writeFile")(function* (target: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, contents);
});

const commitFile = Effect.fn("commitFile")(function* (
  cwd: string,
  file: string,
  contents: string,
  message: string,
) {
  const path = yield* Path.Path;
  yield* writeFile(path.join(cwd, file), contents);
  yield* runGit(["add", file], cwd);
  yield* runGit(["commit", "-m", message], cwd);
  return yield* runGit(["rev-parse", "HEAD"], cwd);
});

const writeManifests = Effect.fn("writeManifests")(function* (
  cwd: string,
  version: string,
  files: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  for (const file of files) {
    yield* writeFile(
      path.join(cwd, file),
      `${JSON.stringify({ version }, null, 2)}
`,
    );
  }
});

const RELEASE_MANIFESTS = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

const makeRepo = Effect.fn("makeRepo")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "validate-fork-history-" });
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(repo, { recursive: true });
  yield* runGit(["init", "--initial-branch=main"], repo);
  yield* runGit(["config", "user.email", "history@example.com"], repo);
  yield* runGit(["config", "user.name", "History Test"], repo);
  return repo;
});

it.layer(NodeServices.layer)("validateForkHistory", (it) => {
  // The regression this guards: once the mirror moves ahead of `main`, every
  // push to `main` is based on an older upstream commit until an actualization
  // lands. That is a normal state and must not fail validation.
  it.effect("accepts a fork head based on an older upstream commit", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      const forkBase = yield* commitFile(repo, "README.md", "upstream\n", "upstream one");
      yield* commitFile(repo, "README.md", "upstream two\n", "upstream two");
      const upstreamBase = yield* runGit(["rev-parse", "HEAD"], repo);

      yield* runGit(["checkout", "-b", "fork", forkBase], repo);
      yield* commitFile(repo, "fork-only.txt", "fork\n", "feat: fork change");

      const result = yield* validateForkHistory({
        ref: "fork",
        upstreamRef: "main",
        requireReleaseState: false,
        repoDir: repo,
      });

      assert.equal(result.historyBase, forkBase);
      assert.equal(result.upstreamBase, upstreamBase);
      assert.notEqual(result.historyBase, result.upstreamBase);
      assert.isNull(result.version);
    }),
  );

  it.effect("rejects a fork head with no common ancestor", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "upstream\n", "upstream one");
      yield* runGit(["checkout", "--orphan", "unrelated"], repo);
      yield* runGit(["rm", "-rf", "--cached", "."], repo);
      yield* commitFile(repo, "other.txt", "other\n", "unrelated root");

      const error = yield* validateForkHistory({
        ref: "unrelated",
        upstreamRef: "main",
        requireReleaseState: false,
        repoDir: repo,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "InvalidForkHistoryError");
      if (error._tag !== "InvalidForkHistoryError") return;
      assert.equal(error.reason, "unrelated-history");
    }),
  );

  it.effect("rejects merges above the history base", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "base\n", "base");
      yield* runGit(["branch", "upstream"], repo);
      yield* runGit(["checkout", "-b", "side"], repo);
      yield* commitFile(repo, "side.txt", "side\n", "side");
      yield* runGit(["checkout", "main"], repo);
      yield* commitFile(repo, "main.txt", "main\n", "main");
      yield* runGit(["merge", "--no-ff", "side", "-m", "merge side"], repo);

      const error = yield* validateForkHistory({
        ref: "main",
        upstreamRef: "upstream",
        requireReleaseState: false,
        repoDir: repo,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "InvalidForkHistoryError");
      if (error._tag !== "InvalidForkHistoryError") return;
      assert.equal(error.reason, "contains-merges");
    }),
  );

  it.effect("requires a release-state subject when requested", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "base\n", "base");

      const error = yield* validateForkHistory({
        ref: "main",
        upstreamRef: "main",
        requireReleaseState: true,
        repoDir: repo,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "InvalidForkHistoryError");
      if (error._tag !== "InvalidForkHistoryError") return;
      assert.equal(error.reason, "invalid-release-state-subject");
    }),
  );

  it.effect("accepts a consistent release-state commit", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "base\n", "base");
      yield* writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      yield* runGit(["add", "."], repo);
      yield* runGit(["commit", "-m", "prepare stable release 9.9.9"], repo);

      const result = yield* validateForkHistory({
        ref: "main",
        upstreamRef: "main",
        requireReleaseState: true,
        repoDir: repo,
      });

      assert.equal(result.version, "9.9.9");
    }),
  );

  it.effect("rejects release-state commits that disagree on the version", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "base\n", "base");
      yield* writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      yield* writeManifests(repo, "9.9.10", ["apps/web/package.json"]);
      yield* runGit(["add", "."], repo);
      yield* runGit(["commit", "-m", "prepare stable release 9.9.9"], repo);

      const error = yield* validateForkHistory({
        ref: "main",
        upstreamRef: "main",
        requireReleaseState: true,
        repoDir: repo,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "InvalidForkHistoryError");
      if (error._tag !== "InvalidForkHistoryError") return;
      assert.equal(error.reason, "package-versions-disagree");
    }),
  );

  it.effect("rejects release-state commits that touch files outside the release set", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      yield* commitFile(repo, "README.md", "base\n", "base");
      yield* writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      yield* commitFile(repo, "scripts/extra.ts", "extra\n", "prepare stable release 9.9.9");

      const error = yield* validateForkHistory({
        ref: "main",
        upstreamRef: "main",
        requireReleaseState: true,
        repoDir: repo,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "InvalidForkHistoryError");
      if (error._tag !== "InvalidForkHistoryError") return;
      assert.equal(error.reason, "unexpected-release-files");
    }),
  );
});
