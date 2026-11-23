import { describe, expect, it } from "vitest";

import {
  OPENCODE_MODEL_DEFINITIONS,
  modelsFromAntigravityAvailableModels,
  modelsFromGeminiApi,
} from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-opus-5-5",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-sonnet-5-5",
      "antigravity-gemini-3-flash",
      "antigravity-gemini-3.1-flash-lite",
      "antigravity-gemini-3.5-flash-lite",
      "antigravity-gemini-3.8-flash",
      "antigravity-gemini-4-argon",
      "antigravity-gemini-4-carbon",
      "antigravity-gemini-4-hydrogen",
      "antigravity-gemini-4-neon",
    ]);
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3-flash").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3.1-flash-lite").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(getModel("antigravity-gemini-3.1-flash-lite").temperature).toBe(false);

    expect(getModel("antigravity-gemini-3.5-flash-lite").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(getModel("antigravity-gemini-3.5-flash-lite").temperature).toBe(false);

    expect(getModel("antigravity-gemini-3.8-flash").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(getModel("antigravity-gemini-3.8-flash").temperature).toBe(false);
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });
});

describe("dynamic model discovery helpers", () => {
  it("converts Gemini models.list metadata into OpenCode models", () => {
    const models = modelsFromGeminiApi([
      {
        name: "models/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        inputTokenLimit: 1000,
        outputTokenLimit: 2000,
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/text-embedding-004",
        displayName: "Text Embedding 004",
        supportedGenerationMethods: ["embedContent"],
      },
    ]);

    expect(models["gemini-2.5-flash"]).toMatchObject({
      name: "Gemini 2.5 Flash (Gemini API)",
      limit: { context: 1000, output: 2000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["text-embedding-004"]).toBeUndefined();
  });

  it("keeps Gemini models.list resource names distinct from shared base aliases", () => {
    const models = modelsFromGeminiApi([
      {
        name: "models/gemini-2.5-flash-001",
        baseModelId: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash 001",
        inputTokenLimit: 1000,
        outputTokenLimit: 2000,
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-2.5-flash-002",
        baseModelId: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash 002",
        inputTokenLimit: 3000,
        outputTokenLimit: 4000,
        supportedGenerationMethods: ["generateContent"],
      },
    ]);

    expect(models["gemini-2.5-flash-001"]?.limit).toEqual({ context: 1000, output: 2000 });
    expect(models["gemini-2.5-flash-002"]?.limit).toEqual({ context: 3000, output: 4000 });
  });

  it("converts Antigravity available models while preserving curated variants and inferring dynamic ones", () => {
    const models = modelsFromAntigravityAvailableModels({
      "gemini-3-flash": {
        displayName: "Gemini 3 Flash",
        modelName: "gemini-3-flash",
      },
      "gemini-3.6-flash": {
        displayName: "Gemini 3.6 Flash",
        modelName: "gemini-3.6-flash",
      },
      "gemini-3.7-flash": {
        displayName: "Gemini 3.7 Flash",
        modelName: "gemini-3.7-flash",
      },
      "gemini-3.8-flash": {
        displayName: "Gemini 3.8 Flash Preview",
        modelName: "gemini-3.8-flash",
      },
      "gemini-3.8-pro": {
        displayName: "Gemini 3.8 Pro Preview",
        modelName: "gemini-3.8-pro",
      },
      "claude-sonnet-4-6": {
        displayName: "Claude Sonnet 4.6",
      },
    });

    expect(models["antigravity-gemini-3-flash"]?.variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(models["antigravity-gemini-3.8-flash"]?.variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    // Inferred variants for dynamically discovered models not in static table
    expect(models["antigravity-gemini-3.6-flash"]?.variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(models["antigravity-gemini-3.7-flash"]?.variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(models["antigravity-gemini-3.8-pro"]?.variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });
    expect(models["antigravity-claude-sonnet-4-6"]).toMatchObject({
      name: "Claude Sonnet 4.6 (Antigravity)",
      limit: { context: 200000, output: 64000 },
    });
  });

  it("strips tier suffixes from grouped Gemini 4 display names", () => {
    const models = modelsFromAntigravityAvailableModels({
      "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", supportsThinking: true },
      "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", supportsThinking: true },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsThinking: true },
    });

    expect(models["antigravity-gemini-4-hydrogen"]).toMatchObject({
      name: "Gemini 4 Hydrogen (Antigravity)",
      variants: {
        high: { thinkingLevel: "high" },
        xhigh: { thinkingLevel: "xhigh" },
      },
    });
    expect(models["antigravity-gemini-4-argon"]).toMatchObject({
      name: "Gemini 4 Argon (Antigravity)",
      variants: {
        medium: { thinkingLevel: "medium" },
      },
    });
  });

  it("excludes internal tiered and worker registry entries", () => {
    const models = modelsFromAntigravityAvailableModels({
      "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", supportsThinking: true },
      "gemini-4-hydrogen-tiered-high": { displayName: "Gemini 4 Hydrogen (High)", supportsThinking: true },
      "gemini-4-hydrogen-tiered-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", supportsThinking: true },
      "gemini-flash-worker-agy": { displayName: "Gemini 4 Hydrogen (Orchestrator)", supportsThinking: true },
      "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash", supportsThinking: true },
    });

    expect(Object.keys(models)).toEqual(["antigravity-gemini-4-hydrogen"]);
  });

  it("groups tiered Gemini 3.8 Flash and Claude 5.5 entries into single models with variants", () => {
    const models = modelsFromAntigravityAvailableModels({
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsThinking: true },
      "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", supportsThinking: true },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true },
      "claude-opus-5-5-low": { displayName: "Claude Opus 5.5 (Low)", supportsThinking: true },
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", supportsThinking: true },
      "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)", supportsThinking: true },
      "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)", supportsThinking: true },
      "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 (High)", supportsThinking: true },
    });

    expect(Object.keys(models).sort()).toEqual([
      "antigravity-claude-opus-5-5",
      "antigravity-claude-sonnet-5-5",
      "antigravity-gemini-3.8-flash",
    ]);
    expect(models["antigravity-gemini-3.8-flash"]).toMatchObject({
      name: "Gemini 3.8 Flash (Antigravity)",
      temperature: false,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    });
    expect(models["antigravity-claude-opus-5-5"]).toMatchObject({
      name: "Claude Opus 5.5 (Antigravity)",
      limit: { context: 1000000, output: 128000 },
      variants: {
        low: { thinkingLevel: "low" },
        high: { thinkingLevel: "high" },
      },
    });
    expect(models["antigravity-claude-sonnet-5-5"]).toMatchObject({
      name: "Claude Sonnet 5.5 (Antigravity)",
      limit: { context: 1000000, output: 128000 },
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    });
  });
});
