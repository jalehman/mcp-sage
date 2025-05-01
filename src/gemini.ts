#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { GEMINI_MODEL_NAME, GEMINI_TOKEN_LIMIT } from './modelDefinitions';

// Define the interface for Gemini API request
interface GeminiRequest {
  contents: {
    parts: {
      text: string;
    }[];
  }[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
  };
}

// Define the interface for Gemini API response
interface GeminiResponse {
  candidates: {
    content: {
      parts: {
        text: string;
      }[];
    };
  }[];
  promptFeedback?: any;
}

export async function sendGeminiPrompt(
  prompt: string, 
  options: { 
    model?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
  } = {},
  abortSignal?: AbortSignal
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  // A hard timeout is now provided by the AbortSignal from the debateOrchestrator
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  // Default to Gemini 2.5 Pro Preview if no model is specified
  const model = options.model || GEMINI_MODEL_NAME;
  
  // Using the v1beta endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  
  const requestBody: GeminiRequest = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ]
  };

  // Add optional generation config if any parameters are provided
  if (Object.keys(options).length > 0) {
    requestBody.generationConfig = {};
    
    if (options.temperature !== undefined) {
      requestBody.generationConfig.temperature = options.temperature;
    }
    
    if (options.topP !== undefined) {
      requestBody.generationConfig.topP = options.topP;
    }
    
    if (options.topK !== undefined) {
      requestBody.generationConfig.topK = options.topK;
    }
    
    if (options.maxOutputTokens !== undefined) {
      requestBody.generationConfig.maxOutputTokens = options.maxOutputTokens;
    }
  }

  try {
    const response = await fetch(`${url}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: abortSignal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json() as GeminiResponse;
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No response candidates returned from the API');
    }

    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw error;
  }
}

// Set up command line interface
const program = new Command();

// Function to list available models
async function listModels(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.models || !Array.isArray(data.models)) {
      throw new Error('Invalid response format from API');
    }

    console.log('Available models:');
    console.log('-----------------');
    
    // Group models by family (Gemini 1.5, 2.0, 2.5, etc)
    const modelsByFamily: Record<string, any[]> = {};
    
    data.models.forEach((model: any) => {
      const name = model.name.replace('models/', '');
      
      // Extract family from name (gemini-1.5, gemini-2.0, etc)
      let family = 'Other';
      const match = name.match(/^(gemini-\d+\.\d+)/);
      if (match) {
        family = match[1];
      }
      
      if (!modelsByFamily[family]) {
        modelsByFamily[family] = [];
      }
      
      modelsByFamily[family].push({
        name,
        displayName: model.displayName,
        description: model.description
      });
    });
    
    // Display models by family
    Object.keys(modelsByFamily).sort().forEach(family => {
      console.log(`\n${family.toUpperCase()}:`);
      
      modelsByFamily[family].forEach(model => {
        console.log(`  ${model.name}`);
        if (model.displayName) {
          console.log(`    Display name: ${model.displayName}`);
        }
      });
    });
    
  } catch (error) {
    console.error('Error listing models:', error);
    throw error;
  }
}

program
  .name('gemini')
  .description('Send prompts to the Gemini API')
  .version('1.0.0');

program
  .command('list-models')
  .description('List available Gemini models')
  .action(async () => {
    try {
      await listModels();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('generate', { isDefault: true })
  .argument('[prompt]', 'Text prompt to send to Gemini')
  .option('-f, --file <file>', 'Read prompt from a file')
  .option('-m, --model <name>', 'Specify the model to use (default: gemini-2.5-pro-preview-03-25)')
  .option('-t, --temperature <number>', 'Set the temperature (0.0 to 1.0)', parseFloat)
  .option('-p, --top-p <number>', 'Set the top P value', parseFloat)
  .option('-k, --top-k <number>', 'Set the top K value', parseInt)
  .option('-x, --max-tokens <number>', 'Set the maximum output tokens', parseInt)
  .option('-o, --output <file>', 'Write response to a file instead of stdout')
  .action(async (promptArg, options) => {
    try {
      let prompt = promptArg;
      
      // If no prompt is provided as an argument, check if it should be read from a file
      if (!prompt && options.file) {
        prompt = fs.readFileSync(path.resolve(options.file), 'utf-8');
      } 
      
      // If still no prompt, read from stdin
      if (!prompt) {
        // Check if there's data on stdin
        if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          prompt = Buffer.concat(chunks).toString('utf-8');
        } else {
          console.error('Error: No prompt provided. Please provide a prompt as an argument, from a file, or via stdin.');
          process.exit(1);
        }
      }

      const generationOptions = {
        model: options.model,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        maxOutputTokens: options.maxTokens || options['max-tokens']
      };

      const response = await sendGeminiPrompt(prompt, generationOptions);
      
      if (options.output) {
        fs.writeFileSync(path.resolve(options.output), response);
        console.log(`Response written to ${options.output}`);
      } else {
        console.log(response);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();