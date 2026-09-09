import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import {
  isManagedRuntimeEnvKey,
  stripManagedRuntimeEnvKeys,
  type EnvRecord,
} from "../projectLaunchEnv/projectLaunchEnvUtils.ts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return stripManagedRuntimeEnvKeys(baseEnv);
  }

  const next = stripManagedRuntimeEnvKeys(baseEnv);
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    if (isManagedRuntimeEnvKey(variable.name)) continue;
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

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
