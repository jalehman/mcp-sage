import { encoding_for_model, TiktokenModel } from '@dqbd/tiktoken';

/**
 * Estimates the number of tokens in a string using the specified model's tokenizer.
 * 
 * @param text - The text to count tokens for
 * @param modelName - The model to use for tokenization ('gpt-4', 'gpt-3.5-turbo', etc.)
 * @returns The estimated number of tokens
 */
export function countTokens(text: string, modelName: TiktokenModel = 'gpt-4'): number {
  try {
    // Get the encoding for the specified model
    const enc = encoding_for_model(modelName);
    
    // Encode the text to tokens
    const tokens = enc.encode(text);
    
    // Clean up
    enc.free();
    
    // Return the token count
    return tokens.length;
  } catch (error) {
    console.error('Error counting tokens:', error);
    
    // Fallback to approximate token count if tokenizer fails
    return approximateTokenCount(text);
  }
}

/**
 * Provides a rough approximation of token count based on character count.
 * This is used as a fallback if the tokenizer fails.
 * 
 * @param text - The text to estimate tokens for
 * @returns The approximate token count
 */
function approximateTokenCount(text: string): number {
  // A very rough approximation: ~4 characters per token for English text
  // This will be less accurate for non-English text
  return Math.ceil(text.length / 4);
}

/**
 * Analyzes and estimates token count for an XML document with a specific structure.
 * 
 * @param xmlContent - The XML content in Anthropic's format
 * @param modelName - The model to use for tokenization
 * @returns Token count and additional statistics
 */
export function analyzeXmlTokens(xmlContent: string, modelName: TiktokenModel = 'gpt-4'): {
  totalTokens: number;
  documentCount: number;
  averageTokensPerDocument: number;
} {
  // Count total tokens
  const totalTokens = countTokens(xmlContent, modelName);
  
  // Count number of documents
  const documentMatches = xmlContent.match(/<document index/g);
  const documentCount = documentMatches ? documentMatches.length : 0;
  
  // Calculate average tokens per document
  const averageTokensPerDocument = documentCount > 0 
    ? Math.round(totalTokens / documentCount) 
    : 0;
  
  return {
    totalTokens,
    documentCount,
    averageTokensPerDocument
  };
}