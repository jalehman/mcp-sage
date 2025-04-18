const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Define the inputs
const instruction = "Add a function that calculates the factorial of a number recursively";
const paths = ["test/complex.js"];

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

    // Call the expert-review tool
    const toolRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "expert-review",
        arguments: {
          instruction,
          paths
        }
      }
    };
    
    // Write the tool request
    process.stdout.write(JSON.stringify(toolRequest) + "\n");
    
    // Get the tool response
    process.stdin.once('data', (data) => {
      try {
        const toolResponse = JSON.parse(data.toString());
        console.log("Tool Response:", toolResponse);
        
        // Check if the response contains the expected SEARCH/REPLACE format
        if (toolResponse.result && toolResponse.result.content) {
          const text = toolResponse.result.content[0].text;
          if (text.includes("<<<<<<< SEARCH") && text.includes("=======") && text.includes(">>>>>>> REPLACE")) {
            console.log("SUCCESS: Response contains SEARCH/REPLACE blocks");
          } else {
            console.log("WARNING: Response does not contain expected SEARCH/REPLACE format");
          }
        }
      } catch (err) {
        console.error("Error parsing tool response:", err);
      }
    });
  } catch (err) {
    console.error("Error parsing response:", err);
  }
});