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
 * Represents a document extracted from XML
 */
export interface XmlDocument {
  path: string;
  content: string;
  tokenCount: number;
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
  documents: XmlDocument[];
} {
  // Count total tokens
  const totalTokens = countTokens(xmlContent, modelName);
  
  // Extract documents
  const documents: XmlDocument[] = [];
  const regex = /<document(?:\s+index="\d+"|\s+path="([^"]*)")+[^>]*>([\s\S]*?)<\/document>/g;
  
  let match;
  while ((match = regex.exec(xmlContent)) !== null) {
    const path = match[1] || '';
    const content = match[2];
    const tokenCount = countTokens(content, modelName);
    
    documents.push({
      path,
      content,
      tokenCount
    });
  }
  
  const documentCount = documents.length;
  
  // Calculate average tokens per document
  const averageTokensPerDocument = documentCount > 0 
    ? Math.round(totalTokens / documentCount) 
    : 0;
  
  return {
    totalTokens,
    documentCount,
    averageTokensPerDocument,
    documents
  };
}

/**
 * Splits XML content into multiple batches to avoid hitting token rate limits
 * 
 * @param xmlContent - The XML content to split
 * @param tokenLimit - Maximum tokens per batch
 * @param modelName - The model used for tokenization
 * @returns Array of XML content batches
 */
export function splitXmlIntoBatches(
  xmlContent: string,
  tokenLimit: number = 25000, // Conservative limit to stay under TPM
  modelName: TiktokenModel = 'gpt-4'
): string[] {
  const analysis = analyzeXmlTokens(xmlContent, modelName);
  
  // If under limit, return as single batch
  if (analysis.totalTokens <= tokenLimit) {
    return [xmlContent];
  }
  
  // We need to split by documents
  const batches: string[] = [];
  let currentBatch = '<documents>\n';
  let currentBatchTokens = countTokens(currentBatch, modelName);
  const closingTagTokens = countTokens('</documents>', modelName);
  const batchHeaderTokens = countTokens('<documents>\n<!-- CONTINUED FROM PREVIOUS BATCH -->\n', modelName);
  
  // For each document in the XML
  for (const doc of analysis.documents) {
    // Calculate the document's XML representation
    const docXml = `<document path="${doc.path}">\n${doc.content}\n</document>\n`;
    const docTokens = countTokens(docXml, modelName);
    
    // If adding this document would exceed batch limit, finalize current batch
    if (currentBatchTokens + docTokens + closingTagTokens > tokenLimit) {
      currentBatch += '</documents>';
      batches.push(currentBatch);
      
      // Start new batch
      currentBatch = '<documents>\n<!-- CONTINUED FROM PREVIOUS BATCH -->\n';
      currentBatchTokens = batchHeaderTokens;
    }
    
    // Add document to current batch
    currentBatch += docXml;
    currentBatchTokens += docTokens;
  }
  
  // Add final batch if not empty
  if (currentBatch !== '<documents>\n') {
    currentBatch += '</documents>';
    batches.push(currentBatch);
  }
  
  return batches;
}