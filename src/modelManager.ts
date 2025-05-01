/* Centralised model management logic */

import { analyzeXmlTokens } from "./tokenCounter";
import { sendGeminiPrompt } from "./gemini";
import { sendOpenAiPrompt } from "./openai";
import { 
  ModelType, 
  ModelConfig,
  Models,
  O3_MODEL_NAME,
  O3_TOKEN_LIMIT,
  GEMINI_MODEL_NAME,
  GEMINI_TOKEN_LIMIT 
} from "./modelDefinitions";

// Re-export model types and definitions for convenience
export { 
  ModelType, 
  ModelConfig,
  Models,
  O3_MODEL_NAME,
  O3_TOKEN_LIMIT,
  GEMINI_MODEL_NAME,
  GEMINI_TOKEN_LIMIT 
};

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
 * Get available models with their capabilities
 */
export function getAvailableModels(): ModelConfig[] {
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  
  const availableModels: ModelConfig[] = [];
  
  if (hasOpenAiKey) {
    availableModels.push({ ...Models.O3, available: true });
    availableModels.push({ ...Models.GPT41, available: true });
  }
  
  if (hasGeminiKey) {
    availableModels.push({ ...Models.GEMINI, available: true });
  }
  
  return availableModels;
}

/*----------------------------------------------------------------------------
  Model‑selection helper
----------------------------------------------------------------------------*/
export function selectModelBasedOnTokens(combined: string): ModelSelection {
  const { totalTokens: tokenCount } = analyzeXmlTokens(combined);
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;

  // First try O3 (preferred for smaller contexts)
  if (tokenCount <= Models.O3.tokenLimit && hasOpenAiKey) {
    return {
      modelName: Models.O3.name,
      modelType: Models.O3.type,
      tokenCount,
      withinLimit: true,
      tokenLimit: Models.O3.tokenLimit,
    };
  }

  // Then try GPT-4.1 if available and within limits
  if (tokenCount <= Models.GPT41.tokenLimit && hasOpenAiKey) {
    return {
      modelName: Models.GPT41.name,
      modelType: Models.GPT41.type,
      tokenCount,
      withinLimit: true,
      tokenLimit: Models.GPT41.tokenLimit,
    };
  }

  // Fallback to Gemini when it fits and key is available
  if (tokenCount <= Models.GEMINI.tokenLimit && hasGeminiKey) {
    return {
      modelName: Models.GEMINI.name,
      modelType: Models.GEMINI.type,
      tokenCount,
      withinLimit: true,
      tokenLimit: Models.GEMINI.tokenLimit,
    };
  }

  /* — Error branches — */
  if (!hasOpenAiKey && !hasGeminiKey) {
    return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: 0 };
  }
  if (!hasOpenAiKey && tokenCount <= Models.O3.tokenLimit) {
    return { modelName: "none", modelType: "openai", tokenCount, withinLimit: false, tokenLimit: Models.O3.tokenLimit };
  }
  if (!hasGeminiKey && tokenCount > Models.O3.tokenLimit) {
    return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: Models.GEMINI.tokenLimit };
  }

  /* Exhausted all limits */
  return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: Models.GEMINI.tokenLimit };
}

/*----------------------------------------------------------------------------
  Fallback‑aware dispatcher
----------------------------------------------------------------------------*/
export async function sendToModelWithFallback(
  combined: string,
  { modelName, modelType, tokenCount }: Pick<ModelSelection, "modelName" | "modelType" | "tokenCount">,
  sendNotification: (n: any) => Promise<void>,
  abortSignal?: AbortSignal
): Promise<string> {
  try {
    // Helper function to adapt our notification format to what openai.ts expects
    const notifyAdapter = async (message: {level: 'info' | 'warning' | 'error' | 'debug'; data: string}) => {
      await sendNotification({ 
        method: "notifications/message", 
        params: message 
      });
    };
    
    if (modelType === "openai") {
      await sendNotification({ method: "notifications/message", params: { level: "info", data: `Sending request to OpenAI ${modelName} with ${tokenCount.toLocaleString()} tokens…` } });
      // Pass the notification adapter to handle rate limit retries
      return await sendOpenAiPrompt(combined, { model: modelName }, notifyAdapter, abortSignal);
    }

    await sendNotification({ method: "notifications/message", params: { level: "info", data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…` } });
    return await sendGeminiPrompt(combined, { model: modelName }, abortSignal);

  } catch (error) {
    /* Network‑level fallback logic */
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;
    
    // OpenAI to Gemini fallback
    if (
      modelType === "openai" &&
      hasGeminiKey &&
      tokenCount <= Models.GEMINI.tokenLimit &&
      error instanceof Error &&
      error.message.includes("OpenAI API unreachable")
    ) {
      await sendNotification({ method: "notifications/message", params: { level: "warning", data: "OpenAI API unreachable. Falling back to Gemini…" } });
      await sendNotification({ method: "notifications/message", params: { level: "info", data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…` } });
      return await sendGeminiPrompt(combined, {}, abortSignal);
    }
    
    // Other model-specific fallbacks could be added here
    
    throw error;
  }
}