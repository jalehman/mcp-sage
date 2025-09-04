/* Centralised model management logic */

import { analyzeXmlTokens } from "./tokenCounter";
import { sendGeminiPrompt } from "./gemini";
import { sendOpenAiPrompt } from "./openai";
import { sendAnthropicPrompt } from "./anthropic";
import { ModelType, ModelConfig } from "./modelDefinitions";
import { getModelById, getToolConfig, getDefaults } from "./modelConfig";

// Re-export model types for convenience
export { ModelType, ModelConfig };

/**
 * Model selection result
 */
export interface ModelSelection {
  modelName: string;
  modelType: ModelType;
  tokenCount: number;
  withinLimit: boolean;
  tokenLimit: number;
}

/**
 * Model selection result
 */
export interface ModelSelection {
  modelName: string;
  modelType: ModelType;
  tokenCount: number;
  withinLimit: boolean;
  tokenLimit: number;
}

/**
 * Get available models for debate participation
 */
export function getAvailableModels(toolType: 'opinion' | 'review' = 'opinion'): ModelConfig[] {
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

  const toolConfig = getToolConfig(toolType);
  const availableModels: ModelConfig[] = [];

  // Only include models that are configured as debate participants
  for (const modelId of toolConfig.debateParticipants) {
    const model = getModelById(modelId);
    if (!model) continue;
    
    // Check if we have the required API key
    const hasKey = 
      (model.type === 'openai' && hasOpenAiKey) ||
      (model.type === 'gemini' && hasGeminiKey) ||
      (model.type === 'anthropic' && hasAnthropicKey);
    
    if (hasKey) {
      availableModels.push({
        name: model.name,
        type: model.type,
        tokenLimit: model.tokenLimit,
        costPerInputToken: model.costPerInputToken,
        costPerOutputToken: model.costPerOutputToken,
        available: true,
      });
    }
  }

  return availableModels;
}

/*----------------------------------------------------------------------------
  Model‑selection helper
----------------------------------------------------------------------------*/
export function selectModelBasedOnTokens(
  combined: string,
  toolType: 'opinion' | 'review' = 'opinion'
): ModelSelection {
  const { totalTokens: tokenCount } = analyzeXmlTokens(combined);
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

  const toolConfig = getToolConfig(toolType);
  
  // Try models in the preferred order specified in config
  for (const modelId of toolConfig.preferredModels) {
    const model = getModelById(modelId);
    if (!model) continue;
    
    // Check if we have the required API key
    const hasKey = 
      (model.type === 'openai' && hasOpenAiKey) ||
      (model.type === 'gemini' && hasGeminiKey) ||
      (model.type === 'anthropic' && hasAnthropicKey);
    
    // Check if model fits within token limit
    if (hasKey && tokenCount <= model.tokenLimit) {
      return {
        modelName: model.name,
        modelType: model.type,
        tokenCount,
        withinLimit: true,
        tokenLimit: model.tokenLimit,
      };
    }
  }

  // If no model fits, return error with largest available limit
  let largestLimit = 0;
  let failureType: ModelType = 'openai';
  
  for (const modelId of toolConfig.preferredModels) {
    const model = getModelById(modelId);
    if (model && model.tokenLimit > largestLimit) {
      largestLimit = model.tokenLimit;
      failureType = model.type;
    }
  }

  return {
    modelName: "none",
    modelType: failureType,
    tokenCount,
    withinLimit: false,
    tokenLimit: largestLimit,
  };
}

/*----------------------------------------------------------------------------
  Fallback‑aware dispatcher
----------------------------------------------------------------------------*/
export async function sendToModelWithFallback(
  combined: string,
  {
    modelName,
    modelType,
    tokenCount,
  }: Pick<ModelSelection, "modelName" | "modelType" | "tokenCount">,
  sendNotification: (n: any) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<string> {
  // Helper function to adapt our notification format to what openai.ts expects
  const notifyAdapter = async (message: {
    level: "info" | "warning" | "error" | "debug";
    data: string;
  }) => {
    // Check if sendNotification is already expecting our internal format
    if (
      typeof sendNotification === "function" &&
      sendNotification.length === 1
    ) {
      try {
        // If this is the raw notification handler from debateOrchestrator
        await sendNotification(message);
      } catch (e) {
        // Fall back to the wrapped format if direct call fails
        await sendNotification({
          method: "notifications/message",
          params: message,
        });
      }
    } else {
      // Default behavior - wrap in MCP notification format
      await sendNotification({
        method: "notifications/message",
        params: message,
      });
    }
  };

  try {
    if (modelType === "openai") {
      await sendNotification({
        method: "notifications/message",
        params: {
          level: "info",
          data: `Sending request to OpenAI ${modelName} with ${tokenCount.toLocaleString()} tokens…`,
        },
      });
      // Pass the notification adapter to handle rate limit retries
      return await sendOpenAiPrompt(
        combined,
        { model: modelName },
        notifyAdapter,
        abortSignal,
      );
    }

    if (modelType === "anthropic") {
      await sendNotification({
        method: "notifications/message",
        params: {
          level: "info",
          data: `Sending request to Anthropic ${modelName} with ${tokenCount.toLocaleString()} tokens…`,
        },
      });
      return await sendAnthropicPrompt(
        combined,
        { model: modelName },
        abortSignal,
        notifyAdapter,
      );
    }

    await sendNotification({
      method: "notifications/message",
      params: {
        level: "info",
        data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…`,
      },
    });
    return await sendGeminiPrompt(
      combined,
      { model: modelName },
      abortSignal,
      notifyAdapter,
    );
  } catch (error) {
    /* Network‑level fallback logic */
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;

    // OpenAI to Gemini fallback
    if (
      modelType === "openai" &&
      hasGeminiKey &&
      tokenCount <= 1000000 && // Gemini's typical limit
      error instanceof Error &&
      error.message.includes("OpenAI API unreachable")
    ) {
      await sendNotification({
        method: "notifications/message",
        params: {
          level: "warning",
          data: "OpenAI API unreachable. Falling back to Gemini…",
        },
      });
      await sendNotification({
        method: "notifications/message",
        params: {
          level: "info",
          data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…`,
        },
      });
      // Use Gemini as fallback - get the model name from config
      const geminiModel = getModelById('gemini25pro');
      const modelName = geminiModel ? geminiModel.name : 'gemini-2.5-pro';
      return await sendGeminiPrompt(combined, { model: modelName }, abortSignal, notifyAdapter);
    }

    // Other model-specific fallbacks could be added here

    throw error;
  }
}
