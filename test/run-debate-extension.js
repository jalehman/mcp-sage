/**
 * Runner script for testing the debate extension implementation
 */
const { spawn } = require('child_process');
const path = require('path');

// Set debugging flag for child process
const DEBUG_API_KEYS = false; // Set to true only when debugging API key issues

// Start the MCP server with carefully set environment
const serverEnv = Object.assign({}, process.env);
serverEnv.NODE_ENV = 'development';

// For testing the batching functionality
serverEnv.DEBUG_BATCHING = "true";
// Also reduce the wait time between batches for faster testing
serverEnv.DEBUG_BATCH_WAIT_TIME = "5000"; // 5 seconds instead of 55

// No special flags needed - we'll let the test run normally

// Path to the server script
const serverPath = path.join(__dirname, '..', 'dist', 'index.js');

// Spawn the server process
process.stderr.write("Starting MCP Sage server...\n");
const server = spawn('node', [serverPath], {
  env: serverEnv
});

// Log server error output only
server.stderr.on('data', (data) => {
  process.stderr.write(`Server Error: ${data}`);
});

// Create handlers for each phase of the test to modularize the code
// and make it easier to maintain
function createPlanHandler(server) {
  return function handlePlanResponse(response) {
    if (response.id === 2) {
      process.stderr.write("Plan Tool Response Received\n");
      
      if (response.result && response.result.content) {
        // Log the final plan
        process.stderr.write("\nFINAL IMPLEMENTATION PLAN:\n");
        process.stderr.write("==========================\n");
        process.stderr.write(response.result.content[0].text.substring(0, 500) + "...\n");
        
        // Log metadata if present
        if (response.result.metadata) {
          process.stderr.write("\nDEBATE STATISTICS:\n");
          process.stderr.write("==================\n");
          process.stderr.write(JSON.stringify(response.result.metadata) + "\n");
        }
        
        process.stderr.write("\nSAGE-PLAN TEST: SUCCESS\n");
        
        // Now test sage-opinion
        process.stderr.write('\nSending sage-opinion tool request with debate extension...\n');
        
        const opinionRequest = {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "sage-opinion",
            arguments: {
              prompt: "Is it better to use functional or class components in modern React?",
              paths: [
                path.join(__dirname, '..', 'src'),
                path.join(__dirname, '..', 'test')
              ],
              useDebate: true,
              debateConfig: {
                rounds: 2,
                logLevel: "debug"
              }
            }
          }
        };
        
        server.stdin.write(JSON.stringify(opinionRequest) + '\n');
      } else if (response.error) {
        process.stderr.write(`ERROR: ${JSON.stringify(response.error)}\n`);
      }
      return true; // Handled this response
    }
    return false; // Did not handle this response
  };
}

function createOpinionHandler(server) {
  return function handleOpinionResponse(response) {
    if (response.id === 3) {
      process.stderr.write("Opinion Tool Response Received\n");
      
      if (response.result && response.result.content) {
        // Log the final opinion
        process.stderr.write("\nFINAL EXPERT OPINION:\n");
        process.stderr.write("=====================\n");
        process.stderr.write(response.result.content[0].text.substring(0, 500) + "...\n");
        
        // Log metadata if present
        if (response.result.metadata) {
          process.stderr.write("\nDEBATE STATISTICS:\n");
          process.stderr.write("==================\n");
          process.stderr.write(JSON.stringify(response.result.metadata) + "\n");
        }
        
        process.stderr.write("\nSAGE-OPINION TEST: SUCCESS\n");
        
        // Now test sage-review
        process.stderr.write('\nSending sage-review tool request with debate extension...\n');
        
        const reviewRequest = {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "sage-review",
            arguments: {
              instruction: "Suggest improvements for error handling in this codebase",
              paths: [
                path.join(__dirname, '..', 'src'),
                path.join(__dirname, '..', 'test')
              ],
              useDebate: true,
              debateConfig: {
                rounds: 2,
                logLevel: "debug"
              }
            }
          }
        };
        
        server.stdin.write(JSON.stringify(reviewRequest) + '\n');
      } else if (response.error) {
        process.stderr.write(`ERROR: ${JSON.stringify(response.error)}\n`);
      }
      return true; // Handled this response
    }
    return false; // Did not handle this response
  };
}

function createReviewHandler(server) {
  return function handleReviewResponse(response) {
    if (response.id === 4) {
      process.stderr.write("Review Tool Response Received\n");
      
      if (response.result && response.result.content) {
        // Log the final review
        process.stderr.write("\nFINAL CODE REVIEW:\n");
        process.stderr.write("==================\n");
        process.stderr.write(response.result.content[0].text.substring(0, 500) + "...\n");
        
        // Log metadata if present
        if (response.result.metadata) {
          process.stderr.write("\nDEBATE STATISTICS:\n");
          process.stderr.write("==================\n");
          process.stderr.write(JSON.stringify(response.result.metadata) + "\n");
        }
        
        process.stderr.write("\nSAGE-REVIEW TEST: SUCCESS\n");
        process.stderr.write("\nALL TESTS COMPLETED SUCCESSFULLY\n");
        
        // Exit after all tests are done
        setTimeout(() => {
          server.kill();
          process.exit(0);
        }, 100);
      } else if (response.error) {
        process.stderr.write(`ERROR: ${JSON.stringify(response.error)}\n`);
      }
      return true; // Handled this response
    }
    return false; // Did not handle this response
  };
}

// Create the handler functions
const planHandler = createPlanHandler(server);
const opinionHandler = createOpinionHandler(server);
const reviewHandler = createReviewHandler(server);

// Wait a bit for server to start
setTimeout(() => {
  process.stderr.write('Test started, sending initialize request...\n');
  process.stderr.write(`Using paths: ${JSON.stringify([
    path.join(__dirname, '..', 'src'),
    path.join(__dirname, '..', 'test')
  ])}\n`);
  
  // Send initialize request with all required fields
  const initializeRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      client: {
        name: "test-client",
        version: "1.0.0"
      },
      protocolVersion: "2024-03-26", // Required protocol version
      clientInfo: {
        name: "test-client",
        version: "1.0.0"
      },
      capabilities: {
        tools: {}, // Support for tool calls
        resources: {}, // Support for prompts
        prompts: {} // Support for prompts
      }
    }
  };
  
  server.stdin.write(JSON.stringify(initializeRequest) + '\n');
  
  // Wait for initialize response
  let responseBuffer = '';
  
  server.stdout.on('data', (data) => {
    responseBuffer += data.toString();
    
    if (responseBuffer.includes('\n')) {
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop(); // Keep the incomplete line
      
      lines.forEach(line => {
        if (!line) return;
        
        try {
          const response = JSON.parse(line);
          // Don't log received responses to stdout as it interferes with the JSON-RPC protocol
          process.stderr.write(`Received response: ${JSON.stringify(response)}\n`);
          
          // If it's the initialize response, send the tool call
          if (response.id === 1 && response.result) {
            process.stderr.write('Sending sage-plan tool request with debate extension...\n');
            
            const toolRequest = {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "sage-plan",
                arguments: {
                  prompt: "Create a lightweight state management library for React",
                  paths: [
                    path.join(__dirname, '..', 'src'),
                    path.join(__dirname, '..', 'test')
                  ],
                  debateConfig: {
                    enabled: true,
                    rounds: 2, // Use fewer rounds for testing to speed it up
                    logLevel: "debug"
                  }
                }
              }
            };
            
            server.stdin.write(JSON.stringify(toolRequest) + '\n');
          }
          
          // Handle notifications
          if (response.method && response.method.startsWith("notifications/")) {
            // Process the notification but don't log to stdout
            // (logging would interfere with the JSON-RPC protocol)
            
            // This is just used to process the notification, we don't need to log anything
            if (response.params.method && response.params.method.startsWith("notifications/")) {
              process.stderr.write(`Notification: ${response.params.params.level} - ${response.params.params.data}\n`);
            } else {
              process.stderr.write(`Notification: ${response.params.level} - ${response.params.data}\n`);
            }
            
            return;
          }
          
          // Try each phase handler in sequence
          if (planHandler(response) || opinionHandler(response) || reviewHandler(response)) {
            // One of the handlers processed this response
            return;
          }
        } catch (err) {
          process.stderr.write(`Error parsing response: ${err}\n`);
          process.stderr.write(`Raw data: ${line}\n`);
        }
      });
    }
  });
}, 1000);

// Handle server exit
server.on('close', (code) => {
  process.stderr.write(`Server exited with code ${code}\n`);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  process.stderr.write('Caught interrupt signal\n');
  server.kill();
  process.exit();
});

// No timeout - let the test run to completion
// This will let the full debate process finish properly