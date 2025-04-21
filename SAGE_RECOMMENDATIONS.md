# Sage Code Review Recommendations

## Overall Assessment

The `mcp-sage` project provides a useful utility by wrapping complex file packing and multi-model LLM interaction logic behind the standardized Model Context Protocol (MCP). It correctly identifies a valuable use case (leveraging large context models) and implements core functionality, including dynamic model selection based on token count and API key availability, as well as a fallback mechanism. The use of MCP allows it to integrate readily with various client applications.

However, there are several areas where the architecture, code organization, and testing strategy could be improved to enhance maintainability, robustness, and clarity.

## Positive Aspects

1. **Clear Purpose:** The project addresses a specific, well-defined need: providing large-context opinions and reviews using appropriate LLMs.
2. **MCP Integration:** Correctly utilizes the `@modelcontextprotocol/sdk` to expose functionality through standard MCP tools (`sage-opinion`, `sage-review`).
3. **Input Validation:** Uses `zod` schemas within the tool definitions (`src/index.ts`) for robust input validation.
4. **Model Selection Logic:** Implements clear logic for choosing between O3 and Gemini based on token limits and API key presence (`src/index.ts`).
5. **Fallback Mechanism:** Includes fallback logic from O3 to Gemini in case of network issues (`src/index.ts`, `src/openai.ts`), improving resilience.
6. **Modularity (Partial):** Core functionalities like token counting (`src/tokenCounter.ts`), file packing (`src/pack.ts`), and LLM interaction (`src/openai.ts`, `src/gemini.ts`) are separated into distinct files.
7. **Configuration:** Uses environment variables for API keys, which is standard practice.

## Recommendations for Improvement

### 1. Architecture & Code Organization

- ✅ **Refactor `packFiles` Integration:** (COMPLETED)
  - **Issue:** Currently, `src/index.ts` calls the file packing functionality by executing `src/pack.ts` as a separate Node.js process using `execPromise` (`packFiles` function in `index.ts`). This adds unnecessary overhead (process spawning), makes error handling more complex (parsing stdout/stderr), and prevents easy type sharing or direct function calls.
  - **Recommendation:** Refactor `src/pack.ts` so its core packing logic (e.g., `processPath`, `processDirectory`, `processFile`, `formatFileAsXml`) can be exported as functions. Import and call these functions directly within `src/index.ts`. The CLI part of `pack.ts` (using `commander`) can be kept separate or removed if its primary purpose is now programmatic use within the server. This will simplify the code, improve performance, and make error handling more direct.
  - **Implementation:** Completed in commit 3453f35. Exported core packing functions, added a new `packFilesSync` function, and modified `index.ts` to use it directly instead of spawning a subprocess.

- ✅ **Centralize Model Logic:** (COMPLETED)
  - **Issue:** The logic for selecting the model (`selectModelBasedOnTokens`) and sending the request with fallback (`sendToModelWithFallback`) resides directly within `src/index.ts`. While functional, this makes `index.ts` quite large and mixes MCP server setup with core LLM interaction logic.
  - **Recommendation:** Create a new module (e.g., `src/modelManager.ts` or similar) responsible for:
    - Holding model constants (names, token limits).
    - Containing the `selectModelBasedOnTokens` logic.
    - Containing the `sendToModelWithFallback` logic (or a refactored version).
    - Potentially abstracting the `sendOpenAiPrompt` and `sendGeminiPrompt` calls behind a unified interface.
    `src/index.ts` would then call functions from this module, simplifying its own responsibilities.
  - **Implementation:** Completed in commit 822f803. Created a new `modelManager.ts` module that centralizes all model logic and constants, simplifying `index.ts` by removing duplicated code.

- **Consolidate Constants:** Model names (`O3_MODEL_NAME`, Gemini model name) and token limits (`O3_TOKEN_LIMIT`, `GEMINI_TOKEN_LIMIT`) are defined across `openai.ts`, `gemini.ts`, and `index.ts`. Centralize these in a single constants file or within the proposed `modelManager.ts` for easier management.

- **Refine CLI Entry Points:** The project has `bin` entries for `pack` and `gemini` in `package.json`, and both `src/pack.ts` and `src/gemini.ts` use `commander` for CLI parsing. Evaluate if these standalone CLIs are necessary beyond the main MCP server functionality in `index.ts`. If `pack.ts` is refactored as recommended above, its CLI might be redundant. The `gemini.ts` CLI seems useful for testing/utility but could potentially be moved to a separate utility script if not core to the *server's* operation.

### 2. Dependencies and API Usage

- ❌ **Use Gemini SDK:** (DECIDED AGAINST)
  - **Issue:** `src/gemini.ts` uses raw `fetch` calls to interact with the Google Generative AI API, while `src/openai.ts` uses the official `openai` SDK. The project already lists `@google/genai` as a dependency.
  - **Recommendation:** Refactor `src/gemini.ts` to use the `@google/genai` SDK. This provides better abstraction, potentially improved error handling, type safety, and consistency with the OpenAI client implementation.
  - **Decision:** After evaluating the current SDK version (0.9.0), we decided against this refactoring. The SDK's API surface is not well documented, has inconsistent TypeScript type definitions, and our current implementation is working reliably. The custom implementation also gives us precise control over error handling and fallback mechanisms.

- **Unused Code (`EXT_TO_LANG`):** The `EXT_TO_LANG` map in `src/pack.ts` is defined but doesn't appear to be used in the provided code to add language hints (like `<document language="typescript">`). Either utilize this map to add language information to the XML output (which could potentially help the LLM) or remove it if unused.

### 3. Testing Strategy

- **Unit Tests:**
  - **Issue:** The current tests (`test/` directory) seem to be primarily integration tests that spawn the server process. There's a lack of unit tests for core, isolated logic.
  - **Recommendation:** Implement unit tests using a framework like Jest or Vitest for:
    - `src/tokenCounter.ts`: Verify token counting accuracy and fallback.
    - `src/pack.ts`: Test file filtering (.gitignore), recursion, line numbering, and XML formatting logic independently.
    - `src/modelManager.ts` (if created): Test the `selectModelBasedOnTokens` logic under various conditions (different token counts, API keys present/missing).

- **Integration Tests:**
  - **Issue:** The existing integration tests (`run-test.js`, `test-expert.js`, `test-o3.js`, `simple-test.js`) appear somewhat fragmented and rely on potentially brittle process spawning and stdio interaction. Test naming (`second-opinion`/`expert-review`) doesn't match final tool names (`sage-opinion`/`sage-review`).
  - **Recommendation:** Consolidate integration tests. Consider using the `@modelcontextprotocol/sdk` client *within* the tests to interact with the spawned server process via the defined protocol. This is generally more robust than piping raw JSON strings. Rename tests and tool calls within tests to match the final implementation (`sage-opinion`, `sage-review`). Ensure tests cover O3 usage, Gemini usage, and the fallback scenario.

- **Test Coverage:** Aim for better coverage, especially with the addition of unit tests for critical components.

### 4. Maintainability and Readability

- **Comments:** Add more comments explaining the *why* behind certain complex logic sections, particularly in `selectModelBasedOnTokens` and `sendToModelWithFallback` in `src/index.ts`.

- **Configuration Loading:** While environment variables are fine, for more complex configurations in the future, consider a dedicated configuration loading module (though likely overkill for the current scope).

- **README Accuracy:** Ensure the README accurately reflects the final tool names (`sage-opinion`, `sage-review`) and potentially update test script names/commands if they are refactored. The example test commands in the README (`test/run-test.js`, `test/test-expert.js`, `test/test-o3.js`) should be verified against the actual test structure.

## Summary

`mcp-sage` is a functional and useful MCP server. The key areas for improvement lie in architectural refinement (especially reducing process spawning for internal tasks), standardizing API client usage (using the Gemini SDK), and bolstering the testing strategy with unit tests and more robust integration tests. Addressing these points will significantly improve the codebase's maintainability, testability, and overall robustness.