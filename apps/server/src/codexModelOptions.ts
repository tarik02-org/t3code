import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

// `model/list` has no context-limit field; replace this allowlist when Codex exposes one.
const LONG_CONTEXT_CODEX_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
]);

export function supportsCodexLongContext(model: string): boolean {
  return LONG_CONTEXT_CODEX_MODELS.has(model);
}

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
