import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isManagedRuntimeEnvKey,
  stripManagedRuntimeEnvKeys,
  type EnvRecord,
} from "@t3tools/shared/projectLaunchEnv";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return stripManagedRuntimeEnvKeys(baseEnv);
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = stripManagedRuntimeEnvKeys(baseEnv);
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    if (isManagedRuntimeEnvKey(variable.name)) continue;
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

export function mergeProviderSessionEnvironment(
  baseEnv: EnvRecord | undefined,
  sessionEnv: EnvRecord | undefined,
): Record<string, string> {
  const next = stripManagedRuntimeEnvKeys(baseEnv ?? process.env);
  if (!sessionEnv) return next;
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}
