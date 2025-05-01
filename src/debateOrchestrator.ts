/**
 * Debate Orchestrator for sage-plan tool
 * 
 * Manages multi-model debates to generate implementation plans by having
 * models critique and refine each other's plans across multiple rounds.
 */

import { analyzeXmlTokens } from "./tokenCounter";
import { selectModelBasedOnTokens, O3_MODEL_NAME, O3_TOKEN_LIMIT, GEMINI_TOKEN_LIMIT } from "./modelManager";
import { sendGeminiPrompt } from "./gemini";
import { sendOpenAiPrompt } from "./openai";
import * as debatePrompts from "./prompts/debatePrompts";

// Type for notification function passed from MCP
export type NotificationFn = (notification: { 
  level: 'info' | 'debug' | 'warning' | 'error';
  data: string;
}) => Promise<void>;

/**
 * Structured log entry for debate transcript
 */
export interface DebateLogEntry {
  round: number;
  phase: 'generate' | 'critique' | 'synthesize' | 'judge' | 'consensus';
  modelId: string;
  prompt: string;
  response: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  timestamp: string;
}

/**
 * Interface for debate options
 */
export interface DebateOptions {
  paths: string[];                    // Paths to include as context
  userPrompt: string;                 // Task to generate plan for
  codeContext?: string;               // Pre-packed code context (optional)
  rounds?: number;                    // Default 3
  models?: string[];                  // Override auto-selection
  parallelism?: number;               // # of concurrent calls
  judgeModel?: string | "auto";       // "auto" = o3 if available
  abortSignal?: AbortSignal;          // For cancellation support
  timeoutMs?: number;                 // Overall debate timeout (default: 10 minutes)
  maxTotalTokens?: number;            // Budget cap
}

/**
 * Interface for debate results
 */
export interface DebateResult {
  finalPlan: string;                  // The winner (or merged) plan
  logs: DebateLogEntry[];             // Structured debate transcript
  stats: { 
    totalTokens: number; 
    perModel: Record<string, {
      tokens: number;
      apiCalls: number;
      cost: number;                   // Estimated cost based on pricing
    }>; 
    totalApiCalls: number;
    totalCost: number;
    consensus: {                      // Information about consensus
      reached: boolean;               // Was early consensus reached?
      round: number;                  // At which round?
      score: number;                  // Confidence score (0-1)
    }
  };
  complete: boolean;                  // Whether debate completed all rounds or was partial
}

/**
 * Model capability information
 */
export interface ModelCapability {
  name: string;
  type: 'openai' | 'gemini';
  available: boolean;
  tokenLimit: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}

/**
 * Options for retry helper
 */
export interface RetryOptions {
  attempts?: number;                  // Max retry attempts (default: 3)
  initialDelay?: number;              // Initial delay in ms (default: 1000)
  maxDelay?: number;                  // Maximum delay in ms (default: 30000)
  factor?: number;                    // Backoff factor (default: 2)
  jitter?: boolean;                   // Add randomness to delay (default: true)
}

/**
 * Retry helper with exponential backoff and jitter
 */
export async function withRetry<T>(
  fn: () => Promise<T>, 
  options: RetryOptions = {}
): Promise<T> {
  const {
    attempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true
  } = options;

  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // If this is the last attempt, don't delay, just throw
      if (attempt === attempts) {
        throw lastError;
      }
      
      // Calculate delay with exponential backoff
      let delay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
      
      // Add jitter if enabled (±25%)
      if (jitter) {
        const jitterFactor = 0.75 + Math.random() * 0.5; // Between 0.75 and 1.25
        delay = Math.floor(delay * jitterFactor);
      }
      
      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never happen due to the throw above, but TypeScript needs it
  throw lastError || new Error('Retry failed');
}

/**
 * Get available models with their capabilities
 */
export function getAvailableModels(): ModelCapability[] {
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  
  const models: ModelCapability[] = [];
  
  // O3 model
  models.push({
    name: O3_MODEL_NAME,
    type: 'openai',
    available: hasOpenAiKey,
    tokenLimit: O3_TOKEN_LIMIT,
    // Approximate costs per 1M tokens (may need to be updated)
    costPerInputToken: 8 / 1000000,
    costPerOutputToken: 24 / 1000000
  });
  
  // GPT-4.1 model
  models.push({
    name: 'gpt-4.1-2025-04-14', // Full model name with date
    type: 'openai',
    available: hasOpenAiKey,
    tokenLimit: 1047576, // ~1M tokens context window (exact 1,047,576)
    costPerInputToken: 2 / 1000000, // $2.00 per 1M input tokens ($0.000002 per token)
    costPerOutputToken: 8 / 1000000  // $8.00 per 1M output tokens ($0.000008 per token)
  });
  
  // Gemini model
  models.push({
    name: 'gemini-2.5-pro-preview-03-25',
    type: 'gemini',
    available: hasGeminiKey,
    tokenLimit: GEMINI_TOKEN_LIMIT,
    costPerInputToken: 3.5 / 1000000,
    costPerOutputToken: 10.5 / 1000000
  });
  
  return models;
}

/**
 * Create a mapping between model names and anonymous IDs
 */
export function createModelMapping(models: string[]): { 
  idToModel: Record<string, string>;
  modelToId: Record<string, string>;
} {
  const idToModel: Record<string, string> = {};
  const modelToId: Record<string, string> = {};
  
  // Use letters A, B, C, etc. as model IDs
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  
  models.forEach((model, index) => {
    if (index < ids.length) {
      const id = ids[index];
      idToModel[id] = model;
      modelToId[model] = id;
    }
  });
  
  return { idToModel, modelToId };
}

/**
 * Create a token budget manager
 */
export function createTokenBudget(limit: number) {
  let usedTokens = 0;
  
  return {
    getStatus: () => ({
      limit,
      used: usedTokens,
      remaining: Math.max(0, limit - usedTokens)
    }),
    
    beginRound: (estimatedTokens: number) => {
      return usedTokens + estimatedTokens <= limit;
    },
    
    recordUsage: (tokens: number) => {
      usedTokens += tokens;
    }
  };
}

/**
 * Process model response and extract token usage
 */
interface ModelResponse {
  text: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

/**
 * Send a prompt to a model and handle retries
 */
async function sendToModel(
  prompt: string,
  modelName: string,
  modelType: 'openai' | 'gemini',
  abortSignal?: AbortSignal,
  notifyFn?: (message: {level: 'info' | 'warning' | 'error' | 'debug'; data: string}) => Promise<void>
): Promise<ModelResponse> {
  // No direct console logging in MCP communication paths
  // Estimate token counts for statistics
  const estimatedPromptTokens = modelType === 'openai' 
    ? prompt.length / 4  // rough openai estimation
    : prompt.length / 5; // rough gemini estimation
  
  // Just use the provided abort signal
  const signal = abortSignal;
  
  try {
    // Use the appropriate API based on model type
    if (modelType === 'openai') {
      // Send detailed debug info
      if (notifyFn) {
        try {
          await notifyFn({ level: 'debug', data: `Starting OpenAI request for ${modelName} with ${prompt.length} chars, signal active: ${signal ? !signal.aborted : 'no signal'}` });
        } catch (e) {
          // Ignore notification errors
        }
      }
      
      const openaiResponse = await withRetry(
        () => sendOpenAiPrompt(prompt, { model: modelName }, notifyFn, signal), // No longer passing timeout
        { attempts: 3 }
      );
      
      // Estimate token usage
      const completionTokens = openaiResponse.length / 4;
      
      return {
        text: openaiResponse,
        tokenUsage: {
          prompt: Math.ceil(estimatedPromptTokens),
          completion: Math.ceil(completionTokens),
          total: Math.ceil(estimatedPromptTokens + completionTokens)
        }
      };
    } else {
      // Gemini
      // Send detailed debug info
      if (notifyFn) {
        try {
          await notifyFn({ level: 'debug', data: `Starting Gemini request for ${modelName} with ${prompt.length} chars, signal active: ${signal ? !signal.aborted : 'no signal'}` });
        } catch (e) {
          // Ignore notification errors
        }
      }
      
      const geminiResponse = await withRetry(
        () => sendGeminiPrompt(prompt, { model: modelName }, signal),
        { attempts: 3 }
      );
      
      // Estimate token usage
      const completionTokens = geminiResponse.length / 5;
      
      return {
        text: geminiResponse,
        tokenUsage: {
          prompt: Math.ceil(estimatedPromptTokens),
          completion: Math.ceil(completionTokens),
          total: Math.ceil(estimatedPromptTokens + completionTokens)
        }
      };
    }
  } catch (error) {
    // Log detailed error info including rate limits
    const errorObj = error as any;
    
    // Add abort-specific logging
    if ((error as Error).name === 'AbortError' || (error instanceof Error && error.message.includes('abort'))) {
      throw new Error(`Timeout exceeded for ${modelType} API call (${modelName}): ${error instanceof Error ? error.message : String(error)}`);
    }
    
    if (errorObj.status === 429 && errorObj.error?.type === 'tokens') {
      // Handle rate limit errors specifically
      const resetTokens = errorObj.headers?.['x-ratelimit-reset-tokens'] || 'unknown';
      const waitTime = errorObj.headers?.['x-ratelimit-reset-tokens'] ? 
        parseResetTime(errorObj.headers['x-ratelimit-reset-tokens']) : 60000;
      
      // Log rate limit details
      console.warn(`Rate limit exceeded calling ${modelType} API (${modelName}): Reset in ${waitTime}ms`);
      
      throw new Error(`Rate limit exceeded calling ${modelType} API (${modelName}): ${errorObj.error?.message || 'Unknown error'}. Reset in: ${resetTokens}, Requested: ${errorObj.error?.param || 'unknown'}`);
    }
    
    // No direct console logging for MCP communication paths
    
    throw new Error(`Error calling ${modelType} API (${modelName}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Helper to parse reset time from headers
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
  return totalMs === 0 ? 60000 : totalMs;
}

/**
 * Extract a confidence score from the judge's response
 */
function extractConfidenceScore(text: string): number {
  const match = text.match(/Confidence Score:\s*(0\.\d+|1\.0|1)/i);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return 0.5; // Default mid-level confidence
}

/**
 * Check for consensus between plans
 */
async function checkConsensus(
  plans: Record<string, string>,
  judgeModel: string,
  judgeModelType: 'openai' | 'gemini',
  abortSignal?: AbortSignal,
  notifyFn?: NotificationFn
): Promise<{ reached: boolean; score: number; }> {
  try {
    const consensusPrompt = debatePrompts.consensusCheckPrompt(plans);
    const response = await sendToModel(consensusPrompt, judgeModel, judgeModelType, abortSignal, notifyFn);
    
    try {
      // Extract JSON from response
      const jsonStr = response.text.trim();
      const result = JSON.parse(jsonStr);
      
      return {
        reached: !!result.consensusReached,
        score: result.consensusScore || 0
      };
    } catch (e) {
      // Fallback if JSON parsing fails
      const score = extractConfidenceScore(response.text);
      return {
        reached: score >= 0.9,
        score
      };
    }
  } catch (error) {
    // If consensus check fails, assume no consensus
    return { reached: false, score: 0 };
  }
}

/**
 * Chunk a large array into smaller batches for parallel processing
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

/**
 * Main debate function that orchestrates the multi-model debate
 */
export async function debate(
  opts: DebateOptions, 
  sendNotification: NotificationFn
): Promise<DebateResult> {
  const {
    paths,
    userPrompt,
    codeContext,
    rounds = 3,
    models: selectedModels,
    parallelism = 3,
    judgeModel = 'auto',
    abortSignal,
    timeoutMs = 10 * 60 * 1000, // 10 minutes default
    maxTotalTokens
  } = opts;
  
  // Set up debate state
  const logs: DebateLogEntry[] = [];
  const stats = {
    totalTokens: 0,
    perModel: {} as Record<string, { tokens: number; apiCalls: number; cost: number }>,
    totalApiCalls: 0,
    totalCost: 0,
    consensus: {
      reached: false,
      round: 0,
      score: 0
    }
  };
  
  // Track whether the debate completes all rounds
  let complete = false;
  
  // Create our own abort controller if none was provided, and create one per request for timeouts
  let localAbortController: AbortController | null = null;
  let debateSignal = abortSignal;
  if (!debateSignal) {
    localAbortController = new AbortController();
    debateSignal = localAbortController.signal;
  }
  
  // We no longer use per-request timeout controllers
  // Only the main debate timeout is used
  
  // Create a promise that rejects after timeout
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const timeoutId = setTimeout(() => {
      // Abort any running API calls 
      if (localAbortController) {
        localAbortController.abort();
      }
      reject(new Error(`Debate timeout exceeded (${timeoutMs}ms)`));
    }, timeoutMs);
    
    // Clear the timeout if the abort signal is triggered
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new Error('Debate aborted'));
      });
    }
  });
  
  try {
    // Log function to record debate progress
    const logEntry = (entry: Omit<DebateLogEntry, 'timestamp'>) => {
      const fullEntry: DebateLogEntry = {
        ...entry,
        timestamp: new Date().toISOString()
      };
      
      logs.push(fullEntry);
      
      // Update statistics
      stats.totalTokens += entry.tokenUsage.total;
      stats.totalApiCalls += 1;
      
      // Update per-model statistics
      if (!stats.perModel[entry.modelId]) {
        stats.perModel[entry.modelId] = { tokens: 0, apiCalls: 0, cost: 0 };
      }
      
      stats.perModel[entry.modelId].tokens += entry.tokenUsage.total;
      stats.perModel[entry.modelId].apiCalls += 1;
      
      return fullEntry;
    };
    
    // Notify about debate progress
    const notify = async (level: 'info' | 'debug' | 'warning' | 'error', message: string) => {
      await sendNotification({ level, data: message });
    };
    
    await notify('info', 'Starting debate orchestration...');
    await notify('debug', `Using overall timeout: ${timeoutMs/1000}s`);
    
    // Step 1: Determine available models
    const availableModels = getAvailableModels().filter(m => m.available);
    
    if (availableModels.length === 0) {
      throw new Error('No models available. Please set either OPENAI_API_KEY or GEMINI_API_KEY environment variables.');
    }
    
    await notify('info', `Available models: ${availableModels.map(m => m.name).join(', ')}`);
    
    // Step 2: Select models for the debate
    const debateModels = selectedModels || availableModels.map(m => m.name);
    const modelMapping = createModelMapping(debateModels);
    const { idToModel, modelToId } = modelMapping;
    
    await notify('info', `Debate participants: ${Object.entries(idToModel).map(([id, model]) => `Model ${id} (${model})`).join(', ')}`);
    
    // Step 3: Select judge model (default to o3 if available)
    let judgeModelName = '';
    let judgeModelType: 'openai' | 'gemini' = 'openai';
    
    if (judgeModel === 'auto') {
      // Find O3 if available, otherwise use the "best" available model
      const o3Model = availableModels.find(m => m.name === O3_MODEL_NAME);
      if (o3Model) {
        judgeModelName = o3Model.name;
        judgeModelType = o3Model.type;
      } else {
        // Sort by token limit and pick the highest
        const sortedModels = [...availableModels].sort((a, b) => b.tokenLimit - a.tokenLimit);
        judgeModelName = sortedModels[0].name;
        judgeModelType = sortedModels[0].type;
      }
    } else {
      // Use specified judge model
      judgeModelName = judgeModel;
      // Determine type
      judgeModelType = judgeModelName.includes('gemini') ? 'gemini' : 'openai';
    }
    
    await notify('info', `Judge model: ${judgeModelName}`);
    
    // Set up token budget if specified
    const tokenBudget = maxTotalTokens ? createTokenBudget(maxTotalTokens) : null;
    
    // Track plans throughout the debate
    let currentPlans: Record<string, string> = {};
    let finalPlan = '';
    
    // Determine if we're doing a self-debate (CoRT) or multi-model debate
    const isSelfDebate = Object.keys(idToModel).length === 1;
    
    if (isSelfDebate) {
      await notify('info', 'Only one model available. Using Chain of Recursive Thoughts (CoRT) approach.');
      
      // Get the single model's details
      const modelId = Object.keys(idToModel)[0];
      const modelName = idToModel[modelId];
      const modelType = modelName.includes('gemini') ? 'gemini' : 'openai';
      
      // Run self-debate process
      try {
        // Generate initial plans (3-4)
        const selfPlans: string[] = [];
        
        for (let i = 0; i < 3; i++) {
          const selfPrompt = debatePrompts.selfDebatePrompt(modelId, userPrompt, selfPlans);
          
          await notify('info', `Generating plan ${i+1} in self-debate...`);
          
          const response = await Promise.race([
            sendToModel(codeContext + selfPrompt, modelName, modelType, debateSignal, sendNotification),
            timeoutPromise
          ]);
          
          logEntry({
            round: 1,
            phase: 'generate',
            modelId,
            prompt: selfPrompt,
            response: response.text,
            tokenUsage: response.tokenUsage
          });
          
          selfPlans.push(response.text);
        }
        
        // Self-evaluate and pick best plan
        for (let round = 2; round <= rounds; round++) {
          // Check if we should break early due to budget
          if (tokenBudget && !tokenBudget.beginRound(10000)) { // Rough estimate
            await notify('warning', 'Token budget limit reached. Ending debate early.');
            break;
          }
          
          const selfPrompt = debatePrompts.selfDebatePrompt(modelId, userPrompt, selfPlans);
          
          await notify('info', `Self-debate round ${round}...`);
          
          const response = await Promise.race([
            sendToModel(selfPrompt, modelName, modelType, debateSignal, sendNotification),
            timeoutPromise
          ]);
          
          logEntry({
            round,
            phase: 'synthesize',
            modelId,
            prompt: selfPrompt,
            response: response.text,
            tokenUsage: response.tokenUsage
          });
          
          selfPlans.push(response.text);
        }
        
        // Final plan is the last generated one
        finalPlan = selfPlans[selfPlans.length - 1];
        complete = true;
      } catch (error) {
        await notify('error', `Error in self-debate: ${error instanceof Error ? error.message : String(error)}`);
        // Use the last successful plan if available
        finalPlan = "Error occurred during self-debate.";
      }
    } else {
      // Multi-model debate process
      try {
        for (let round = 1; round <= rounds; round++) {
          await notify('info', `Starting debate round ${round}...`);
          
          // Check if we should break early due to budget
          if (tokenBudget && !tokenBudget.beginRound(50000)) { // Rough estimate
            await notify('warning', 'Token budget limit reached. Ending debate early.');
            break;
          }
          
          // Phase 1: Generation (first round) or Synthesis (subsequent rounds)
          if (round === 1) {
            // Generation phase - all models generate initial plans
            await notify('info', 'Generation phase: Creating initial plans...');
            
            const modelIds = Object.keys(idToModel);
            const tasks = modelIds.map(modelId => {
              const modelName = idToModel[modelId];
              const modelType = modelName.includes('gemini') ? 'gemini' : 'openai';
              
              return async () => {
                const generationPrompt = debatePrompts.generatePrompt(modelId, userPrompt);
                
                try {
                  await notify('info', `Sending generation request to model ${modelId} (${modelName})...`);
                  
                  const response = await Promise.race([
                    sendToModel(codeContext + generationPrompt, modelName, modelType, debateSignal, sendNotification),
                    timeoutPromise
                  ]);
                  
                  logEntry({
                    round,
                    phase: 'generate',
                    modelId,
                    prompt: generationPrompt,
                    response: response.text,
                    tokenUsage: response.tokenUsage
                  });
                  
                  // Store the plan
                  currentPlans[modelId] = response.text;
                  
                  await notify('debug', `Model ${modelId} (${modelName}) generated plan successfully.`);
                } catch (error) {
                  await notify('error', `Error in generation phase for model ${modelId} (${modelName}): ${error instanceof Error ? error.message : String(error)}`);
                }
              };
            });
            
            // Run in parallel batches based on parallelism setting
            const batches = chunkArray(tasks, parallelism);
            for (const batch of batches) {
              await Promise.all(batch.map(task => task()));
            }
          } else {
            // Synthesis phase - models refine their plans based on critiques
            await notify('info', 'Synthesis phase: Refining plans based on critiques...');
            
            const modelIds = Object.keys(currentPlans);
            const tasks = modelIds.map(modelId => {
              const modelName = idToModel[modelId];
              const modelType = modelName.includes('gemini') ? 'gemini' : 'openai';
              
              return async () => {
                // Get critiques for this model from previous round
                const critiques = logs
                  .filter(log => log.round === round - 1 && log.phase === 'critique' && log.response.includes(`Critique of Plan ${modelId}`))
                  .map(log => log.response);
                
                const synthesisPrompt = debatePrompts.synthesizePrompt(
                  modelId, 
                  currentPlans[modelId], 
                  critiques
                );
                
                try {
                  const response = await Promise.race([
                    sendToModel(synthesisPrompt, modelName, modelType, debateSignal, sendNotification),
                    timeoutPromise
                  ]);
                  
                  logEntry({
                    round,
                    phase: 'synthesize',
                    modelId,
                    prompt: synthesisPrompt,
                    response: response.text,
                    tokenUsage: response.tokenUsage
                  });
                  
                  // Update the plan
                  currentPlans[modelId] = response.text;
                  
                  await notify('debug', `Model ${modelId} (${modelName}) refined plan successfully.`);
                } catch (error) {
                  await notify('error', `Error in synthesis phase for model ${modelId} (${modelName}): ${error instanceof Error ? error.message : String(error)}`);
                }
              };
            });
            
            // Run in parallel batches based on parallelism setting
            const batches = chunkArray(tasks, parallelism);
            for (const batch of batches) {
              await Promise.all(batch.map(task => task()));
            }
          }
          
          // Check for consensus after synthesis
          if (round > 1 && Object.keys(currentPlans).length > 1) {
            await notify('info', 'Checking for consensus...');
            
            const consensusResult = await checkConsensus(
              currentPlans, 
              judgeModelName, 
              judgeModelType, 
              abortSignal
            );
            
            stats.consensus = {
              reached: consensusResult.reached,
              round,
              score: consensusResult.score
            };
            
            await notify('info', `Consensus check: ${consensusResult.reached ? 'Reached' : 'Not reached'} (Score: ${consensusResult.score.toFixed(2)})`);
            
            // Exit early if consensus reached
            if (consensusResult.reached) {
              await notify('info', 'Consensus reached! Proceeding to judgment phase.');
              break;
            }
          }
          
          // Skip critique on final round
          if (round === rounds || stats.consensus.reached) {
            continue;
          }
          
          // Phase 2: Critique - each model critiques others' plans
          await notify('info', 'Critique phase: Evaluating plans...');
          
          const modelIds = Object.keys(currentPlans);
          const tasks = modelIds.map(modelId => {
            const modelName = idToModel[modelId];
            const modelType = modelName.includes('gemini') ? 'gemini' : 'openai';
            
            return async () => {
              // Create a subset of plans to critique (excluding own plan)
              const plansToReview = { ...currentPlans };
              delete plansToReview[modelId];
              
              const critiquePrompt = debatePrompts.critiquePrompt(modelId, plansToReview);
              
              try {
                const response = await Promise.race([
                  sendToModel(critiquePrompt, modelName, modelType, debateSignal, sendNotification),
                  timeoutPromise
                ]);
                
                logEntry({
                  round,
                  phase: 'critique',
                  modelId,
                  prompt: critiquePrompt,
                  response: response.text,
                  tokenUsage: response.tokenUsage
                });
                
                await notify('debug', `Model ${modelId} (${modelName}) critiqued other plans successfully.`);
              } catch (error) {
                await notify('error', `Error in critique phase for model ${modelId} (${modelName}): ${error instanceof Error ? error.message : String(error)}`);
              }
            };
          });
          
          // Run in parallel batches based on parallelism setting
          const batches = chunkArray(tasks, parallelism);
          for (const batch of batches) {
            await Promise.all(batch.map(task => task()));
          }
        }
        
        // Final judgment phase
        await notify('info', 'Judgment phase: Selecting best plan...');
        
        if (Object.keys(currentPlans).length === 0) {
          throw new Error('No valid plans produced during debate.');
        } else if (Object.keys(currentPlans).length === 1) {
          // Only one plan available, use it directly
          finalPlan = Object.values(currentPlans)[0];
          complete = true;
        } else {
          // Multiple plans - use judge model to select best
          const judgePrompt = debatePrompts.judgePrompt(currentPlans);
          
          try {
            const response = await Promise.race([
              sendToModel(judgePrompt, judgeModelName, judgeModelType, debateSignal, sendNotification),
              timeoutPromise
            ]);
            
            logEntry({
              round: rounds,
              phase: 'judge',
              modelId: 'JUDGE',
              prompt: judgePrompt,
              response: response.text,
              tokenUsage: response.tokenUsage
            });
            
            finalPlan = response.text;
            
            // Extract confidence score from the judge's response
            const confidenceScore = extractConfidenceScore(response.text);
            stats.consensus.score = confidenceScore;
            
            complete = true;
            await notify('info', 'Judgment complete. Final plan selected.');
          } catch (error) {
            await notify('error', `Error in judgment phase: ${error instanceof Error ? error.message : String(error)}`);
            
            // Fallback: use the last plan from round
            const planIds = Object.keys(currentPlans);
            finalPlan = currentPlans[planIds[0]];
            await notify('warning', 'Using fallback plan due to judgment error.');
          }
        }
      } catch (error) {
        await notify('error', `Error in debate process: ${error instanceof Error ? error.message : String(error)}`);
        
        // Use any available plan as fallback
        if (Object.keys(currentPlans).length > 0) {
          const planIds = Object.keys(currentPlans);
          finalPlan = currentPlans[planIds[0]];
          await notify('warning', 'Using fallback plan due to debate error.');
        } else {
          finalPlan = "Error occurred during debate. No valid plan was produced.";
        }
      }
    }
    
    // Calculate total cost
    for (const modelId in stats.perModel) {
      const model = idToModel[modelId];
      const modelData = availableModels.find(m => m.name === model);
      
      if (modelData) {
        // Rough cost calculation - assumes 30% input, 70% output tokens
        const inputTokens = stats.perModel[modelId].tokens * 0.3;
        const outputTokens = stats.perModel[modelId].tokens * 0.7;
        const cost = 
          (inputTokens * modelData.costPerInputToken) +
          (outputTokens * modelData.costPerOutputToken);
        
        stats.perModel[modelId].cost = cost;
        stats.totalCost += cost;
      }
    }
    
    return {
      finalPlan,
      logs,
      stats,
      complete
    };
  } catch (error) {
    // If we reach here, something catastrophic happened
    return {
      finalPlan: `Debate failed: ${error instanceof Error ? error.message : String(error)}`,
      logs,
      stats,
      complete: false
    };
  }
}