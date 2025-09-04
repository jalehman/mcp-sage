/**
 * Model Definitions
 *
 * This module now serves as a bridge to the YAML configuration.
 * All model definitions are loaded from models.yaml.
 */

import { loadModelConfig, getModelById } from './modelConfig';

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
 * Get Models object from configuration
 * This provides backward compatibility for existing code
 */
function getModels(): Record<string, ModelConfig> {
  const config = loadModelConfig();
  const models: Record<string, ModelConfig> = {};
  
  // Map from config format to legacy format
  for (const [id, modelDef] of Object.entries(config.models)) {
    models[id.toUpperCase()] = {
      name: modelDef.name,
      type: modelDef.type,
      tokenLimit: modelDef.tokenLimit,
      costPerInputToken: modelDef.costPerInputToken,
      costPerOutputToken: modelDef.costPerOutputToken,
    };
  }
  
  return models;
}

/**
 * Centralized model registry - loaded from YAML
 */
export const Models = getModels();

/**
 * Helper function to get model by ID from YAML config
 */
export function getModel(modelId: string): ModelConfig | undefined {
  const modelDef = getModelById(modelId.toLowerCase());
  if (!modelDef) return undefined;
  
  return {
    name: modelDef.name,
    type: modelDef.type,
    tokenLimit: modelDef.tokenLimit,
    costPerInputToken: modelDef.costPerInputToken,
    costPerOutputToken: modelDef.costPerOutputToken,
  };
}