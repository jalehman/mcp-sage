/* Centralised model constants and logic */

import { analyzeXmlTokens } from "./tokenCounter";
import { sendGeminiPrompt, GEMINI_TOKEN_LIMIT } from "./gemini";
import { sendOpenAiPrompt, O3_MODEL_NAME, O3_TOKEN_LIMIT } from "./openai";

export interface ModelSelection {
  modelName: string;
  modelType: "openai" | "gemini";
  tokenCount: number;
  withinLimit: boolean;
  tokenLimit: number;
}

/*----------------------------------------------------------------------------
  Model‑selection helper
----------------------------------------------------------------------------*/
export function selectModelBasedOnTokens(combined: string): ModelSelection {
  const { totalTokens: tokenCount } = analyzeXmlTokens(combined);
  const hasOpenAiKey  = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey  = !!process.env.GEMINI_API_KEY;

  /* Prefer O3 when it fits and key is available */
  if (tokenCount <= O3_TOKEN_LIMIT && hasOpenAiKey) {
    return {
      modelName: O3_MODEL_NAME,
      modelType: "openai",
      tokenCount,
      withinLimit: true,
      tokenLimit: O3_TOKEN_LIMIT,
    };
  }

  /* Fallback to Gemini when it fits and key is available */
  if (tokenCount <= GEMINI_TOKEN_LIMIT && hasGeminiKey) {
    return {
      modelName: "gemini-2.5-pro-preview-03-25",
      modelType: "gemini",
      tokenCount,
      withinLimit: true,
      tokenLimit: GEMINI_TOKEN_LIMIT,
    };
  }

  /* — Error branches — */
  if (!hasOpenAiKey && !hasGeminiKey) {
    return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: 0 };
  }
  if (!hasOpenAiKey && tokenCount <= O3_TOKEN_LIMIT) {
    return { modelName: "none", modelType: "openai", tokenCount, withinLimit: false, tokenLimit: O3_TOKEN_LIMIT };
  }
  if (!hasGeminiKey && tokenCount > O3_TOKEN_LIMIT) {
    return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: GEMINI_TOKEN_LIMIT };
  }

  /* Exhausted all limits */
  return { modelName: "none", modelType: "gemini", tokenCount, withinLimit: false, tokenLimit: GEMINI_TOKEN_LIMIT };
}

/*----------------------------------------------------------------------------
  Fallback‑aware dispatcher
----------------------------------------------------------------------------*/
export async function sendToModelWithFallback(
  combined: string,
  { modelName, modelType, tokenCount }: Pick<ModelSelection, "modelName" | "modelType" | "tokenCount">,
  sendNotification: (n: any) => Promise<void>,
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
      return await sendOpenAiPrompt(combined, { model: modelName }, notifyAdapter);
    }

    await sendNotification({ method: "notifications/message", params: { level: "info", data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…` } });
    return await sendGeminiPrompt(combined);

  } catch (error) {
    /* Network‑level fallback from O3 ➜ Gemini */
    if (
      modelType === "openai" &&
      process.env.GEMINI_API_KEY &&
      tokenCount <= GEMINI_TOKEN_LIMIT &&
      error instanceof Error &&
      error.message.includes("OpenAI API unreachable")
    ) {
      await sendNotification({ method: "notifications/message", params: { level: "warning", data: "OpenAI API unreachable. Falling back to Gemini…" } });
      await sendNotification({ method: "notifications/message", params: { level: "info", data: `Sending request to Gemini with ${tokenCount.toLocaleString()} tokens…` } });
      return await sendGeminiPrompt(combined);
    }
    throw error;
  }
}

/* Re‑export constants so callers can simply `import { … } from "./modelManager"` */
export { GEMINI_TOKEN_LIMIT, O3_MODEL_NAME, O3_TOKEN_LIMIT };