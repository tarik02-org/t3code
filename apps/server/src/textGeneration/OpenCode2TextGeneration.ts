import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TextGenerationError,
  type ModelSelection,
  type OpenCode2Settings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCode2Runtime from "../provider/opencode2Runtime.ts";
import { Model } from "@opencode/client/effect";

const OpenCode2TextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);

type OpenCode2TextGenerationOperation = typeof OpenCode2TextGenerationOperation.Type;

const openCode2TextGenerationErrorContext = {
  operation: OpenCode2TextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCode2TextGenerationRequestError extends Schema.TaggedError<OpenCode2TextGenerationRequestError>()(
  "OpenCode2TextGenerationRequestError",
  {
    ...openCode2TextGenerationErrorContext,
    providerId: Schema.String,
    modelId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode 2 generate request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId}.`;
  }
}

export class OpenCode2TextGenerationEmptyOutputError extends Schema.TaggedError<OpenCode2TextGenerationEmptyOutputError>()(
  "OpenCode2TextGenerationEmptyOutputError",
  {
    ...openCode2TextGenerationErrorContext,
    providerId: Schema.String,
    modelId: Schema.String,
  },
) {
  override get message(): string {
    return `OpenCode 2 returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId}.`;
  }
}

/**
 * v2's `generate.text` runs on the connected server with no session and no
 * tool access (the endpoint is generation-only), so unlike the v1 helper
 * there is no spawned server to own and no permission ruleset to inject —
 * the deny-by-default guarantee comes from the endpoint itself.
 */
export const makeOpenCode2TextGeneration = (openCode2Settings: OpenCode2Settings) =>
  Effect.gen(function* () {
    const openCode2Runtime = yield* OpenCode2Runtime.OpenCode2Runtime;

    const parseModelSlug = (slug: string | null | undefined) => {
      const trimmed = (slug ?? "").trim();
      const separator = trimmed.indexOf("/");
      if (separator <= 0 || separator === trimmed.length - 1) {
        return null;
      }
      return Model.Ref.parse(trimmed);
    };

    const generate = <A>(input: {
      readonly operation: OpenCode2TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchema: Schema.Codec<A, unknown, never, never>;
      readonly modelSelection: ModelSelection;
    }) =>
      Effect.gen(function* () {
        const parsedModel = parseModelSlug(input.modelSelection.model);
        if (!parsedModel) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode 2 model selection must use the 'provider/model' format.",
          });
        }

        const connection = yield* openCode2Runtime.connect({
          ...(openCode2Settings.serverUrl ? { serverUrl: openCode2Settings.serverUrl } : {}),
          ...(openCode2Settings.serverPassword
            ? { serverPassword: openCode2Settings.serverPassword }
            : {}),
        });

        const result = yield* connection.client.generate
          .text({
            prompt: input.prompt,
            model: parsedModel,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCode2TextGenerationRequestError({
                  operation: input.operation,
                  cwd: input.cwd,
                  providerId: parsedModel.providerID,
                  modelId: parsedModel.id,
                  cause,
                }),
            ),
          );

        const rawText = result.text.trim();
        if (rawText.length === 0) {
          return yield* new OpenCode2TextGenerationEmptyOutputError({
            operation: input.operation,
            cwd: input.cwd,
            providerId: parsedModel.providerID,
            modelId: parsedModel.id,
          });
        }

        return yield* Schema.decodeEffect(input.outputSchema)(extractJsonObject(rawText)).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode 2 returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.catchTags({
          OpenCode2RuntimeError: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause.detail,
              cause,
            }),
          OpenCode2TextGenerationRequestError: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode 2 generate request failed.",
              cause,
            }),
          OpenCode2TextGenerationEmptyOutputError: (cause) =>
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode 2 returned empty output.",
              cause,
            }),
        }),
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      (input) =>
        Effect.gen(function* () {
          const { prompt, outputSchema } = buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          });
          const generated = yield* generate({
            operation: "generateCommitMessage",
            cwd: input.cwd,
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });

          return {
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          };
        });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* generate({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* generate({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          branch: sanitizeBranchFragment(generated.branch),
        };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
        });
        const generated = yield* generate({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizeThreadTitle(generated.title),
        };
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"];
  });
