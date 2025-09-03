#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { analyzeXmlTokens } from "./tokenCounter";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { packFilesSync } from "./pack";

// Import shared functions from gemini.ts and openai.ts
import {
  selectModelBasedOnTokens,
  sendToModelWithFallback,
  GEMINI_TOKEN_LIMIT,
  GPT5_TOKEN_LIMIT,
  O3_TOKEN_LIMIT,
} from "./modelManager";

// Import strategy registry
import { getStrategy } from "./strategies/registry";
import { ToolType } from "./types/public";

// Import the new debate orchestrator and the legacy adapter
import { runDebate } from "./orchestrator/debateOrchestrator";
import { legacyDebateAdapter } from "./adapters/planCompatibility";

// Import the legacy debate for backward compatibility during transition
import { debate } from "./debateOrchestrator";

// Load all strategies to ensure they register themselves
import "./strategies/planStrategy";
import "./strategies/opinionStrategy";
import "./strategies/reviewStrategy";

async function packFiles(paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return "<documents></documents>";
  }

  try {
    // Use the direct packFilesSync function instead of spawning a subprocess
    return packFilesSync(paths, {
      includeHidden: false,
      respectGitignore: true,
      includeLineNumbers: true,
    });
  } catch (error) {
    // Error will be handled by the caller who can use proper MCP notifications
    throw error;
  }
}

/**
 * Combines the packed files and user prompt.
 * @param packedFiles - The packed files XML
 * @param prompt - The user prompt
 * @returns The combined prompt
 */
function combinePromptWithContext(packedFiles: string, prompt: string): string {
  return `
I need you to help me with a task. Below, you'll find relevant files for context.

${packedFiles}

With this context in mind, please respond to my request:

${prompt}
`;
}

/**
 * Checks if the combined content is within a given token limit.
 * @param combined - The combined prompt with context
 * @param limit - The token limit to check against (defaults to Gemini's limit)
 * @returns Whether the content is within limits
 */
function isWithinTokenLimit(
  combined: string,
  limit: number = GEMINI_TOKEN_LIMIT,
): boolean {
  const tokenAnalysis = analyzeXmlTokens(combined);
  return tokenAnalysis.totalTokens <= limit;
}

/**
 * Creates the MCP server with the sage tool
 * @returns Configured MCP server
 */
function createServer(): McpServer {
  // Create an MCP server with proper capabilities
  const server = new McpServer(
    {
      name: "MCP Sage Server",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {}, // Support for sending log messages to clients
        tools: { listChanged: true }, // Support for tools and notifying of tool list changes
      },
    },
  );

  // Add the second-opinion tool
  server.tool(
    "sage-opinion",
    `Send a prompt to sage-like model for its opinion on a matter.

    Include the paths to all relevant files and/or directories that are pertinent to the matter.

    IMPORTANT: All paths must be absolute paths (e.g., /home/user/project/src), not relative paths.

    Do not worry about context limits; feel free to include as much as you think is relevant. If you include too much it will error and tell you, and then you can include less. Err on the side of including more context.`,
    {
      prompt: z.string().describe("The prompt to send to the external model."),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. MUST be absolute paths (e.g., /home/user/project/src). Including directories will include all files contained within recursively.",
        ),
      useDebate: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to use multi-model debate to generate the opinion"),
      debateConfig: z
        .object({
          rounds: z.number().optional(),
          maxTotalTokens: z.number().optional(),
          logLevel: z.enum(["warn", "info", "debug"]).optional(),
        })
        .optional()
        .describe("Configuration options for the debate process"),
    },
    async (
      { prompt, paths, useDebate, debateConfig },
      { sendNotification },
    ) => {
      try {
        // Pack the files up front - we'll need them in either case
        const packedFiles = await packFiles(paths);

        // Check if debate is enabled
        if (useDebate) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Using debate mode for sage-opinion with ${debateConfig?.rounds || 2} rounds`,
            },
          });

          const strategy = await getStrategy(ToolType.Opinion);
          if (!strategy) {
            throw new Error("Opinion strategy not found");
          }

          const result = await runDebate(
            {
              toolType: ToolType.Opinion,
              userPrompt: prompt,
              codeContext: packedFiles, // Add packed files as context
              debateConfig: {
                enabled: true,
                ...debateConfig,
              },
            },
            async (notification) => {
              // Fix notification nesting by passing the notification directly
              await sendNotification({
                method: "notifications/message",
                params: {
                  level: notification.level,
                  data: notification.data,
                },
              });
            },
          );

          return {
            content: [
              {
                type: "text",
                text:
                  "opinion" in result
                    ? result.opinion
                    : "Error: No opinion generated",
              },
            ],
            metadata: {
              meta: result.meta,
            },
          };
        }

        // Combine with the prompt
        const combined = combinePromptWithContext(packedFiles, prompt);

        // Select model based on token count and get token information
        const modelSelection = selectModelBasedOnTokens(combined);
        const { modelName, modelType, tokenCount, withinLimit, tokenLimit } =
          modelSelection;

        // Log token usage via MCP logging notification
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Token usage: ${tokenCount.toLocaleString()} tokens. Selected model: ${modelName} (limit: ${tokenLimit.toLocaleString()} tokens)`,
          },
        });

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Files included: ${paths.length}, Document count: ${analyzeXmlTokens(combined).documentCount}`,
          },
        });

        if (!withinLimit) {
          // Handle different error cases
          let errorMsg = "";

          if (modelName === "none" && tokenLimit === 0) {
            // No API keys available
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${GPT5_TOKEN_LIMIT.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens.`;
          } else if (modelType === "openai" && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by O3, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === "gemini" && !process.env.GEMINI_API_KEY) {
            // Missing Gemini API key
            errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
          } else {
            // Content exceeds all available model limits
            errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (O3: ${GPT5_TOKEN_LIMIT.toLocaleString()}, Gemini: ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens). Please reduce the number of files or shorten the prompt.`;
          }

          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Request blocked: ${process.env.OPENAI_API_KEY ? "O3 available. " : "O3 unavailable. "}${process.env.GEMINI_API_KEY ? "Gemini available." : "Gemini unavailable."}`,
            },
          });

          return {
            content: [{ type: "text", text: errorMsg }],
            isError: true,
          };
        }

        // Send to appropriate model based on selection with fallback capability
        const startTime = Date.now();
        const response = await sendToModelWithFallback(
          combined,
          { modelName, modelType, tokenCount },
          sendNotification,
        );

        const elapsedTime = Date.now() - startTime;

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Received response from ${modelName} in ${elapsedTime}ms`,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: response,
            },
          ],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "error",
            data: `Error in sage-opinion tool: ${errorMsg}`,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Add the expert-review tool for suggesting code edits using the SEARCH/REPLACE format
  server.tool(
    "sage-review",
    `Send code to the sage model for expert review and get specific edit suggestions as SEARCH/REPLACE blocks.

    Use this tool any time the user asks for a "sage review" or "code review" or "expert review".

    This tool includes the full content of all files in the specified paths and instructs the model to return edit suggestions in a specific format with search and replace blocks.

    IMPORTANT: All paths must be absolute paths (e.g., /home/user/project/src), not relative paths.

    If the user hasn't provided specific paths, use as many paths to files or directories as you're aware of that are useful in the context of the prompt.`,
    {
      instruction: z
        .string()
        .describe("The specific changes or improvements needed."),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. MUST be absolute paths (e.g., /home/user/project/src). Including directories will include all files contained within recursively.",
        ),
      useDebate: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to use multi-model debate to generate the review"),
      debateConfig: z
        .object({
          rounds: z.number().optional(),
          maxTotalTokens: z.number().optional(),
          logLevel: z.enum(["warn", "info", "debug"]).optional(),
        })
        .optional()
        .describe("Configuration options for the debate process"),
    },
    async (
      { instruction, paths, useDebate, debateConfig },
      { sendNotification },
    ) => {
      try {
        // Check if debate is enabled
        if (useDebate) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Using debate mode for sage-review with ${debateConfig?.rounds || 2} rounds`,
            },
          });

          const strategy = await getStrategy(ToolType.Review);
          if (!strategy) {
            throw new Error("Review strategy not found");
          }

          const result = await runDebate(
            {
              toolType: ToolType.Review,
              userPrompt: instruction,
              debateConfig: {
                enabled: true,
                ...debateConfig,
              },
            },
            async (notification) => {
              await sendNotification({
                method: "notifications/message",
                params: notification,
              });
            },
          );

          return {
            content: [
              {
                type: "text",
                text:
                  "review" in result
                    ? result.review
                    : "Error: No review generated",
              },
            ],
            metadata: {
              meta: result.meta,
            },
          };
        }

        // Pack the files
        const packedFiles = await packFiles(paths);

        // Create the expert review prompt that requests SEARCH/REPLACE formatting
        const expertReviewPrompt = `
        Act as an expert software developer.
        Always use best practices when coding.
        Respect and use existing conventions, libraries, etc that are already present in the code base.

        The following instruction describes the changes needed:
        ${instruction}

        Use the following to describe and format the change.

        Describe each change with a *SEARCH/REPLACE block* per the examples below.

        ALWAYS use the full path, use the files structure to find the right file path otherwise see if user request has it.

        All changes to files must use this *SEARCH/REPLACE block* format.
        ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!

        Some of the changes may not be relevant to some files - SKIP THOSE IN YOUR RESPONSE.

        Provide rationale for each change above each SEARCH/REPLACE block.

        Make sure search block exists in original file and is NOT empty.

        Please make sure the block is formatted correctly with \`<<<<<<< SEARCH\`, \`=======\` and \`>>>>>>> REPLACE\` as shown below.

        EXAMPLE:

        \`\`\`\`\`\`
        <<<<<<< SEARCH
        from flask import Flask
        =======
        import math
        from flask import Flask
        >>>>>>> REPLACE
        \`\`\`\`\`\`

        \`\`\`\`\`\`
        <<<<<<< SEARCH
        def factorial(n):
            "compute factorial"

            if n == 0:
                return 1
            else:
                return n * factorial(n-1)

        =======
        >>>>>>> REPLACE
        \`\`\`\`\`\`

        \`\`\`\`\`\`
        <<<<<<< SEARCH
            return str(factorial(n))
        =======
            return str(math.factorial(n))
        >>>>>>> REPLACE
        \`\`\`\`\`\`
        `;

        // Combine with the prompt
        const combined = combinePromptWithContext(
          packedFiles,
          expertReviewPrompt,
        );

        // Select model based on token count and get token information
        const modelSelection = selectModelBasedOnTokens(combined);
        const { modelName, modelType, tokenCount, withinLimit, tokenLimit } =
          modelSelection;

        // Log token usage via MCP logging notification
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Token usage: ${tokenCount.toLocaleString()} tokens. Selected model: ${modelName} (limit: ${tokenLimit.toLocaleString()} tokens)`,
          },
        });

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Files included: ${paths.length}, Document count: ${analyzeXmlTokens(combined).documentCount}`,
          },
        });

        if (!withinLimit) {
          // Handle different error cases
          let errorMsg = "";

          if (modelName === "none" && tokenLimit === 0) {
            // No API keys available
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${GPT5_TOKEN_LIMIT.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens.`;
          } else if (modelType === "openai" && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by O3, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === "gemini" && !process.env.GEMINI_API_KEY) {
            // Missing Gemini API key
            errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
          } else {
            // Content exceeds all available model limits
            errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (O3: ${GPT5_TOKEN_LIMIT.toLocaleString()}, Gemini: ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens). Please reduce the number of files or shorten the instruction.`;
          }

          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Request blocked: ${process.env.OPENAI_API_KEY ? "O3 available. " : "O3 unavailable. "}${process.env.GEMINI_API_KEY ? "Gemini available." : "Gemini unavailable."}`,
            },
          });

          return {
            content: [{ type: "text", text: errorMsg }],
            isError: true,
          };
        }

        // Send to appropriate model based on selection with fallback capability
        const startTime = Date.now();
        const response = await sendToModelWithFallback(
          combined,
          { modelName, modelType, tokenCount },
          sendNotification,
        );

        const elapsedTime = Date.now() - startTime;

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Received response from ${modelName} in ${elapsedTime}ms`,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: response,
            },
          ],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "error",
            data: `Error in expert-review tool: ${errorMsg}`,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Add the sage-plan tool for generating implementation plans via multi-model debate
  server.tool(
    "sage-plan",
    `Generate an implementation plan via multi-model debate.

    This tool leverages multiple AI models to debate, critique, and refine implementation plans.

    Models will generate initial plans, critique each other's work, refine their plans based on critiques,
    and finally produce a consensus plan that combines the best ideas.

    IMPORTANT: All paths must be absolute paths (e.g., /home/user/project/src), not relative paths.

    The process creates detailed, well-thought-out implementation plans that benefit from
    diverse model perspectives and iterative refinement.

    When the optional outputPath parameter is provided, the final plan will be saved to that file path,
    and a complete transcript of the debate will be saved to a companion file with "-full-transcript"
    added to the filename. This is strongly recommended for preserving the expensive results of the debate.`,
    {
      prompt: z
        .string()
        .describe("The task to create an implementation plan for"),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. MUST be absolute paths (e.g., /home/user/project/src). Including directories will include all files contained within recursively.",
        ),
      rounds: z
        .number()
        .optional()
        .describe("Number of debate rounds (default: 3)"),
      maxTokens: z
        .number()
        .optional()
        .describe("Maximum token budget for the debate"),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Markdown file path to save the final plan. Will also save a full transcript to a '-full-transcript.md' suffixed file.",
        ),
      // Legacy debate flag is still supported
      debate: z
        .boolean()
        .optional()
        .default(false)
        .describe("DEPRECATED - use debateConfig.enabled instead"),
      // New debate configuration
      debateConfig: z
        .object({
          enabled: z.boolean().optional(),
          rounds: z.number().optional(),
          maxTotalTokens: z.number().optional(),
          logLevel: z.enum(["warn", "info", "debug"]).optional(),
        })
        .optional()
        .describe("Configuration options for the debate process"),
    },
    async (
      {
        prompt,
        paths,
        rounds,
        maxTokens,
        outputPath,
        debate = false,
        debateConfig,
      },
      { sendNotification },
    ) => {
      try {
        // Pack files once to reduce memory usage
        const packedFiles = await packFiles(paths);

        // Analyze token usage
        const tokenAnalysis = analyzeXmlTokens(packedFiles);

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Code context token usage: ${tokenAnalysis.totalTokens.toLocaleString()} tokens, ${tokenAnalysis.documentCount} files included`,
          },
        });

        // Combine code context with empty prompt - the actual prompt will be handled by the debate orchestrator
        const codeContext = combinePromptWithContext(packedFiles, "");

        // Determine whether to use debate and which implementation
        const useDebate: boolean =
          Boolean(debate) || Boolean(debateConfig?.enabled);
        const useNewImplementation = true; // Set to false during transition if needed

        // Legacy warning for 'debate' flag
        if (Boolean(debate)) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "warning",
              data: "The 'debate' flag is deprecated. Please use debateConfig.enabled instead.",
            },
          });
        }

        if (useDebate) {
          if (useNewImplementation) {
            // Use the new debate implementation
            await sendNotification({
              method: "notifications/message",
              params: {
                level: "info",
                data: `Using new debate implementation with ${debateConfig?.rounds || rounds || 3} rounds`,
              },
            });

            const strategy = await getStrategy(ToolType.Plan);
            if (!strategy) {
              throw new Error("Plan strategy not found");
            }

            const result = await runDebate(
              {
                toolType: ToolType.Plan,
                userPrompt: prompt,
                debateConfig: {
                  enabled: true,
                  rounds: debateConfig?.rounds || rounds || 3,
                  maxTotalTokens: debateConfig?.maxTotalTokens || maxTokens,
                  logLevel: debateConfig?.logLevel || "info",
                },
              },
              async (notification: {
                level: "info" | "debug" | "warning" | "error";
                data: string;
              }) => {
                await sendNotification({
                  method: "notifications/message",
                  params: notification,
                });
              },
            );

            // If outputPath is provided, save the plan and full transcript
            if (outputPath && "finalPlan" in result) {
              try {
                // Ensure the directory exists
                const outputDir = path.dirname(outputPath);
                if (!fs.existsSync(outputDir)) {
                  fs.mkdirSync(outputDir, { recursive: true });
                }

                // Write the final plan to the specified file
                fs.writeFileSync(outputPath, result.finalPlan, "utf8");
                await sendNotification({
                  method: "notifications/message",
                  params: {
                    level: "info",
                    data: `Successfully saved plan to: ${outputPath}`,
                  },
                });

                // Generate the full transcript filename by adding suffix before extension
                if ("debateLog" in result) {
                  const extname = path.extname(outputPath);
                  const basename = path.basename(outputPath, extname);
                  const dirname = path.dirname(outputPath);
                  const transcriptPath = path.join(
                    dirname,
                    `${basename}-full-transcript${extname}`,
                  );

                  // Format the full transcript with all debate details
                  const transcriptContent = [
                    `# Sage Plan Debate Full Transcript\n`,
                    `## Original Request\n\n${prompt}\n\n`,
                    `## Debate Statistics\n`,
                    `- Total Tokens: ${result.meta.tokenUsage.prompt + result.meta.tokenUsage.completion}`,
                    `- Warnings: ${result.meta.warnings.length}`,
                    `- Total Time: ${Math.round(result.meta.timings.totalMs)}ms`,
                    `- Rounds: ${result.meta.rounds}\n\n`,
                    `## Complete Debate Log\n\n`,
                  ].join("\n");

                  // Add the transcript entries
                  const fullContent =
                    transcriptContent +
                    result.debateLog.transcript.join("\n\n-----\n\n");

                  // Write the transcript to file
                  fs.writeFileSync(transcriptPath, fullContent, "utf8");
                  await sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      data: `Successfully saved full transcript to: ${transcriptPath}`,
                    },
                  });
                }
              } catch (error) {
                const errorMsg =
                  error instanceof Error ? error.message : String(error);
                await sendNotification({
                  method: "notifications/message",
                  params: {
                    level: "error",
                    data: `Error saving output files: ${errorMsg}`,
                  },
                });
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    "finalPlan" in result
                      ? result.finalPlan
                      : "Error: No plan generated",
                },
              ],
              metadata: {
                meta: result.meta,
              },
            };
          } else {
            // Use our adapter to bridge between old and new implementation
            await sendNotification({
              method: "notifications/message",
              params: {
                level: "info",
                data: "Using debate adapter for compatibility with legacy implementation",
              },
            });

            // Use the new debate implementation with the legacy adapter
            const result = await runDebate(
              {
                toolType: ToolType.Plan,
                userPrompt: prompt,
                debateConfig: {
                  enabled: true,
                  rounds: typeof rounds === "number" ? rounds : 3,
                  maxTotalTokens: maxTokens,
                  logLevel: "debug",
                },
              },
              async (notification: {
                level: "info" | "debug" | "warning" | "error";
                data: string;
              }) => {
                await sendNotification({
                  method: "notifications/message",
                  params: notification,
                });
              },
            );

            // Return the result directly
            if (!("finalPlan" in result)) {
              throw new Error("Failed to generate plan");
            }

            return {
              content: [{ type: "text", text: result.finalPlan }],
              metadata: {
                meta: result.meta,
                complete: result.meta.warnings.length === 0,
              },
            };
          }
        } else {
          // Non-debate mode - use single model
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: "Debate disabled. Using single-model inference.",
            },
          });

          // Create the plan prompt
          const planPrompt = `
          You are an expert software engineer. Create a detailed implementation plan for:

          ${prompt}

          Your plan should include:
          1. Components/files to be created or modified
          2. Data structures and interfaces
          3. Key functions and their purposes
          4. Implementation steps in priority order
          5. Potential challenges and solutions
          6. Testing approach

          Return the plan in Markdown format under the heading "# Implementation Plan".
          `;

          // Combine with the code context
          const combined = combinePromptWithContext(packedFiles, planPrompt);

          // Select model based on token count
          const modelSelection = selectModelBasedOnTokens(combined);
          const { modelName, modelType, tokenCount, withinLimit, tokenLimit } =
            modelSelection;

          if (!withinLimit) {
            // Handle different error cases
            let errorMsg = "";

            if (modelName === "none" && tokenLimit === 0) {
              // No API keys available
              errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${O3_TOKEN_LIMIT.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens.`;
            } else if (modelType === "openai" && !process.env.OPENAI_API_KEY) {
              // Missing OpenAI API key
              errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by O3, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
            } else if (modelType === "gemini" && !process.env.GEMINI_API_KEY) {
              // Missing Gemini API key
              errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
            } else {
              // Content exceeds all available model limits
              errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (O3: ${O3_TOKEN_LIMIT.toLocaleString()}, Gemini: ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens). Please reduce the number of files or shorten the prompt.`;
            }

            await sendNotification({
              method: "notifications/message",
              params: {
                level: "error",
                data: `Request blocked: ${process.env.OPENAI_API_KEY ? "O3 available. " : "O3 unavailable. "}${process.env.GEMINI_API_KEY ? "Gemini available." : "Gemini unavailable."}`,
              },
            });

            return {
              content: [{ type: "text", text: errorMsg }],
              isError: true,
            };
          }

          // Send to appropriate model
          const startTime = Date.now();
          const response = await sendToModelWithFallback(
            combined,
            { modelName, modelType, tokenCount },
            sendNotification,
          );

          const elapsedTime = Date.now() - startTime;

          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Received response from ${modelName} in ${elapsedTime}ms`,
            },
          });

          // If outputPath is provided, save the plan
          if (outputPath) {
            try {
              // Ensure the directory exists
              const outputDir = path.dirname(outputPath);
              if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
              }

              // Write the final plan to the specified file
              fs.writeFileSync(outputPath, response, "utf8");
              await sendNotification({
                method: "notifications/message",
                params: {
                  level: "info",
                  data: `Successfully saved plan to: ${outputPath}`,
                },
              });
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              await sendNotification({
                method: "notifications/message",
                params: {
                  level: "error",
                  data: `Error saving output file: ${errorMsg}`,
                },
              });
            }
          }

          return {
            content: [{ type: "text", text: response }],
            metadata: {
              singleModel: true,
              modelName,
              elapsedMs: elapsedTime,
            },
          };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "error",
            data: `Error in sage-plan tool: ${errorMsg}`,
          },
        });

        return {
          content: [{ type: "text", text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * Starts an MCP server using the standard I/O transport (for CLI use)
 */
async function startStdioServer() {
  try {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Use console.error for server messages since it won't interfere with stdout JSON-RPC
    console.error(
      'MCP Sage Server started with stdio transport. Available tools: "sage-opinion", "sage-review", and "sage-plan".',
    );
  } catch (error) {
    console.error("Error starting MCP server with stdio transport:", error);
    process.exit(1);
  }
}

/**
 * Starts an MCP server with HTTP transport on the specified port
 * @param port - The port to listen on
 */
async function startHttpServer(port: number = 3000) {
  const app = express();
  app.use(express.json());

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Handle MCP requests
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      // Check for existing session ID
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        const server = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            // Store the transport by session ID
            transports[newSessionId] = transport;
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        // Connect to the MCP server
        await server.connect(transport);
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      // Properly log error without console.error
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Send appropriate error response
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error: " + errorMsg,
          },
          id: null,
        });
      }
    }
  });

  // Handle GET requests for server-to-client notifications
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // Handle DELETE requests for session termination
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // Start the server
  app.listen(port, () => {
    // Use console.error for server messages since it won't interfere with stdout JSON-RPC
    console.error(
      `MCP Sage Server listening on port ${port}. Available tools: "sage-opinion", "sage-review", and "sage-plan".`,
    );
  });
}

async function main() {
  // Check if we should start in HTTP mode
  const args = process.argv.slice(2);
  if (args.includes("--http")) {
    // Get port if specified
    const portIndex = args.indexOf("--port");
    const port =
      portIndex >= 0 && args.length > portIndex + 1
        ? parseInt(args[portIndex + 1], 10)
        : 3000;

    startHttpServer(port);
  } else {
    // Default to stdio mode
    startStdioServer();
  }
}

// Handle server shutdown gracefully
process.on("SIGINT", () => {
  // Use console.error as we're shutting down and need to avoid stdout for JSON-RPC
  console.error("Shutting down server...");
  process.exit(0);
});

main();
