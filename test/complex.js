/**
 * This is a more complex JavaScript file
 * with multiple functions and comments
 * to test our token counting functionality.
 */

// Import some modules
const fs = require('fs');
const path = require('path');
const util = require('util');

// Constants
const MAX_RETRY_COUNT = 5;
const DEFAULT_TIMEOUT = 3000;

/**
 * A complex function that does something interesting
 * @param {string} inputPath - Path to input file
 * @param {Object} options - Configuration options
 * @returns {Promise<Array>} - Processed data
 */
async function processFile(inputPath, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    retryCount = MAX_RETRY_COUNT,
    verbose = false,
  } = options;
  
  // Input validation
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Invalid input path: must be a non-empty string');
  }
  
  // Read file
  try {
    if (verbose) console.log(`Reading file from ${inputPath}`);
    const data = await fs.promises.readFile(inputPath, 'utf8');
    
    // Process data
    const lines = data.split('\n');
    const processed = lines
      .filter(line => line.trim().length > 0)
      .map((line, index) => ({
        lineNumber: index + 1,
        content: line.trim(),
        length: line.length,
        words: line.split(/\s+/).filter(Boolean).length
      }));
    
    return processed;
  } catch (error) {
    if (retryCount > 0) {
      console.warn(`Error reading file, retrying (${retryCount} attempts left)...`);
      await new Promise(resolve => setTimeout(resolve, timeout));
      return processFile(inputPath, {
        ...options,
        retryCount: retryCount - 1
      });
    }
    
    throw new Error(`Failed to process file after multiple attempts: ${error.message}`);
  }
}

// Export functionality
module.exports = {
  processFile,
  constants: {
    MAX_RETRY_COUNT,
    DEFAULT_TIMEOUT
  }
};