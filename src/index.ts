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
  O3_MODEL_NAME,
  O3_TOKEN_LIMIT,
} from "./modelManager";

// Import debate orchestrator for sage-plan
import { debate } from "./debateOrchestrator";

async function packFiles(paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return "<documents></documents>";
  }

  try {
    // Use the direct packFilesSync function instead of spawning a subprocess
    return packFilesSync(paths, {
      includeHidden: false,
      respectGitignore: true,
      includeLineNumbers: true
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
function isWithinTokenLimit(combined: string, limit: number = GEMINI_TOKEN_LIMIT): boolean {
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
    },
    async ({ prompt, paths }, { sendNotification }) => {
      try {
        // Pack the files
        const packedFiles = await packFiles(paths);

        // Combine with the prompt
        const combined = combinePromptWithContext(packedFiles, prompt);

        // Select model based on token count and get token information
        const modelSelection = selectModelBasedOnTokens(combined);
        const { modelName, modelType, tokenCount, withinLimit, tokenLimit } = modelSelection;

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
          
          if (modelName === 'none' && tokenLimit === 0) {
            // No API keys available
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${O3_TOKEN_LIMIT.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens.`;
          } else if (modelType === 'openai' && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by O3, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === 'gemini' && !process.env.GEMINI_API_KEY) {
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

        // Send to appropriate model based on selection with fallback capability
        const startTime = Date.now();
        const response = await sendToModelWithFallback(
          combined, 
          { modelName, modelType, tokenCount },
          sendNotification
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
            data: `Error in second-opinion tool: ${errorMsg}`,
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
    },
    async ({ instruction, paths }, { sendNotification }) => {
      try {
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
        const { modelName, modelType, tokenCount, withinLimit, tokenLimit } = modelSelection;

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
          
          if (modelName === 'none' && tokenLimit === 0) {
            // No API keys available
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${O3_TOKEN_LIMIT.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens.`;
          } else if (modelType === 'openai' && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by O3, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === 'gemini' && !process.env.GEMINI_API_KEY) {
            // Missing Gemini API key
            errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
          } else {
            // Content exceeds all available model limits
            errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (O3: ${O3_TOKEN_LIMIT.toLocaleString()}, Gemini: ${GEMINI_TOKEN_LIMIT.toLocaleString()} tokens). Please reduce the number of files or shorten the instruction.`;
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
          sendNotification
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
    diverse model perspectives and iterative refinement.`,
    {
      prompt: z.string().describe("The task to create an implementation plan for"),
      paths: z.array(z.string()).describe("Paths to include as context. MUST be absolute paths (e.g., /home/user/project/src). Including directories will include all files contained within recursively."),
      rounds: z.number().optional().describe("Number of debate rounds (default: 3)"),
      maxTokens: z.number().optional().describe("Maximum token budget for the debate"),
    },
    async ({ prompt, paths, rounds, maxTokens }, { sendNotification }) => {
      try {
        // Pack files once to reduce memory usage
        const packedFiles = await packFiles(paths);
        
        // Analyze token usage
        const { analyzeXmlTokens } = await import("./tokenCounter");
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
        
        // Create abort controller for timeout handling
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
          abortController.abort('Debate timeout exceeded');
        }, 10 * 60 * 1000); // 10 minute default timeout
        
        try {
          // Use debate orchestrator
          const { finalPlan, logs, stats, complete } = await debate(
            { 
              paths, 
              userPrompt: prompt, 
              codeContext,
              rounds,
              maxTotalTokens: maxTokens,
              abortSignal: abortController.signal 
            },
            // Forward notifications
            async (notification) => {
              await sendNotification({
                method: "notifications/message",
                params: notification
              });
            }
          );
          
          // Format logs for readable output
          const formattedLogs = logs.map(entry => 
            `## Round ${entry.round} | ${entry.phase} | Model ${entry.modelId}\n\n${entry.response}\n\n`
          ).join('\n---\n\n');
          
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Debate completed successfully. Total tokens: ${stats.totalTokens.toLocaleString()}, Total API calls: ${stats.totalApiCalls}`,
            },
          });
          
          return {
            content: [
              { type: "text", text: finalPlan }
            ],
            metadata: { 
              stats,
              complete,
              debateRounds: logs.length > 0 ? Math.max(...logs.map(entry => entry.round)) : 0
            }
          };
        } finally {
          clearTimeout(timeoutId);
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
