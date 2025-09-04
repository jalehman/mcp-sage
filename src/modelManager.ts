/* Centralised model management logic */

import { analyzeXmlTokens } from "./tokenCounter";
import { sendGeminiPrompt } from "./gemini";
import { sendOpenAiPrompt } from "./openai";
import { sendAnthropicPrompt } from "./anthropic";
import {
  ModelType,
  ModelConfig,
  Models,
  O3_MODEL_NAME,
  O3_TOKEN_LIMIT,
  GPT5_MODEL_NAME,
  GPT5_TOKEN_LIMIT,
  GEMINI_MODEL_NAME,
  GEMINI_TOKEN_LIMIT,
  OPUS41_MODEL_NAME,
  OPUS41_TOKEN_LIMIT,
} from "./modelDefinitions";

// Re-export model types and definitions for convenience
export {
  ModelType,
  ModelConfig,
  Models,
  O3_MODEL_NAME,
  O3_TOKEN_LIMIT,
  GPT5_MODEL_NAME,
  GPT5_TOKEN_LIMIT,
  GEMINI_MODEL_NAME,
  GEMINI_TOKEN_LIMIT,
  OPUS41_MODEL_NAME,
  OPUS41_TOKEN_LIMIT,
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
    availableModels.push({ ...Models.GPT5, available: true });
  }

  if (hasGeminiKey) {
    availableModels.push({ ...Models.GEMINI, available: true });
  }

  // TODO: but what if I want it as a participant? Best behavior is having the judging model not be a participant. How to encode that?

  // Note: Claude Opus 4.1 is not included here as it's only used for judging,
  // not as a debate participant

  return availableModels;
}

/*----------------------------------------------------------------------------
  Model‑selection helper
----------------------------------------------------------------------------*/
export function selectModelBasedOnTokens(combined: string): ModelSelection {
  const { totalTokens: tokenCount } = analyzeXmlTokens(combined);
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;

  // First try GPT5 (preferred for smaller contexts)
  if (tokenCount <= Models.GPT5.tokenLimit && hasOpenAiKey) {
    return {
      modelName: Models.GPT5.name,
      modelType: Models.GPT5.type,
      tokenCount,
      withinLimit: true,
      tokenLimit: Models.GPT5.tokenLimit,
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
    return {
      modelName: "none",
      modelType: "gemini",
      tokenCount,
      withinLimit: false,
      tokenLimit: 0,
    };
  }
  if (!hasOpenAiKey && tokenCount <= Models.GPT5.tokenLimit) {
    return {
      modelName: "none",
      modelType: "openai",
      tokenCount,
      withinLimit: false,
      tokenLimit: Models.GPT5.tokenLimit,
    };
  }
  if (!hasGeminiKey && tokenCount > Models.GPT5.tokenLimit) {
    return {
      modelName: "none",
      modelType: "gemini",
      tokenCount,
      withinLimit: false,
      tokenLimit: Models.GEMINI.tokenLimit,
    };
  }

  /* Exhausted all limits */
  return {
    modelName: "none",
    modelType: "gemini",
    tokenCount,
    withinLimit: false,
    tokenLimit: Models.GEMINI.tokenLimit,
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
      tokenCount <= Models.GEMINI.tokenLimit &&
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
      return await sendGeminiPrompt(combined, {}, abortSignal, notifyAdapter);
    }

    // Other model-specific fallbacks could be added here

    throw error;
  }
}
