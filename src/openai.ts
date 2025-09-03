import OpenAI from 'openai';
import { O3_MODEL_NAME } from './modelDefinitions';

/**
 * Creates a fresh OpenAI client instance for each request
 * This prevents any possibility of key corruption or caching issues
 * 
 * @returns Initialized OpenAI client
 * @throws Error if OPENAI_API_KEY is not set
 */
function getOpenaiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  
  // Sanitized logging to help debug key issues only in development
  // We'll use stderr to avoid interfering with JSON output
  if (process.env.DEBUG_API_KEYS) {
    const firstPart = apiKey.substring(0, 7);
    const lastPart = apiKey.substring(apiKey.length - 4);
    console.error(`Using OpenAI API key: ${firstPart}...${lastPart}`);
  }
  
  // Always create a fresh client to avoid any key caching/mixing issues
  return new OpenAI({ apiKey });
}

/**
 * Parse the reset time from OpenAI headers
 * @param resetHeader X-RateLimit-Reset-Tokens header value (e.g. "30s", "1m20s")
 * @returns Time in milliseconds until reset
 */
function parseResetTime(resetHeader: string): number {
  let totalMs = 0;
  
  // Check for minutes (e.g. "1m20s")
  const minutesMatch = resetHeader.match(/(\d+)m/);
  if (minutesMatch) {
    totalMs += parseInt(minutesMatch[1], 10) * 60 * 1000;
  }
  
  // Check for seconds (e.g. "30s" or "1m30s")
  const secondsMatch = resetHeader.match(/(\d+)s/);
  if (secondsMatch) {
    totalMs += parseInt(secondsMatch[1], 10) * 1000;
  }
  
  // If no time format recognized, default to 60 seconds
  if (totalMs === 0) {
    totalMs = 60 * 1000;
  }
  
  // Add a small buffer (10%) to be safe
  return Math.ceil(totalMs * 1.1);
}

/**
 * Sends a prompt to the OpenAI API and returns the response
 * @param prompt - The text prompt to send
 * @param options - Configuration options for the request
 * @param notifyFn - Optional function to send notifications (for rate limit info)
 * @returns The text response from the OpenAI API
 */
export async function sendOpenAiPrompt(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number; // Maps to max_tokens in OpenAI API
  } = {},
  notifyFn?: (message: {level: 'info' | 'warning' | 'error' | 'debug'; data: string}) => Promise<void>,
  abortSignal?: AbortSignal
): Promise<string> {
  // Debug logging via stderr to help trace execution flow
  console.error(`[DEBUG-OpenAI] Starting sendOpenAiPrompt with model: ${options.model || O3_MODEL_NAME}`);
  console.error(`[DEBUG-OpenAI] Prompt length: ${prompt.length}, Has notify function: ${!!notifyFn}, Has signal: ${!!abortSignal}`);
  
  const client = getOpenaiClient();
  const model = options.model || O3_MODEL_NAME;
  
  // Maximum retry attempts
  const maxRetries = 3;
  let retries = 0;
  
  // A hard timeout is now provided by the AbortSignal from the debateOrchestrator
  
  // Helper function to send notifications if notifyFn is provided
  const notify = async (level: 'info' | 'warning' | 'error' | 'debug', message: string) => {
    if (notifyFn) {
      await notifyFn({ level, data: message });
    }
  };
  
  // Log request start details including timeout info
  if (notifyFn) {
    await notifyFn({ level: 'debug', data: `OpenAI request starting for ${model} with timeout: ${abortSignal ? 'signal provided' : 'no signal'}` });
  }

  while (true) {
    try {
      if (notifyFn) {
        await notifyFn({ level: 'debug', data: `Sending request to OpenAI API (${model})...` });
      }

      console.error(`[DEBUG-OpenAI] About to call chat.completions.create with model: ${model}`);
      
      const completion = await client.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature,
        top_p: options.topP,
        max_tokens: options.maxOutputTokens,
      }, { signal: abortSignal });
      
      console.error(`[DEBUG-OpenAI] API call returned successfully`);
      

      const textResponse = completion.choices[0]?.message?.content;

      if (!textResponse) {
        throw new Error('No text response received from OpenAI API');
      }
      return textResponse;

    } catch (error) {
      // Add detailed abort signal logging
      const errorObj = error as any;
      
      // Check specifically for AbortError or abort-related messages
      if ((error as Error).name === 'AbortError' || 
          (error instanceof Error && error.message.includes('abort'))) {
        await notify('debug', `OpenAI request aborted: ${(error as Error).message}`);
        throw new Error(`OpenAI request aborted: The request exceeded the configured timeout or was manually cancelled`);
      }

      // Check if it's a rate limit error (429 status code)
      if (errorObj.status === 429 && 
          errorObj.error?.type === 'tokens' && 
          retries < maxRetries) {
        
        retries++;
        await notify('warning', `Rate limit exceeded (retry ${retries}/${maxRetries})`);
        
        // Extract reset time from error response if available
        let waitTime = 60 * 1000; // Default: 60 seconds
        
        // Try to extract headers from error object
        if (errorObj.headers && errorObj.headers['x-ratelimit-reset-tokens']) {
          waitTime = parseResetTime(errorObj.headers['x-ratelimit-reset-tokens']);
          await notify('info', `Waiting ${waitTime}ms based on rate limit headers before retrying...`);
        } else {
          await notify('info', `Rate limit headers not found, using default wait time of ${waitTime}ms...`);
        }
        
        // Wait for the rate limit reset before retrying
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Handle network connectivity issues specially
      if (error instanceof Error) {
        const errorString = error.toString().toLowerCase();
        if (
          errorString.includes('enotfound') || 
          errorString.includes('connection error') || 
          errorString.includes('network') ||
          errorString.includes('timeout')
        ) {
          throw new Error(`OpenAI API unreachable: Network connectivity issue. Check your internet connection or try Gemini instead.`);
        }
      }
      
      // Log any other errors
      await notify('error', `OpenAI API error (${model}): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}