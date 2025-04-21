import OpenAI from 'openai';

// Model constants
export const O3_MODEL_NAME = 'o3-2025-04-16'; // OpenAI's O3 model with 200k context
export const O3_TOKEN_LIMIT = 200000; // 200k token context window

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
 * Sends a prompt to the OpenAI API and returns the response
 * @param prompt - The text prompt to send
 * @param options - Configuration options for the request
 * @returns The text response from the OpenAI API
 */
export async function sendOpenAiPrompt(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number; // Maps to max_tokens in OpenAI API
  } = {}
): Promise<string> {
  const client = getOpenaiClient();
  const model = options.model || O3_MODEL_NAME;

  try {
    const completion = await client.chat.completions.create({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxOutputTokens,
    });

    const textResponse = completion.choices[0]?.message?.content;

    if (!textResponse) {
      throw new Error('No text response received from OpenAI API');
    }
    return textResponse;

  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    
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
      throw error;
    }
    
    throw new Error(String(error));
  }
}