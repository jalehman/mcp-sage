#!/usr/bin/env node

const { spawn } = require('child_process');

// Test with debate enabled to trigger both models
const testRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'sage-opinion',
    arguments: {
      prompt: 'What is the main purpose of this code?',
      paths: ['/Users/phaedrus/Projects/mcp/mcp-sage/test/sample.js'],
      debateConfig: {
        enabled: true,
        rounds: 1,
        logLevel: 'debug'
      }
    }
  }
};

console.log('Starting MCP server...');
const server = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd()
});

server.stderr.on('data', (data) => {
  const message = data.toString().trim();
  if (message) {
    console.log(`Server Error: ${message}`);
  }
});

server.stdout.on('data', (data) => {
  const message = data.toString().trim();
  if (message) {
    console.log(`Server: ${message}`);

    try {
      const parsed = JSON.parse(message);
      console.log('\nReceived response:', JSON.stringify(parsed, null, 2));

      // Check for debate metadata in the response
      if (parsed.result && parsed.result.meta) {
        console.log('\n=== DEBATE METADATA ===');
        console.log(JSON.stringify(parsed.result.meta, null, 2));

        if (parsed.result.meta.winner) {
          console.log('\n=== WINNER FOUND ===');
          console.log('Winner:', parsed.result.meta.winner);
        } else {
          console.log('\n=== NO WINNER METADATA ===');
        }
      }

    } catch (e) {
      // Not JSON, probably a notification
    }
  }
});

// Initialize the server
setTimeout(() => {
  console.log('\nSending initialize request...');
  server.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: {
          listChanged: true
        }
      },
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  }) + '\n');
}, 100);

// Send the test request after initialization
setTimeout(() => {
  console.log('Sending sage-opinion tool request with debate enabled...');
  server.stdin.write(JSON.stringify(testRequest) + '\n');
}, 2000);

// Clean up after test
setTimeout(() => {
  console.log('Test completed');
  server.kill();
  process.exit(0);
}, 60000);

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
