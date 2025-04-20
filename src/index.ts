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
import { exec } from "child_process";
import { promisify } from "util";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// Import shared functions from gemini.ts
import { sendGeminiPrompt } from "./gemini";

const execPromise = promisify(exec);

// The maximum token limit for Gemini 2.5 Pro
const MAX_TOKEN_LIMIT = 1000000;

/**
 * Packs a list of file paths into a single XML string.
 * @param paths - Paths to files to include in the context
 * @returns The XML packed string
 */
async function packFiles(paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return "<documents></documents>";
  }

  try {
    // Construct the command to run the pack tool
    const pathArgs = paths.map((p) => `"${p}"`).join(" ");
    const { stdout } = await execPromise(
      `node ${path.join(__dirname, "pack.js")} ${pathArgs}`,
    );
    return stdout;
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
 * Checks if the combined content is within the token limit.
 * @param combined - The combined prompt with context
 * @returns Whether the content is within limits
 */
function isWithinTokenLimit(combined: string): boolean {
  const tokenAnalysis = analyzeXmlTokens(combined);
  return tokenAnalysis.totalTokens <= MAX_TOKEN_LIMIT;
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

    Do not worry about context limits; feel free to include as much as you think is relevant. If you include too much it will error and tell you, and then you can include less. Err on the side of including more context.`,
    {
      prompt: z.string().describe("The prompt to send to the external model."),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. Including directories will include all files contained within recursively.",
        ),
    },
    async ({ prompt, paths }, { sendNotification }) => {
      try {
        // Pack the files
        const packedFiles = await packFiles(paths);

        // Combine with the prompt
        const combined = combinePromptWithContext(packedFiles, prompt);

        // Check token limit and get token count
        const tokenAnalysis = analyzeXmlTokens(combined);

        // Log token usage via MCP logging notification
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Token usage: ${tokenAnalysis.totalTokens.toLocaleString()} / ${MAX_TOKEN_LIMIT.toLocaleString()} tokens (${((tokenAnalysis.totalTokens / MAX_TOKEN_LIMIT) * 100).toFixed(2)}%)`,
          },
        });

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Files included: ${paths.length}, Document count: ${tokenAnalysis.documentCount}`,
          },
        });

        if (tokenAnalysis.totalTokens > MAX_TOKEN_LIMIT) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Token limit exceeded. Request blocked.`,
            },
          });

          return {
            content: [
              {
                type: "text",
                text: `Error: The combined content exceeds the token limit for Gemini 2.5 Pro (1M tokens). Current usage: ${tokenAnalysis.totalTokens.toLocaleString()} tokens.`,
              },
            ],
            isError: true,
          };
        }

        // Send to Gemini
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Sending request to Gemini with ${tokenAnalysis.totalTokens.toLocaleString()} tokens...`,
          },
        });

        const startTime = Date.now();
        const response = await sendGeminiPrompt(combined);
        const elapsedTime = Date.now() - startTime;

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Received response from Gemini in ${elapsedTime}ms`,
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

    If the user hasn't provided specific paths, use as many paths to files or directories as you're aware of that are useful in the context of the prompt.`,
    {
      instruction: z
        .string()
        .describe("The specific changes or improvements needed."),
      paths: z
        .array(z.string())
        .describe(
          "Paths to include as context. Including directories will include all files contained within recursively.",
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

        // Check token limit and get token count
        const tokenAnalysis = analyzeXmlTokens(combined);

        // Log token usage via MCP logging notification
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Token usage: ${tokenAnalysis.totalTokens.toLocaleString()} / ${MAX_TOKEN_LIMIT.toLocaleString()} tokens (${((tokenAnalysis.totalTokens / MAX_TOKEN_LIMIT) * 100).toFixed(2)}%)`,
          },
        });

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "debug",
            data: `Files included: ${paths.length}, Document count: ${tokenAnalysis.documentCount}`,
          },
        });

        if (tokenAnalysis.totalTokens > MAX_TOKEN_LIMIT) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: `Token limit exceeded. Request blocked.`,
            },
          });

          return {
            content: [
              {
                type: "text",
                text: `Error: The combined content exceeds the token limit for Gemini 2.5 Pro (1M tokens). Current usage: ${tokenAnalysis.totalTokens.toLocaleString()} tokens.`,
              },
            ],
            isError: true,
          };
        }

        // Send to Gemini
        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Sending request to Gemini with ${tokenAnalysis.totalTokens.toLocaleString()} tokens...`,
          },
        });

        const startTime = Date.now();
        const response = await sendGeminiPrompt(combined);
        const elapsedTime = Date.now() - startTime;

        await sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            data: `Received response from Gemini in ${elapsedTime}ms`,
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

    console.log(
      'MCP Sage Server started with stdio transport. Use the "second-opinion" or "expert-review" tools to query Gemini with context.',
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
    console.log(
      `MCP Sage Server listening on port ${port}. Use the "second-opinion" or "expert-review" tools to query Gemini with context.`,
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
  // Use a simple console.log here as we're shutting down and can't use MCP notifications
  console.log("Shutting down server...");
  process.exit(0);
});

main();
