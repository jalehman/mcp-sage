/**
 * Parser for SEARCH/REPLACE/END blocks format
 * 
 * This utility parses the standardized SEARCH/REPLACE/END format used by the review tool,
 * providing validation and extraction of code blocks.
 */

/**
 * Represents a single search/replace block
 */
export interface SRBlock { 
  search: string; 
  replace: string;
}

/**
 * Parse text containing SEARCH/REPLACE/END blocks
 * @param text The text to parse
 * @returns Object containing validation result and extracted blocks
 */
export function parseSearchReplace(text: string): {
  valid: boolean;
  blocks: SRBlock[];
  error?: string;
} {
  // Match SEARCH...REPLACE...END blocks
  const regex = /SEARCH\s*([\s\S]+?)\s*REPLACE\s*([\s\S]+?)\s*END/g;
  const matches = Array.from(text.matchAll(regex));
  
  // We still collect blocks, but we're more permissive about format
  if (!matches.length) {
    return { 
      valid: false, 
      blocks: [], 
      error: "No SEARCH/REPLACE/END blocks found."
    };
  }
  
  // Allow content outside the blocks
  
  // Extract the blocks
  const blocks = matches.map(m => ({ 
    search: m[1].trim(), 
    replace: m[2].trim() 
  }));
  
  // Validate block content
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.search) {
      return {
        valid: false,
        blocks,
        error: `Block #${i+1} has an empty SEARCH section. Each SEARCH section must contain code to be replaced.`
      };
    }
  }
  
  return {
    valid: true,
    blocks
  };
}