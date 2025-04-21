#!/usr/bin/env node

// Test script for O3 model integration
// This tests the model selection logic based on token count

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Make sure we have both API keys
if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY environment variable is not set');
  process.exit(1);
}

// Prepare clean environment to avoid key pollution
const serverEnv = Object.assign({}, process.env);
delete serverEnv.OPENAI_API_KEY;
delete serverEnv.GEMINI_API_KEY;

// Debug flag for key logging
const DEBUG_API_KEYS = false; // Set to true only when debugging API key issues

// Add keys individually with careful handling
if (process.env.OPENAI_API_KEY) {
  serverEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  // Log sanitized key only when debugging
  if (DEBUG_API_KEYS) {
    const key = process.env.OPENAI_API_KEY;
    console.error(`Test OPENAI_API_KEY: ${key.substring(0, 7)}...${key.substring(key.length - 4)}`);
  }
}

if (process.env.GEMINI_API_KEY) {
  serverEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  // Log sanitized key only when debugging
  if (DEBUG_API_KEYS) {
    const key = process.env.GEMINI_API_KEY;
    console.error(`Test GEMINI_API_KEY: ${key.substring(0, 7)}...${key.substring(key.length - 4)}`);
  }
}

// Set debug flag only when needed
if (DEBUG_API_KEYS) {
  serverEnv.DEBUG_API_KEYS = "true";
}

// Start the MCP server in background with clean environment
const serverProcess = require('child_process').spawn(
  'node',
  [path.join(__dirname, '../dist/index.js')],
  {
    stdio: 'ignore', // Don't show server output
    detached: true, // Allow the process to run independently
    env: serverEnv
  }
);

// Wait a moment for the server to start
console.log('Starting MCP Sage server...');
setTimeout(runTests, 2000);

function runTests() {
  try {
    console.log('Running tests...');
    
    // Let's examine what tools are available
    console.log('\n=== Checking available tools ===');
    try {
      const toolsResult = execSync(
        `node ./test/run-test.js --list-tools`,
        { encoding: 'utf8' }
      );
      console.log('Available tools:', toolsResult);
    } catch (error) {
      console.log('Error checking tools:', error.message);
    }
    
    // 1. Test with a small prompt (should use O3)
    console.log('\n=== Test 1: Small input (should use O3) ===');
    const smallTest = 'Explain how to use the test-o3.js script in one sentence.';
    const smallResult = execSync(
      `echo '${smallTest}' | node ./test/run-test.js sage-opinion`,
      { encoding: 'utf8' }
    );
    console.log('Result:', smallResult);
    
    // 2. Test with a larger prompt that includes some files but still under 200k
    console.log('\n=== Test 2: Medium input (still should use O3) ===');
    const mediumTest = 'Explain the functionality of the following files.';
    const mediumResult = execSync(
      `echo '${mediumTest}' | node ./test/run-test.js sage-opinion src/index.ts src/openai.ts`,
      { encoding: 'utf8' }
    );
    console.log('Result:', mediumResult);
    
    // 3. Test with a large file set that should trigger Gemini
    // Note: This test assumes the combined files exceed 200k tokens but are under 1M
    console.log('\n=== Test 3: Large input (should use Gemini) ===');
    const largeTest = 'Analyze the entire codebase including node_modules.';
    try {
      const largeResult = execSync(
        `echo '${largeTest}' | node ./test/run-test.js sage-opinion . --exclude node_modules/.bin`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large output
      );
      console.log('Result (truncated):', largeResult.substring(0, 500) + '...');
    } catch (error) {
      console.log('Expected error for large input:', error.message);
    }
    
    console.log('\nAll tests completed!');
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    // Kill the server process
    if (serverProcess && !serverProcess.killed) {
      process.kill(-serverProcess.pid);
    }
  }
}

// Handle cleanup on exit
process.on('exit', () => {
  if (serverProcess && !serverProcess.killed) {
    process.kill(-serverProcess.pid);
  }
});

process.on('SIGINT', () => {
  if (serverProcess && !serverProcess.killed) {
    process.kill(-serverProcess.pid);
  }
  process.exit(0);
});