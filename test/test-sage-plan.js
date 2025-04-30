const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Define the inputs
const prompt = "Create a robust logging system with rotation, different log levels, and a clean API";
const paths = ["src/", "test/test-sage.js"];
const rounds = 2; // Use fewer rounds for testing to speed it up

// Create a test input JSON for the MCP server
const input = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    client: {
      name: "test-client",
      version: "1.0.0"
    }
  }
};

// Write the input to stdin
process.stdout.write(JSON.stringify(input) + "\n");

// Wait for response
process.stdin.once('data', (data) => {
  try {
    const response = JSON.parse(data.toString());
    console.log("Initialized:", response);

    // Call the sage-plan tool
    const toolRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "sage-plan",
        arguments: {
          prompt,
          paths,
          rounds
        }
      }
    };
    
    // Write the tool request
    process.stdout.write(JSON.stringify(toolRequest) + "\n");
    
    // Set up to receive multiple notifications and the final response
    let responseReceived = false;
    
    // Handle incoming messages
    process.stdin.on('data', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Check if this is a notification
        if (message.method && message.method.startsWith("notifications/")) {
          console.log(`Notification: ${message.params.level} - ${message.params.data}`);
          return;
        }
        
        // If it's a tool response and we haven't handled it yet
        if (!responseReceived && message.id === 2) {
          responseReceived = true;
          console.log("Tool Response Received");
          
          if (message.result && message.result.content) {
            // Log the final plan
            console.log("\nFINAL IMPLEMENTATION PLAN:");
            console.log("==========================");
            console.log(message.result.content[0].text.substring(0, 500) + "...");
            
            if (message.result.content.length > 1) {
              console.log("\nDEBATE TRANSCRIPT SNIPPET:");
              console.log("==========================");
              console.log(message.result.content[1].text.substring(0, 200) + "...");
            }
            
            // Log metadata if present
            if (message.result.metadata) {
              console.log("\nDEBATE STATISTICS:");
              console.log("==================");
              console.log(JSON.stringify(message.result.metadata, null, 2));
            }
            
            console.log("\nSUCCESS: Test completed successfully");
          } else if (message.error) {
            console.error("ERROR:", message.error);
          }
          
          // Exit after receiving the response
          setTimeout(() => process.exit(0), 100);
        }
      } catch (err) {
        console.error("Error parsing message:", err);
        console.error("Raw data:", data.toString());
      }
    });
  } catch (err) {
    console.error("Error parsing response:", err);
  }
});