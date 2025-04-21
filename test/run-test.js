const { spawn } = require('child_process');
const path = require('path');

// Set debugging flag for child process
const DEBUG_API_KEYS = false; // Set to true only when debugging API key issues

// Log keys for debugging (sanitized) - only when troubleshooting
if (DEBUG_API_KEYS) {
  if (process.env.OPENAI_API_KEY) {
    const openaiKey = process.env.OPENAI_API_KEY;
    console.error(`Parent process OPENAI_API_KEY: ${openaiKey.substring(0, 7)}...${openaiKey.substring(openaiKey.length - 4)}`);
  }

  if (process.env.GEMINI_API_KEY) {
    const geminiKey = process.env.GEMINI_API_KEY;
    console.error(`Parent process GEMINI_API_KEY: ${geminiKey.substring(0, 7)}...${geminiKey.substring(geminiKey.length - 4)}`);
  }
}

// Start the MCP server with carefully set environment
const serverEnv = Object.assign({}, process.env);
delete serverEnv.OPENAI_API_KEY;
delete serverEnv.GEMINI_API_KEY;

// Add API keys individually if they exist
if (process.env.OPENAI_API_KEY) {
  serverEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}

if (process.env.GEMINI_API_KEY) {
  serverEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
}

// Set debug flag only when needed
if (DEBUG_API_KEYS) {
  serverEnv.DEBUG_API_KEYS = "true";
}

const server = spawn('node', [path.join(__dirname, '..', 'dist', 'index.js')], {
  env: serverEnv
});

// Log server output
server.stdout.on('data', (data) => {
  console.log(`Server: ${data}`);
});

server.stderr.on('data', (data) => {
  console.error(`Server Error: ${data}`);
});

// Wait a bit for server to start
setTimeout(() => {
  console.log('Sending initialize request...');
  
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
        resources: {}, // Support for resources
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
          console.log('Received response:', JSON.stringify(response, null, 2));
          
          // If it's the initialize response, send the tool call
          if (response.id === 1 && response.result) {
            console.log('Sending sage-opinion tool request...');
            
            const toolRequest = {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "sage-opinion",
                arguments: {
                  prompt: "Explain how the code in test/complex.js works in a concise summary",
                  paths: ["test/complex.js"]
                }
              }
            };
            
            server.stdin.write(JSON.stringify(toolRequest) + '\n');
          }
          
          // If it's the tool response, terminate the test
          if (response.id === 2) {
            console.log('Test completed successfully');
            setTimeout(() => {
              server.kill();
              process.exit(0);
            }, 1000);
          }
        } catch (err) {
          console.error('Error parsing response:', err);
        }
      });
    }
  });
}, 1000);

// Handle server exit
server.on('close', (code) => {
  console.log(`Server exited with code ${code}`);
});