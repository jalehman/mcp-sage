# MCP Sidebar Server

An MCP (Model Context Protocol) server that provides a `sidebar` tool for sending prompts to Gemini 2.5 Pro with file context.

## Overview

This project implements an MCP server that exposes a `sidebar` tool which:

1. Takes a prompt and a list of file paths as input
2. Packs the files into a structured XML format
3. Checks if the combined content is within Gemini's token limit (1M tokens)
4. Sends the combined prompt + context to Gemini 2.5 Pro
5. Returns the model's response

## Prerequisites

- Node.js (v18 or later)
- A Google Gemini API key

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/mcp-sidebar.git
cd mcp-sidebar

# Install dependencies
npm install

# Build the project
npm run build
```

## Environment Variables

Set the following environment variable:

- `GEMINI_API_KEY`: Your Google Gemini API key

## Usage

### Starting the Server

You can start the server in two modes:

#### 1. Standard I/O (CLI) Mode

```bash
npm start
```

#### 2. HTTP Mode

```bash
npm run start:http

# With a custom port
npm run start:http -- --port 3001
```

### Debugging and Monitoring

The server provides detailed monitoring information via the MCP logging capability. These logs include:

- Token usage statistics (tokens used vs. token limit)
- Number of files and documents included in the request
- Request processing time metrics
- Error information when token limits are exceeded

Logs are sent via the MCP protocol's `notifications/message` method, ensuring they don't interfere with the JSON-RPC communication. MCP clients with logging support will display these logs appropriately.

Example log entries:
```
Token usage: 1,234 / 1,000,000 tokens (0.12%)
Files included: 3, Document count: 3
Sending request to Gemini with 1,234 tokens...
Received response from Gemini in 982ms
```

### Using the `sidebar` Tool

The `sidebar` tool accepts the following parameters:

- `prompt` (string, required): The prompt to send to Gemini
- `paths` (array of strings, required): List of file paths to include as context

Example MCP tool call (using JSON-RPC 2.0):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "sidebar",
    "arguments": {
      "prompt": "Explain how this code works",
      "paths": ["path/to/file1.js", "path/to/file2.js"]
    }
  }
}
```

## Running the Test

To run a simple test:

```bash
GEMINI_API_KEY=your_api_key_here node test/run-test.js
```

## Project Structure

- `src/index.ts`: The main MCP server implementation
- `src/pack.ts`: Tool for packing files into a structured XML format
- `src/tokenCounter.ts`: Utilities for counting tokens in a prompt
- `src/gemini.ts`: Gemini API client implementation

## License

ISC