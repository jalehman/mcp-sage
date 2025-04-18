#!/usr/bin/env node

// A simpler test script that should work reliably

const { spawn } = require('child_process');
const path = require('path');

// Prepare the initialization request
const initRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-03-26",
    clientInfo: {
      name: "simple-test",
      version: "1.0.0"
    },
    capabilities: {
      tools: {}
    }
  }
}) + '\n';

// Prepare the tool call
const toolRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "sidebar",
    arguments: {
      prompt: "Explain this code briefly",
      paths: ["test/complex.js"]
    }
  }
}) + '\n';

// Start the server process
const server = spawn('node', ['dist/index.js'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  }
});

let output = '';

// Handle server stdout
server.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  console.log(`Server output: ${text.trim()}`);
  
  // Look for patterns in output to determine what to do next
  if (output.includes('MCP Sidebar Server started')) {
    console.log('Server is ready, sending initialization request');
    server.stdin.write(initRequest);
  }
  
  if (output.includes('"result":') && output.includes('"id":1')) {
    console.log('Initialization successful, sending tool request');
    server.stdin.write(toolRequest);
  }
  
  if (output.includes('"id":2')) {
    console.log('Received tool response, test complete');
    setTimeout(() => {
      server.kill();
      process.exit(0);
    }, 1000);
  }
});

// Handle server stderr
server.stderr.on('data', (data) => {
  console.error(`Server error: ${data.toString().trim()}`);
});

// Handle server exit
server.on('close', (code) => {
  console.log(`Server process exited with code ${code}`);
});

// Handle keyboard interrupt
process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});