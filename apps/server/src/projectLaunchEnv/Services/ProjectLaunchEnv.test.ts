import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ProjectLaunchEnvProjectFixture,
  type ProjectLaunchEnvThreadFixture,
  ProjectLaunchEnvTestLayer,
} from "../Layers/ProjectLaunchEnvTest.ts";
import { ProjectLaunchEnvThreadLookupError } from "../Services/ProjectLaunchEnvErrors.ts";
import { ProjectLaunchEnv } from "../Services/ProjectLaunchEnv.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const T3_HOME = "/tmp/t3-launch-env";
const makeProject = (): ProjectLaunchEnvProjectFixture => ({
  id: PROJECT_ID,
  workspaceRoot: "/repo/project",
});

const makeThread = (
  overrides: Partial<ProjectLaunchEnvThreadFixture> = {},
): ProjectLaunchEnvThreadFixture => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  worktreePath: "/repo/worktrees/a",
  ...overrides,
});

const makeTestLayer = (threads: ReadonlyArray<ProjectLaunchEnvThreadFixture>) =>
  ProjectLaunchEnvTestLayer.withFixtures({
    t3Home: T3_HOME,
    projects: [makeProject()],
    threads,
  });

describe("ProjectLaunchEnv.resolveForThread", () => {
  it.effect("resolves project launch env using the thread project id", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
      });

      assert.deepStrictEqual(result.env, {
        T3CODE_HOME: T3_HOME,
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_PROJECT_ID: "project-1",
        T3CODE_THREAD_ID: "thread-1",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      });
      assert.strictEqual(result.worktreePath, "/repo/worktrees/a");
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );

  it.effect("ignores client projectId when the thread already exists", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const spoofedProjectId = ProjectId.make("project-spoofed");
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        projectId: spoofedProjectId,
      });

      assert.strictEqual(result.env.T3CODE_PROJECT_ID, "project-1");
      assert.strictEqual(result.projectId, PROJECT_ID);
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );

  it.effect("resolves project launch env for draft threads using client projectId", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        projectId: PROJECT_ID,
      });

      assert.strictEqual(result.env.T3CODE_PROJECT_ID, "project-1");
      assert.strictEqual(result.env.T3CODE_THREAD_ID, "thread-1");
    }).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("fails when the thread is not found and projectId is omitted", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const error = yield* Effect.flip(
        projectLaunchEnv.resolveForThread({
          threadId: THREAD_ID,
          terminalId: DEFAULT_TERMINAL_ID,
        }),
      );

      assert.instanceOf(error, ProjectLaunchEnvThreadLookupError);
    }).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("prefers explicit worktreePath over the thread default", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        worktreePath: "/repo/worktrees/b",
      });

      assert.strictEqual(result.worktreePath, "/repo/worktrees/b");
      assert.strictEqual(result.env.T3CODE_WORKTREE_PATH, "/repo/worktrees/b");
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );
});
