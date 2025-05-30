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
export type ModelType = "openai" | "gemini";

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
    name: "gemini-2.5-pro-preview-03-25",
    type: "gemini" as ModelType,
    tokenLimit: 1000000,
    costPerInputToken: 2 / 1000000, // approximation; varies based on input size
    costPerOutputToken: 12 / 1000000, // approximation; varies based on input size
  },
};

// Constants for backward compatibility
export const O3_MODEL_NAME = Models.O3.name;
export const O3_TOKEN_LIMIT = Models.O3.tokenLimit;
export const GEMINI_MODEL_NAME = Models.GEMINI.name;
export const GEMINI_TOKEN_LIMIT = Models.GEMINI.tokenLimit;
