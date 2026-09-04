export type EnvRecord = Readonly<Record<string, string | undefined>>;

const MANAGED_RUNTIME_ENV_KEYS = new Set([
  "T3CODE_HOME",
  "T3CODE_PROJECT_ROOT",
  "T3CODE_PROJECT_ID",
  "T3CODE_THREAD_ID",
  "T3CODE_WORKTREE_PATH",
]);

export function isManagedRuntimeEnvKey(key: string): boolean {
  return MANAGED_RUNTIME_ENV_KEYS.has(key.toUpperCase());
}

export function stripManagedRuntimeEnvKeys(env: EnvRecord | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  if (!env) return next;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isManagedRuntimeEnvKey(key)) continue;
    next[key] = value;
  }
  return next;
}

export interface ProjectLaunchEnvContextInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly worktreePath?: string | null | undefined;
}

export function buildLaunchContextEnv(input: ProjectLaunchEnvContextInput): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.projectRoot,
    T3CODE_PROJECT_ID: input.projectId,
    T3CODE_THREAD_ID: input.threadId,
  };
  if (input.worktreePath) env.T3CODE_WORKTREE_PATH = input.worktreePath;
  return env;
}

export function mergeResolvedProjectLaunchEnv(input: {
  readonly t3Home: string;
  readonly extraEnv?: EnvRecord;
  readonly context: ProjectLaunchEnvContextInput;
}): Record<string, string> {
  return {
    ...stripManagedRuntimeEnvKeys(input.extraEnv),
    T3CODE_HOME: input.t3Home,
    ...buildLaunchContextEnv(input.context),
  };
}
