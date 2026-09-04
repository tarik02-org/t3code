// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { validateForkHistory } from "./validate-fork-history.ts";

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "History Test",
      GIT_AUTHOR_EMAIL: "history@example.com",
      GIT_COMMITTER_NAME: "History Test",
      GIT_COMMITTER_EMAIL: "history@example.com",
    },
  });

const commitFile = (cwd: string, file: string, contents: string, message: string): string => {
  const target = `${cwd}/${file}`;
  NodeFS.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  NodeFS.writeFileSync(target, contents);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
};

const writeManifests = (cwd: string, version: string, files: ReadonlyArray<string>): void => {
  for (const file of files) {
    const target = `${cwd}/${file}`;
    NodeFS.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    NodeFS.writeFileSync(target, `${JSON.stringify({ version }, null, 2)}\n`);
  }
};

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
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "history@example.com"]);
  git(repo, ["config", "user.name", "History Test"]);
  return repo;
});

it.layer(NodeServices.layer)("validateForkHistory", (it) => {
  // The regression this guards: once the mirror moves ahead of `main`, every
  // push to `main` is based on an older upstream commit until an actualization
  // lands. That is a normal state and must not fail validation.
  it.effect("accepts a fork head based on an older upstream commit", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo();
      const forkBase = commitFile(repo, "README.md", "upstream\n", "upstream one");
      commitFile(repo, "README.md", "upstream two\n", "upstream two");
      const upstreamBase = git(repo, ["rev-parse", "HEAD"]).trim();

      git(repo, ["checkout", "-b", "fork", forkBase]);
      commitFile(repo, "fork-only.txt", "fork\n", "feat: fork change");

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
      commitFile(repo, "README.md", "upstream\n", "upstream one");
      git(repo, ["checkout", "--orphan", "unrelated"]);
      git(repo, ["rm", "-rf", "--cached", "."]);
      commitFile(repo, "other.txt", "other\n", "unrelated root");

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
      commitFile(repo, "README.md", "base\n", "base");
      git(repo, ["branch", "upstream"]);
      git(repo, ["checkout", "-b", "side"]);
      commitFile(repo, "side.txt", "side\n", "side");
      git(repo, ["checkout", "main"]);
      commitFile(repo, "main.txt", "main\n", "main");
      git(repo, ["merge", "--no-ff", "side", "-m", "merge side"]);

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
      commitFile(repo, "README.md", "base\n", "base");

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
      commitFile(repo, "README.md", "base\n", "base");
      writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "prepare stable release 9.9.9"]);

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
      commitFile(repo, "README.md", "base\n", "base");
      writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      writeManifests(repo, "9.9.10", ["apps/web/package.json"]);
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "prepare stable release 9.9.9"]);

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
      commitFile(repo, "README.md", "base\n", "base");
      writeManifests(repo, "9.9.9", RELEASE_MANIFESTS);
      commitFile(repo, "scripts/extra.ts", "extra\n", "prepare stable release 9.9.9");

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
