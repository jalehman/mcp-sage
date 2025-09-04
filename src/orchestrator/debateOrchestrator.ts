/**
 * Debate Orchestrator
 *
 * Manages the multi-model debate process for all tool types (plan, opinion, review)
 * using the Strategy pattern to customize behavior per tool type.
 */

import { performance } from "perf_hooks";
import {
  DebateOptions,
  DebateResult,
  DebateConfig,
  DebateMeta,
  DebateWarning,
  DebateLog,
  ToolType,
} from "../types/public";
import { DebateStrategy, DebatePhase } from "../strategies/strategyTypes";
import { getStrategy } from "../strategies/registry";
import {
  selectModelBasedOnTokens,
  getAvailableModels,
  sendToModelWithFallback,
} from "../modelManager";
import { OPUS41_MODEL_NAME } from "../modelDefinitions";

// Type for notification function passed from MCP
export type NotificationFn = (notification: {
  level: "info" | "debug" | "warning" | "error";
  data: string;
}) => Promise<void>;

/**
 * Create a mapping between model names and anonymous IDs
 */
function createModelMapping(models: string[]): {
  idToModel: Record<string, string>;
  modelToId: Record<string, string>;
} {
  const idToModel: Record<string, string> = {};
  const modelToId: Record<string, string> = {};

  // Use letters A, B, C, etc. as model IDs
  const ids = ["A", "B", "C", "D", "E", "F", "G", "H"];

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
function createTokenBudget(limit: number) {
  let usedTokens = 0;

  return {
    getStatus: () => ({
      limit,
      used: usedTokens,
      remaining: Math.max(0, limit - usedTokens),
    }),

    beginRound: (estimatedTokens: number) => {
      return usedTokens + estimatedTokens <= limit;
    },

    recordUsage: (tokens: number) => {
      usedTokens += tokens;
    },
  };
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
 * Model response types
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
 * Convert string response from sendToModelWithFallback to ModelResponse
 */
function parseModelResponse(
  response: string,
  promptLength: number,
): ModelResponse {
  // Estimate token counts based on text length
  const promptTokens = Math.ceil(promptLength / 4);
  const completionTokens = Math.ceil(response.length / 4);

  return {
    text: response,
    tokenUsage: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
    },
  };
}

/**
 * Main orchestration function for running debates
 */
export async function runDebate(
  options: DebateOptions,
  sendNotification: NotificationFn,
): Promise<DebateResult> {
  // 1. Merge & normalize config
  const strategy = await getStrategy(options.toolType);
  if (!strategy) {
    throw new Error(`No strategy available for tool type ${options.toolType}`);
  }

  // Combine configs with defaults
  const config: Required<DebateConfig> = {
    enabled: options.debate ?? options.debateConfig?.enabled ?? false,
    rounds:
      options.debateConfig?.rounds ?? strategy.configDefaults?.rounds ?? 3,
    strategy: options.debateConfig?.strategy ?? options.toolType,
    maxTotalTokens: options.debateConfig?.maxTotalTokens ?? 0,
    logLevel:
      options.debateConfig?.logLevel ??
      strategy.configDefaults?.logLevel ??
      "warn",
  };

  // Short-circuit if debate is disabled
  if (!config.enabled) {
    await sendNotification({
      level: "info",
      data: `Debate disabled for ${options.toolType}. Using single-model inference.`,
    });

    // Return basic result without debate
    // This should be handled elsewhere - in this case, we'll just return an error
    throw new Error("Debate must be enabled to use runDebate function");
  }

  // Initialize tracking data
  const startTime = performance.now();
  const phaseTimings: Record<string, number> = {};
  const warnings: DebateWarning[] = [];
  const transcript: string[] = [];
  const fallbacks: { phase: string; reason: string }[] = [];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // Helper to track phase timings
  const timePhase = async <T>(
    phaseName: string,
    func: () => Promise<T>,
  ): Promise<T> => {
    const phaseStart = performance.now();
    try {
      return await func();
    } finally {
      phaseTimings[phaseName] = performance.now() - phaseStart;
    }
  };

  // Helper to record warnings
  const addWarning = (
    code: DebateWarning["code"],
    message: string,
    phase: DebateWarning["phase"],
  ) => {
    warnings.push({ code, message, phase });
    sendNotification({
      level: "warning",
      data: `[${code}] ${message}`,
    });
  };

  // Helper to record fallbacks
  const addFallback = (phase: string, reason: string) => {
    fallbacks.push({ phase, reason });
    if (config.logLevel === "debug") {
      sendNotification({
        level: "debug",
        data: `Fallback in ${phase}: ${reason}`,
      });
    }
  };

  // Helper to record transcript entries (only in debug mode)
  const addTranscript = (entry: string) => {
    if (config.logLevel === "debug") {
      transcript.push(entry);
    }
  };

  // Determine available models
  const availableModels = getAvailableModels().filter((m) => m.available);
  if (availableModels.length === 0) {
    throw new Error(
      "No models available. Please set either OPENAI_API_KEY or GEMINI_API_KEY environment variables.",
    );
  }

  // Select models for the debate (for now, just use all available models)
  const debateModels = availableModels.map((m) => m.name);
  const modelMapping = createModelMapping(debateModels);
  const { idToModel, modelToId } = modelMapping;

  // Set up token budget if specified
  const tokenBudget =
    config.maxTotalTokens > 0 ? createTokenBudget(config.maxTotalTokens) : null;

  // Set up the debate context
  const debateContext = {
    userPrompt: options.userPrompt,
    candidates: [] as string[],
    critiques: [] as string[],
    round: 1,
  };

  // Track which model created each candidate
  const candidateModelMapping: {
    candidateIndex: number;
    modelId: string;
    modelName: string;
  }[] = [];

  await sendNotification({
    level: "info",
    data: `Starting debate for ${options.toolType} with ${debateModels.length} models and ${config.rounds} rounds`,
  });

  let finalOutput = "";
  let judgeResult: any = null;

  // 3. Single-Model Shortcut
  if (debateModels.length === 1) {
    await sendNotification({
      level: "info",
      data: "Only one model available. Using simplified single-model flow.",
    });

    // Just generate a single candidate and validate it
    const modelId = Object.keys(idToModel)[0];
    const modelName = idToModel[modelId];
    const generatePrompt = strategy.getPrompt("generate", debateContext);

    // Record the prompt in the transcript
    addTranscript(`[SINGLE-MODEL GENERATE]\nPrompt:\n${generatePrompt}\n`);

    try {
      // Generate the candidate
      const response = await timePhase<ModelResponse>("generate", async () => {
        const rawResponse = await sendToModelWithFallback(
          generatePrompt,
          {
            modelName,
            modelType: modelName.includes("gemini") ? "gemini" : "openai",
            tokenCount: generatePrompt.length / 4,
          },
          sendNotification,
        );
        return parseModelResponse(rawResponse, generatePrompt.length);
      });

      // Record token usage
      totalPromptTokens += response.tokenUsage.prompt;
      totalCompletionTokens += response.tokenUsage.completion;
      if (tokenBudget) {
        tokenBudget.recordUsage(response.tokenUsage.total);
      }

      // Record the response in the transcript
      addTranscript(`[SINGLE-MODEL RESPONSE]\n${response.text}\n`);

      // Use the response as final output
      finalOutput = response.text;
    } catch (error) {
      // Handle generation failure
      addWarning(
        "GEN_FAIL",
        `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
        "generate",
      );

      // No candidates to choose from, so return error message
      finalOutput = `Error generating output: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    // 4. Multi-Model Debate Loop
    for (let round = 1; round <= config.rounds; round++) {
      await sendNotification({
        level: "info",
        data: `Starting debate round ${round}/${config.rounds}`,
      });

      // Update debate context for this round
      debateContext.round = round;

      // Check token budget before starting the round
      if (tokenBudget && !tokenBudget.beginRound(50000)) {
        // Rough estimate
        addWarning(
          "TOKEN_BUDGET",
          "Token budget exceeded. Ending debate early.",
          "generate",
        );
        break;
      }

      // a. Generation phase
      if (round === 1) {
        await sendNotification({
          level: "info",
          data: "Generation phase: Creating initial candidates...",
        });

        const modelIds = Object.keys(idToModel);
        const generationTasks = modelIds.map((modelId) => {
          const modelName = idToModel[modelId];
          const modelType = modelName.includes("gemini") ? "gemini" : "openai";

          return async () => {
            const generatePrompt = strategy.getPrompt("generate", {
              ...debateContext,
              round: parseInt(modelId, 36) || round, // Use the model ID as a numeric identifier
            });

            // Record the prompt in the transcript
            addTranscript(
              `[GENERATE MODEL ${modelId}]\nPrompt:\n${generatePrompt}\n`,
            );

            try {
              // Check if we're in test mode with API calls skipped
              if (process.env.SKIP_API_CALLS === "true") {
                // Create a mock response for testing
                const mockResponse = `Mock ${modelName} response for phase: generate\nModel: ${modelName}\nPrompt length: ${generatePrompt.length}\nThis is test output only.`;
                const response = parseModelResponse(
                  mockResponse,
                  generatePrompt.length,
                );

                // Record token usage (mocked)
                totalPromptTokens += response.tokenUsage.prompt;
                totalCompletionTokens += response.tokenUsage.completion;
                if (tokenBudget) {
                  tokenBudget.recordUsage(response.tokenUsage.total);
                }

                // Record the mock response in the transcript
                addTranscript(
                  `[GENERATE RESPONSE MODEL ${modelId} (MOCK)]\n${response.text}\n`,
                );

                // Add delay to simulate API call
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Store the mock candidate
                return response.text;
              } else {
                // Make actual API call
                const rawResponse = await sendToModelWithFallback(
                  generatePrompt,
                  {
                    modelName,
                    modelType,
                    tokenCount: generatePrompt.length / 4,
                  },
                  sendNotification,
                );

                const response = parseModelResponse(
                  rawResponse,
                  generatePrompt.length,
                );

                // Record token usage
                totalPromptTokens += response.tokenUsage.prompt;
                totalCompletionTokens += response.tokenUsage.completion;
                if (tokenBudget) {
                  tokenBudget.recordUsage(response.tokenUsage.total);
                }

                // Record the response in the transcript
                addTranscript(
                  `[GENERATE RESPONSE MODEL ${modelId}]\n${response.text}\n`,
                );

                // Store the candidate
                return response.text;
              }
            } catch (error) {
              // If generation fails, log but continue with other models
              addWarning(
                "GEN_FAIL",
                `Generation failed for model ${modelId}: ${error instanceof Error ? error.message : String(error)}`,
                "generate",
              );
              return null;
            }
          };
        });

        // Run generation tasks in parallel with a parallelism of 3
        const batches = chunkArray(generationTasks, 3);
        const candidateResults: (string | null)[] = [];

        await timePhase("generate", async () => {
          for (const batch of batches) {
            const batchResults = await Promise.all(batch.map((task) => task()));
            candidateResults.push(...batchResults);
          }
        });

        // Filter out null results and track which model created each candidate
        let candidateIndex = 0;
        const availableModelIds = Object.keys(idToModel);
        debateContext.candidates = [];
        candidateModelMapping.length = 0; // Clear any existing mappings

        candidateResults.forEach((result, resultIndex) => {
          if (result !== null) {
            debateContext.candidates.push(result);
            const modelId = availableModelIds[resultIndex];
            const modelName = idToModel[modelId];
            candidateModelMapping.push({
              candidateIndex,
              modelId,
              modelName,
            });
            candidateIndex++;
          }
        });

        if (debateContext.candidates.length === 0) {
          throw new Error(
            "All model generations failed. Cannot continue debate.",
          );
        }
      }

      // Skip critique on the final round
      if (round < config.rounds) {
        // b. Critique phase
        await sendNotification({
          level: "info",
          data: "Critique phase: Evaluating candidates...",
        });

        if (config.logLevel === "debug") {
          await sendNotification({
            level: "debug",
            data: `Starting critique phase with candidates: ${debateContext.candidates.length}`,
          });
        }

        const modelIds = Object.keys(idToModel);
        if (config.logLevel === "debug") {
          await sendNotification({
            level: "debug",
            data: `Model IDs for critique: ${modelIds.join(", ")}`,
          });
        }

        const critiqueTasks = modelIds.map((modelId) => {
          const modelName = idToModel[modelId];
          const modelType = modelName.includes("gemini") ? "gemini" : "openai";

          return async () => {
            // For critique, each model critiques all candidates
            const critiquePrompt = strategy.getPrompt("critique", {
              ...debateContext,
              round: parseInt(modelId, 36) || round, // Use the model ID as a numeric identifier
            });

            // Record the prompt in the transcript
            addTranscript(
              `[CRITIQUE MODEL ${modelId}]\nPrompt:\n${critiquePrompt}\n`,
            );

            try {
              // Check if we're in test mode with API calls skipped
              if (process.env.SKIP_API_CALLS === "true") {
                // Create a mock response for testing
                const mockResponse = `Mock ${modelName} response for phase: critique\nModel: ${modelName}\nPrompt length: ${critiquePrompt.length}\nThis is test output only.`;
                const response = parseModelResponse(
                  mockResponse,
                  critiquePrompt.length,
                );

                // Record token usage (mocked)
                totalPromptTokens += response.tokenUsage.prompt;
                totalCompletionTokens += response.tokenUsage.completion;
                if (tokenBudget) {
                  tokenBudget.recordUsage(response.tokenUsage.total);
                }

                // Record the mock response in the transcript
                addTranscript(
                  `[CRITIQUE RESPONSE MODEL ${modelId} (MOCK)]\n${response.text}\n`,
                );

                // Add delay to simulate API call
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Store the mock critique
                return response.text;
              } else {
                // Make actual API call

                let response;

                try {
                  const rawResponse = await sendToModelWithFallback(
                    critiquePrompt,
                    {
                      modelName,
                      modelType,
                      tokenCount: critiquePrompt.length / 4,
                    },
                    sendNotification,
                  );

                  response = parseModelResponse(
                    rawResponse,
                    critiquePrompt.length,
                  );
                } catch (critErr) {
                  throw critErr;
                }

                // Record token usage
                totalPromptTokens += response.tokenUsage.prompt;
                totalCompletionTokens += response.tokenUsage.completion;
                if (tokenBudget) {
                  tokenBudget.recordUsage(response.tokenUsage.total);
                }

                // Record the response in the transcript
                addTranscript(
                  `[CRITIQUE RESPONSE MODEL ${modelId}]\n${response.text}\n`,
                );

                // Store the critique
                return response.text;
              }
            } catch (error) {
              // If critique fails, log but continue with other models
              addWarning(
                "GEN_FAIL",
                `Critique failed for model ${modelId}: ${error instanceof Error ? error.message : String(error)}`,
                "critique",
              );
              return null;
            }
          };
        });

        // Run critique tasks in parallel with a parallelism of 3
        const batches = chunkArray(critiqueTasks, 3);
        const critiqueResults: (string | null)[] = [];

        await timePhase("critique", async () => {
          for (const batch of batches) {
            const batchResults = await Promise.all(batch.map((task) => task()));
            critiqueResults.push(...batchResults);
          }
        });

        // Filter out null results (failed critiques)
        debateContext.critiques = critiqueResults.filter(
          (r): r is string => r !== null,
        );
      }
    }

    // c. Judge phase
    await sendNotification({
      level: "info",
      data: "Judge phase: Selecting the best candidate...",
    });

    // Select the judge model - use Claude Opus 4.1 if Anthropic API key is available, 
    // otherwise fallback to first debate model
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
    const judgeModelName = hasAnthropicKey 
      ? OPUS41_MODEL_NAME 
      : debateModels[0];
    const judgeModelType = judgeModelName.includes("gemini")
      ? "gemini"
      : judgeModelName.includes("claude")
      ? "anthropic"
      : "openai";

    // Create the judge prompt
    const judgePrompt = strategy.getPrompt("judge", debateContext);

    // Record the prompt in the transcript
    addTranscript(`[JUDGE]\nPrompt:\n${judgePrompt}\n`);

    try {
      // Get the judge's decision
      const judgeResponse = await timePhase<ModelResponse>(
        "judge",
        async () => {
          // Check if we're in test mode with API calls skipped
          if (process.env.SKIP_API_CALLS === "true") {
            // Create a mock response for testing
            const mockResponse = `Mock ${judgeModelName} response for phase: judge
          Winner: Model A's plan

          Confidence Score: 0.8

          Rationale: This is a mock judge response for testing purposes. In a real debate, this would contain the judge's rationale for selecting the winning candidate.`;

            // Add delay to simulate API call
            await new Promise((resolve) => setTimeout(resolve, 500));

            return parseModelResponse(mockResponse, judgePrompt.length);
          } else {
            // Make actual API call
            const rawResponse = await sendToModelWithFallback(
              judgePrompt,
              {
                modelName: judgeModelName,
                modelType: judgeModelType,
                tokenCount: judgePrompt.length / 4,
              },
              sendNotification,
            );
            return parseModelResponse(rawResponse, judgePrompt.length);
          }
        },
      );

      // Record token usage
      totalPromptTokens += judgeResponse.tokenUsage.prompt;
      totalCompletionTokens += judgeResponse.tokenUsage.completion;
      if (tokenBudget) {
        tokenBudget.recordUsage(judgeResponse.tokenUsage.total);
      }

      // Record the response in the transcript
      if (process.env.SKIP_API_CALLS === "true") {
        addTranscript(`[JUDGE RESPONSE (MOCK)]\n${judgeResponse.text}\n`);
      } else {
        addTranscript(`[JUDGE RESPONSE]\n${judgeResponse.text}\n`);
      }

      // Parse the judge's decision
      judgeResult = strategy.parseJudge(
        judgeResponse.text,
        debateContext.candidates,
      );

      if (judgeResult.success) {
        if (judgeResult.winnerIdx === -1) {
          // Judge provided its own synthesis
          finalOutput = judgeResponse.text;
        } else {
          // Judge selected a winner from the candidates
          finalOutput = debateContext.candidates[judgeResult.winnerIdx];
        }
      } else {
        // Judge failed to determine a winner
        addWarning("JUDGE_MALFORMED", judgeResult.error, "judge");
        addFallback("judge", judgeResult.error);

        // Fallback to the first candidate
        finalOutput = debateContext.candidates[0];
      }
    } catch (error) {
      // If judge phase fails, fallback to the first candidate
      addWarning(
        "JUDGE_MALFORMED",
        `Judge phase error: ${error instanceof Error ? error.message : String(error)}`,
        "judge",
      );
      addFallback(
        "judge",
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Use the first candidate as fallback
      finalOutput = debateContext.candidates[0];
    }
  }

  // 6. Prepare the result metadata
  const meta: DebateMeta = {
    warnings,
    tokenUsage: {
      prompt: totalPromptTokens,
      completion: totalCompletionTokens,
    },
    timings: {
      totalMs: performance.now() - startTime,
      perPhase: phaseTimings,
    },
    strategy: strategy.toolType,
    rounds: debateContext.round,
  };

  // Add winner information if we have a successful judge result
  await sendNotification({
    level: "info",
    data: `Debug: judgeResult exists: ${!!judgeResult}, success: ${judgeResult?.success}, winnerIdx: ${judgeResult?.winnerIdx}`,
  });

  if (judgeResult && judgeResult.success && judgeResult.winnerIdx >= 0) {
    await sendNotification({
      level: "info",
      data: `Looking for winner at index ${judgeResult.winnerIdx} in mapping: ${JSON.stringify(candidateModelMapping)}`,
    });
    const winnerMapping = candidateModelMapping.find(
      (m) => m.candidateIndex === judgeResult.winnerIdx,
    );
    if (winnerMapping) {
      meta.winner = {
        modelId: winnerMapping.modelId,
        modelName: winnerMapping.modelName,
      };
      await sendNotification({
        level: "info",
        data: `Found winner: ${winnerMapping.modelName} (${winnerMapping.modelId})`,
      });
    } else {
      await sendNotification({
        level: "info",
        data: `No winner mapping found for index ${judgeResult.winnerIdx}`,
      });
    }
  }

  // 7. Return the appropriate result shape based on the tool type
  const result: DebateResult = {
    toolType: options.toolType,
    meta,
  } as DebateResult;

  // Include debug logs if requested
  if (config.logLevel === "debug") {
    (result as any).debateLog = {
      transcript,
      fallbacks,
    } as DebateLog;
  }

  // Add the tool-specific result field
  switch (options.toolType) {
    case ToolType.Opinion:
      (result as any).opinion = finalOutput;
      break;
    case ToolType.Review:
      (result as any).review = finalOutput;
      break;
  }

  // 8. Send telemetry if enabled
  if (process.env.SAGE_TELEMETRY === "1") {
    try {
      // Simple anonymous telemetry logging
      console.info(
        JSON.stringify({
          event: "debate_completion",
          toolType: options.toolType,
          rounds: debateContext.round,
          warnings: warnings.length,
          tokens: totalPromptTokens + totalCompletionTokens,
          durationMs: meta.timings.totalMs,
          modelsCount: debateModels.length,
        }),
      );
    } catch (error) {
      // Ignore telemetry errors
    }
  }

  await sendNotification({
    level: "info",
    data: `Debate completed for ${options.toolType} in ${Math.round(meta.timings.totalMs)}ms with ${warnings.length} warnings.`,
  });

  return result;
}
