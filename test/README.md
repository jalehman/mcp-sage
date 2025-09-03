# MCP Sage Tests

This directory contains tests for the MCP Sage toolkit.

## Test Scripts

- `run-sage-plan.js` - Tests the `sage-plan` tool with and without debate
- `run-debate-extension.js` - Tests the debate extension for all three tool types
- `run-test.js` - Tests the sage-opinion tool with a simple prompt
- `run-sage-review.js` - Tests the sage-review tool
- `run-sage-opinion-debate.js` - Tests the sage-opinion tool with debate functionality enabled

## Troubleshooting

### Template Files

If you encounter errors like:

```
Error in sage-plan tool: Failed to load prompt template for plan/generate: ENOENT: no such file or directory
```

Make sure to:

1. Check that the template files exist in `src/prompts/templates/[toolType]/*.txt`
2. Run `npm run build` to ensure templates are copied to the `dist` directory
3. Verify that the copy-templates script executed properly

### JSON-RPC Protocol

Ensure all initialize requests have the proper protocol version and capabilities:

```javascript
const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    client: {
      name: "test-client",
      version: "1.0.0"
    },
    protocolVersion: "2024-03-26", // Required
    clientInfo: {
      name: "test-client",
      version: "1.0.0"
    },
    capabilities: {
      tools: {}, // Required
      resources: {}, 
      prompts: {} 
    }
  }
};
```

### Test Performance

For faster testing:

1. Use `DEBUG_BATCH_WAIT_TIME="5000"` to reduce batch wait times
2. Set `rounds: 2` in debate configs to limit iterations 
3. Consider using `setTimeout()` with a reasonable timeout to prevent tests from running too long

## Running Tests

Run individual tests with:

```bash
node test/run-debate-extension.js
node test/run-sage-plan.js
```

### Note about the Debate Extension Test

The `run-debate-extension.js` test comprehensively verifies the debate extension functionality by:

1. Starting the server successfully
2. Establishing JSON-RPC protocol communication
3. Loading prompt templates correctly
4. Making API calls to models
5. Running the complete debate process for all three tool types:
   - sage-plan
   - sage-opinion
   - sage-review

The test will run to completion without any timeout, allowing all models to complete their full debate cycle. This ensures the entire system is working properly from end to end.

A successful test will complete all three tool tests and exit with code 0. This confirms that all components of the debate extension are working correctly.