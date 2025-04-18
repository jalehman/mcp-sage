# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test Commands
- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Build and run the server in stdio mode
- `npm run dev:http` - Build and run the server in HTTP mode
- `npm run start` - Run the compiled server in stdio mode
- `npm run start:http` - Run the compiled server in HTTP mode
- `node test/simple-test.js` - Run a simple test of the server
- `node test/run-test.js` - Run a more complex test of the server
- `node test/test-gemini.js` - Test the Gemini integration

## Code Style Guidelines
- TypeScript with strict typing
- Use async/await for asynchronous operations
- Error handling with try/catch blocks and explicit error messages
- Document public functions and types with JSDoc comments
- Use camelCase for variables and functions, PascalCase for types and classes
- Import sorting: Node built-ins first, then external packages, then local imports
- Prefer named exports over default exports
- Use zod for input validation and runtime type checking
- Log through MCP notification system rather than console.log when in server context