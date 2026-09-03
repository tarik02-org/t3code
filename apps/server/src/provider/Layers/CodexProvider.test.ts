import { assert, it } from "@effect/vitest";

import { supportsCodexLongContext } from "../../codexModelOptions.ts";
import {
  appendCustomCodexModels,
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it.each([
  ["gpt-5.4", true],
  ["gpt-5.6-luna", true],
  ["gpt-5.6-terra", true],
  ["gpt-5.6-sol", true],
  ["gpt-5.5", false],
  ["custom-model", false],
] as const)("maps long context support for %s", (model, expected) => {
  assert.equal(supportsCodexLongContext(model), expected);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-5.6-luna",
    isDefault: true,
    model: "gpt-5.6-luna",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "258k", label: "258k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "258k",
    },
    {
      id: "defaultModeRequestUserInput",
      label: "Default Mode Questions",
      description: "Control whether Codex can ask questions while working in Default mode.",
      type: "select",
      options: [
        {
          id: "unset",
          label: "Unset",
          description: "Use the configured Codex default.",
          isDefault: true,
        },
        {
          id: "allow",
          label: "Allow",
          description: "Allow request_user_input in Default mode.",
        },
        {
          id: "reject",
          label: "Reject",
          description: "Restrict request_user_input to Plan mode.",
        },
      ],
      currentValue: "unset",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-5.5",
    isDefault: true,
    model: "gpt-5.5",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
    {
      id: "defaultModeRequestUserInput",
      label: "Default Mode Questions",
      description: "Control whether Codex can ask questions while working in Default mode.",
      type: "select",
      options: [
        {
          id: "unset",
          label: "Unset",
          description: "Use the configured Codex default.",
          isDefault: true,
        },
        {
          id: "allow",
          label: "Allow",
          description: "Allow request_user_input in Default mode.",
        },
        {
          id: "reject",
          label: "Reject",
          description: "Restrict request_user_input to Plan mode.",
        },
      ],
      currentValue: "unset",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("keeps long context off custom models", () => {
  const models = appendCustomCodexModels(
    [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [],
            },
            { id: "serviceTier", label: "Service Tier", type: "select", options: [] },
          ],
        },
      },
    ],
    ["custom-model"],
  );

  assert.deepStrictEqual(
    models[1]?.capabilities?.optionDescriptors?.map(({ id }) => id),
    ["serviceTier"],
  );
});
