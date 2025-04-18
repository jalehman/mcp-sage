# `mcp-sage`

An MCP (Model Context Protocol) server that provides tools for sending prompts to another LLM (currently only Gemini 2.5 Pro) that embed all referenced filepaths (recursively for folders) in the prompt. Useful for getting second opinions or detailed code reviews from a model that can handle tons of context accurately.

## Rationale

I make heavy use of Claude Code. It's a great product that works well for my workflow. Newer models with large amounts of context seem really useful though for dealing with more complex codebases where more context is needed. This lets me continue to use Claude Code as a development tool while leveraging the large context of Gemini 2.5 Pro to augment Claude Code's limited context.

## Overview

This project implements an MCP server that exposes two tools:

### second-opinion tool

1. Takes a prompt and a list of file/dir paths as input
2. Packs the files into a structured XML format
3. Checks if the combined content is within Gemini's token limit (1M tokens)
4. Sends the combined prompt + context to Gemini 2.5 Pro
5. Returns the model's response

### expert-review tool

1. Takes an instruction for code changes and a list of file/dir paths as input
2. Packs the files into a structured XML format
3. Checks if the combined content is within Gemini's token limit (1M tokens)
4. Creates a specialized prompt instructing the model to format responses using SEARCH/REPLACE blocks
5. Sends the combined context + instruction to Gemini 2.5 Pro
6. Returns edit suggestions formatted as SEARCH/REPLACE blocks for easy implementation

## Prerequisites

- Node.js (v18 or later)
- A Google Gemini API key

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/mcp-sage.git
cd mcp-sage

# Install dependencies
npm install

# Build the project
npm run build
```

## Environment Variables

Set the following environment variable:

- `GEMINI_API_KEY`: Your Google Gemini API key

## Usage

After building with `npm run build`, add the following to your MCP configuration:

```sh
GEMINI_API_KEY=XXX node /path/to/this/repo/dist/index.js
```

## Prompting

To get a second opinion on something just ask for a second opinion.

To get a code review, ask for a code review or expert review.

Both of these benefit from providing paths of files that you wnat to be included in context, but if omitted the host LLM will probably infer what to include.

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

### Using the Tools

#### second-opinion Tool

The `second-opinion` tool accepts the following parameters:

- `prompt` (string, required): The prompt to send to Gemini
- `paths` (array of strings, required): List of file paths to include as context

Example MCP tool call (using JSON-RPC 2.0):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "second-opinion",
    "arguments": {
      "prompt": "Explain how this code works",
      "paths": ["path/to/file1.js", "path/to/file2.js"]
    }
  }
}
```

#### expert-review Tool

The `expert-review` tool accepts the following parameters:

- `instruction` (string, required): The specific changes or improvements needed
- `paths` (array of strings, required): List of file paths to include as context

Example MCP tool call (using JSON-RPC 2.0):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "expert-review",
    "arguments": {
      "instruction": "Add error handling to the function",
      "paths": ["path/to/file1.js", "path/to/file2.js"]
    }
  }
}
```

The response will contain SEARCH/REPLACE blocks that you can use to implement the suggested changes:

```
<<<<<<< SEARCH
function getData() {
  return fetch('/api/data')
    .then(res => res.json());
}
=======
function getData() {
  return fetch('/api/data')
    .then(res => {
      if (!res.ok) {
        throw new Error(`HTTP error! Status: ${res.status}`);
      }
      return res.json();
    })
    .catch(error => {
      console.error('Error fetching data:', error);
      throw error;
    });
}
>>>>>>> REPLACE
```

## Running the Tests

To test the tools:

```bash
# Test the second-opinion tool
GEMINI_API_KEY=your_api_key_here node test/run-test.js

# Test the expert-review tool
GEMINI_API_KEY=your_api_key_here node test/test-expert.js
```

## Project Structure

- `src/index.ts`: The main MCP server implementation with tool definitions
- `src/pack.ts`: Tool for packing files into a structured XML format
- `src/tokenCounter.ts`: Utilities for counting tokens in a prompt
- `src/gemini.ts`: Gemini API client implementation
- `test/run-test.js`: Test for the second-opinion tool
- `test/test-expert.js`: Test for the expert-review tool

## License

ISC
