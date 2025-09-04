/**
 * Model Configuration Loader
 * 
 * Loads and parses the YAML configuration file for model definitions
 * and tool-specific settings.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ModelType } from './modelDefinitions';

/**
 * Model definition from YAML
 */
export interface ModelDef {
  name: string;
  type: ModelType;
  tokenLimit: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}

/**
 * Tool-specific configuration
 */
export interface ToolConfig {
  debateParticipants: string[];
  judgeModel: string;
  preferredModels: string[];
}

/**
 * Default settings
 */
export interface DefaultSettings {
  maxOutputTokens: number;
  temperature: number;
  enableFallback: boolean;
}

/**
 * Complete configuration structure
 */
export interface ModelConfiguration {
  models: Record<string, ModelDef>;
  tools: {
    opinion: ToolConfig;
    review: ToolConfig;
  };
  defaults: DefaultSettings;
}

/**
 * Singleton configuration instance
 */
let configInstance: ModelConfiguration | null = null;

/**
 * Load the model configuration from YAML file
 */
export function loadModelConfig(): ModelConfiguration {
  if (configInstance) {
    return configInstance;
  }

  const configPath = path.join(process.cwd(), 'models.yaml');
  
  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContents) as ModelConfiguration;
    
    // Validate the configuration
    validateConfig(config);
    
    // Cache the configuration
    configInstance = config;
    
    return config;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('FATAL: models.yaml configuration file not found. This file is required for the server to start.');
    }
    
    throw new Error(`Failed to load model configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate the loaded configuration
 */
function validateConfig(config: ModelConfiguration): void {
  if (!config.models || typeof config.models !== 'object') {
    throw new Error('Invalid configuration: missing models section');
  }
  
  if (!config.tools || !config.tools.opinion || !config.tools.review) {
    throw new Error('Invalid configuration: missing tools section');
  }
  
  // Validate that referenced models exist
  for (const tool of ['opinion', 'review'] as const) {
    const toolConfig = config.tools[tool];
    
    // Check debate participants
    for (const modelId of toolConfig.debateParticipants) {
      if (!config.models[modelId]) {
        throw new Error(`Invalid configuration: model '${modelId}' referenced in ${tool}.debateParticipants does not exist`);
      }
    }
    
    // Check judge model
    if (!config.models[toolConfig.judgeModel]) {
      throw new Error(`Invalid configuration: judge model '${toolConfig.judgeModel}' for ${tool} does not exist`);
    }
    
    // Check preferred models
    for (const modelId of toolConfig.preferredModels) {
      if (!config.models[modelId]) {
        throw new Error(`Invalid configuration: model '${modelId}' referenced in ${tool}.preferredModels does not exist`);
      }
    }
  }
}

/**
 * Get model definition by ID
 */
export function getModelById(modelId: string): ModelDef | undefined {
  const config = loadModelConfig();
  return config.models[modelId];
}

/**
 * Get tool configuration
 */
export function getToolConfig(tool: 'opinion' | 'review'): ToolConfig {
  const config = loadModelConfig();
  return config.tools[tool];
}

/**
 * Get default settings
 */
export function getDefaults(): DefaultSettings {
  const config = loadModelConfig();
  return config.defaults;
}

/**
 * Get all available model IDs
 */
export function getAllModelIds(): string[] {
  const config = loadModelConfig();
  return Object.keys(config.models);
}

/**
 * Reset the configuration cache (useful for testing)
 */
export function resetConfigCache(): void {
  configInstance = null;
}