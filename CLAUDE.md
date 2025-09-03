# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands
- Build: `npm run build`
- Run: `npm run start` or `npm run start:http`
- Dev mode: `npm run dev` or `npm run dev:http`
- Run a single test: `node test/run-test.js` (replace with specific test file)
- Pack files: `npm run pack`
- Gemini: `npm run gemini`

## Code Style Guidelines
- **TypeScript**: Use strict typing with interfaces and types
- **Imports**: Group imports by external packages, then internal modules
- **Formatting**: Use spaces for indentation, semicolons, and trailing commas
- **Functions**: Document with JSDoc comments, especially for public functions
- **Error Handling**: Use try/catch with appropriate error propagation
- **Naming**: Use camelCase for variables/functions, PascalCase for classes/interfaces
- **Best Practices**: Avoid any/unknown types, use async/await for promises
- **Model Selection**: Consider token limits when selecting AI models
- Do not add timeouts anywhere at any time unless explicitly asked to do so.