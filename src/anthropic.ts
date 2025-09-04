import Anthropic from "@anthropic-ai/sdk";
import { getProviderDefaultModel, getModelById } from "./modelConfig";

/**
 * Creates a fresh Anthropic client instance for each request
 * This prevents any possibility of key corruption or caching issues
 *
 * @returns Initialized Anthropic client
 * @throws Error if ANTHROPIC_API_KEY is not set
 */
function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  // Sanitized logging to help debug key issues only in development
  // We'll use stderr to avoid interfering with JSON output
  if (process.env.DEBUG_API_KEYS) {
    const firstPart = apiKey.substring(0, 7);
    const lastPart = apiKey.substring(apiKey.length - 4);
    console.error(`Using Anthropic API key: ${firstPart}...${lastPart}`);
  }

  // Always create a fresh client to avoid any key caching/mixing issues
  return new Anthropic({ apiKey });
}

/**
 * Sends a prompt to the Anthropic API and returns the response
 * @param prompt - The text prompt to send
 * @param options - Configuration options for the request
 * @param abortSignal - Optional abort signal for cancellation
 * @param notifyFn - Optional function to send notifications
 * @returns The text response from the Anthropic API
 */
export async function sendAnthropicPrompt(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxOutputTokens?: number; // Maps to max_tokens in Anthropic API
  } = {},
  abortSignal?: AbortSignal,
  notifyFn?: (message: {
    level: "info" | "warning" | "error" | "debug";
    data: string;
  }) => Promise<void>,
): Promise<string> {
  // Debug logging via stderr to help trace execution flow
  if (notifyFn) {
    await notifyFn({
      level: "debug",
      data: `[DEBUG-Anthropic] Starting sendAnthropicPrompt with model: ${options.model || getDefaultAnthropicModel()}`,
    });
    await notifyFn({
      level: "debug",
      data: `[DEBUG-Anthropic] Prompt length: ${prompt.length}, Has notify function: ${!!notifyFn}, Has signal: ${!!abortSignal}`,
    });
  }

  const client = getAnthropicClient();
  const model = options.model || getDefaultAnthropicModel();

  // Maximum retry attempts
  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      if (notifyFn) {
        await notifyFn({
          level: "debug",
          data: `[DEBUG-Anthropic] About to call messages.create with model: ${model}`,
        });
      }

      const completion = await client.messages.create({
        model,
        max_tokens: options.maxOutputTokens || 8192,
        temperature: options.temperature ?? 0,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      if (notifyFn) {
        await notifyFn({
          level: "debug",
          data: `[DEBUG-Anthropic] Received response with ${completion.usage?.input_tokens} input tokens, ${completion.usage?.output_tokens} output tokens`,
        });
      }

      // Extract text from the response
      const textContent = completion.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (!textContent) {
        throw new Error("No text content in Anthropic response");
      }

      return textContent;
    } catch (error) {
      retries++;

      // Check if the error is due to cancellation
      if (abortSignal?.aborted) {
        throw new Error("Anthropic request was cancelled");
      }

      // Handle rate limit errors
      if (
        error instanceof Anthropic.APIError &&
        error.status === 429
      ) {
        // Extract retry-after time if available
        const retryAfter = error.headers?.["retry-after"];
        const waitTime = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : 60 * 1000; // Default to 60 seconds

        if (notifyFn) {
          await notifyFn({
            level: "warning",
            data: `[DEBUG-Anthropic] Rate limited. Waiting ${waitTime / 1000} seconds before retry ${retries}/${maxRetries}`,
          });
        }

        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }
      }

      // Re-throw other errors or if max retries exceeded
      if (notifyFn) {
        await notifyFn({
          level: "error",
          data: `[DEBUG-Anthropic] Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded for Anthropic API call");
}

/**
 * Get the default Anthropic model from configuration
 */
function getDefaultAnthropicModel(): string {
  const defaultModelId = getProviderDefaultModel('anthropic');
  if (!defaultModelId) {
    throw new Error('No default Anthropic model configured in models.yaml');
  }
  const model = getModelById(defaultModelId);
  if (!model) {
    throw new Error(`Default Anthropic model '${defaultModelId}' not found in models.yaml`);
  }
  return model.name;
}