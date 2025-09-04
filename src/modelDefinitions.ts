/**
 * Model Definitions
 *
 * Central repository for model constants and type definitions.
 * This module contains no logic, only definitions, so it can be
 * imported by any module without creating circular dependencies.
 */

/**
 * Model type definition
 */
export type ModelType = "openai" | "gemini" | "anthropic";

/**
 * Model information and capabilities
 */
export interface ModelConfig {
  name: string;
  type: ModelType;
  tokenLimit: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  available?: boolean;
  defaultParams?: Record<string, any>;
}

/**
 * Centralized model registry
 */
export const Models = {
  O3: {
    name: "o3-2025-04-16",
    type: "openai" as ModelType,
    tokenLimit: 200000,
    costPerInputToken: 10 / 1000000, // $10.00 per 1M input tokens
    costPerOutputToken: 40 / 1000000, // $40.00 per 1M output tokens
  },
  GPT41: {
    name: "gpt-4.1-2025-04-14",
    type: "openai" as ModelType,
    tokenLimit: 1047576, // ~1M tokens context window (exact 1,047,576)
    costPerInputToken: 2 / 1000000, // $2.00 per 1M input tokens
    costPerOutputToken: 8 / 1000000, // $8.00 per 1M output tokens
  },
  GEMINI: {
    name: "gemini-2.5-pro",
    type: "gemini" as ModelType,
    tokenLimit: 1000000,
    costPerInputToken: 2 / 1000000, // approximation; varies based on input size
    costPerOutputToken: 12 / 1000000, // approximation; varies based on input size
  },
  GPT5: {
    name: "gpt-5-2025-08-07",
    type: "openai" as ModelType,
    tokenLimit: 400000,
    costPerInputToken: 1.25 / 1000000,
    costPerOutputToken: 10 / 1000000,
  },
  OPUS41: {
    name: "claude-opus-4-1-20250805",
    type: "anthropic" as ModelType,
    tokenLimit: 200000,
    costPerInputToken: 15 / 1000000, // $15.00 per 1M input tokens
    costPerOutputToken: 75 / 1000000, // $75.00 per 1M output tokens
  },
};

// Constants for backward compatibility
export const O3_MODEL_NAME = Models.O3.name;
export const O3_TOKEN_LIMIT = Models.O3.tokenLimit;
export const GPT5_MODEL_NAME = Models.GPT5.name;
export const GPT5_TOKEN_LIMIT = Models.GPT5.tokenLimit;
export const GEMINI_MODEL_NAME = Models.GEMINI.name;
export const GEMINI_TOKEN_LIMIT = Models.GEMINI.tokenLimit;
export const OPUS41_MODEL_NAME = Models.OPUS41.name;
export const OPUS41_TOKEN_LIMIT = Models.OPUS41.tokenLimit;
