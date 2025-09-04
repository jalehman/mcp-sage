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
} from "./modelManager";
import { getModelById } from "./modelConfig";

// Import strategy registry
import { getStrategy } from "./strategies/registry";
import { ToolType } from "./types/public";

// Import the new debate orchestrator and the legacy adapter
import { runDebate } from "./orchestrator/debateOrchestrator";

// Load all strategies to ensure they register themselves

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

    Do not worry about context limits; feel free to include as much as you think is relevant. If you include too much it will error and tell you, and then you can include less. Err on the side of including more context.
    
    If the user mentiones "sages" plural, or asks for a debate explicitly, set debate to true.
    `,
    {
      prompt: z.string().describe("The prompt to send to the external model."),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. MUST be absolute paths (e.g., /home/user/project/src). Including directories will include all files contained within recursively.",
        ),
      debate: z
        .boolean()
        .describe("Set to true when a multi-model debate should ensue (e.g., when the user mentions 'sages' plural)."),
    },
    async ({ prompt, paths, debate }, { sendNotification }) => {
      try {
        // Pack the files up front - we'll need them in either case
        const packedFiles = await packFiles(paths);

        // Check if debate is enabled
        if (debate) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Using debate mode for sage-opinion`,
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
                rounds: 1,
                logLevel: "debug",
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
        const modelSelection = selectModelBasedOnTokens(combined, 'opinion');
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
            // Get token limits from config for error message
            const gpt5Model = getModelById('gpt5');
            const geminiModel = getModelById('gemini25pro');
            const gpt5Limit = gpt5Model ? gpt5Model.tokenLimit : 400000;
            const geminiLimit = geminiModel ? geminiModel.tokenLimit : 1000000;
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${gpt5Limit.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${geminiLimit.toLocaleString()} tokens.`;
          } else if (modelType === "openai" && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by GPT-5, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === "gemini" && !process.env.GEMINI_API_KEY) {
            // Missing Gemini API key
            errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
          } else {
            // Content exceeds all available model limits
            // Get token limits from config for error message
            const gpt5Model = getModelById('gpt5');
            const geminiModel = getModelById('gemini25pro');
            const gpt5Limit = gpt5Model ? gpt5Model.tokenLimit : 400000;
            const geminiLimit = geminiModel ? geminiModel.tokenLimit : 1000000;
            errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (GPT-5: ${gpt5Limit.toLocaleString()}, Gemini: ${geminiLimit.toLocaleString()} tokens). Please reduce the number of files or shorten the prompt.`;
          }

          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Request blocked: ${process.env.OPENAI_API_KEY ? "OpenAI API available. " : "OpenAI API unavailable. "}${process.env.GEMINI_API_KEY ? "Gemini available." : "Gemini unavailable."}`,
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
      debate: z
        .boolean()
        .optional()
        .describe("Set to true when a multi-model debate should ensue"),
    },
    async ({ instruction, paths, debate }, { sendNotification }) => {
      try {
        // Check if debate is enabled
        if (debate) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Using debate mode for sage-review`,
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
                rounds: 1,
                logLevel: "debug",
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
        const modelSelection = selectModelBasedOnTokens(combined, 'review');
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
            // Get token limits from config for error message
            const gpt5Model = getModelById('gpt5');
            const geminiModel = getModelById('gemini25pro');
            const gpt5Limit = gpt5Model ? gpt5Model.tokenLimit : 400000;
            const geminiLimit = geminiModel ? geminiModel.tokenLimit : 1000000;
            errorMsg = `Error: No API keys available. Please set OPENAI_API_KEY for contexts up to ${gpt5Limit.toLocaleString()} tokens or GEMINI_API_KEY for contexts up to ${geminiLimit.toLocaleString()} tokens.`;
          } else if (modelType === "openai" && !process.env.OPENAI_API_KEY) {
            // Missing OpenAI API key
            errorMsg = `Error: OpenAI API key not set. This content (${tokenCount.toLocaleString()} tokens) could be processed by GPT-5, but OPENAI_API_KEY is missing. Please set the environment variable or use a smaller context.`;
          } else if (modelType === "gemini" && !process.env.GEMINI_API_KEY) {
            // Missing Gemini API key
            errorMsg = `Error: Gemini API key not set. This content (${tokenCount.toLocaleString()} tokens) requires Gemini's larger context window, but GEMINI_API_KEY is missing. Please set the environment variable.`;
          } else {
            // Content exceeds all available model limits
            // Get token limits from config for error message
            const gpt5Model = getModelById('gpt5');
            const geminiModel = getModelById('gemini25pro');
            const gpt5Limit = gpt5Model ? gpt5Model.tokenLimit : 400000;
            const geminiLimit = geminiModel ? geminiModel.tokenLimit : 1000000;
            errorMsg = `Error: The combined content (${tokenCount.toLocaleString()} tokens) exceeds the maximum token limit for all available models (GPT-5: ${gpt5Limit.toLocaleString()}, Gemini: ${geminiLimit.toLocaleString()} tokens). Please reduce the number of files or shorten the instruction.`;
          }

          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Request blocked: ${process.env.OPENAI_API_KEY ? "OpenAI API available. " : "OpenAI API unavailable. "}${process.env.GEMINI_API_KEY ? "Gemini available." : "Gemini unavailable."}`,
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
      'MCP Sage Server started with stdio transport. Available tools: "sage-opinion" and "sage-review".',
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
      `MCP Sage Server listening on port ${port}. Available tools: "sage-opinion" and "sage-review".`,
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
