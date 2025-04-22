#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as glob from 'glob';
import ignore from 'ignore';
import { analyzeXmlTokens } from './tokenCounter';


// Add line numbers to content
export function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const padding = String(lines.length).length;
  
  return lines.map((line, i) => 
    `${String(i + 1).padStart(padding)}  ${line}`
  ).join('\n');
}

// Read .gitignore file and return an ignore instance
export function readGitignore(dirPath: string): ignore.Ignore {
  const ig = ignore();
  
  const gitignorePath = path.join(dirPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    
    // Add each non-empty, non-comment line to the ignore instance
    content.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .forEach(line => ig.add(line));
  }
  
  return ig;
}

// Format file in Anthropic XML format
export function formatFileAsXml(filePath: string, content: string, includeLineNumbers: boolean, documentIndex: number): string {
  let formattedContent = content;
  if (includeLineNumbers) {
    formattedContent = addLineNumbers(content);
  }
  
  return [
    `<document index="${documentIndex}">`,
    `<source>${filePath}</source>`,
    '<document_content>',
    formattedContent,
    '</document_content>',
    '</document>'
  ].join('\n');
}

// Process a single file
export function processFile(filePath: string, includeLineNumbers: boolean = true, documentIndex: number = 1): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return formatFileAsXml(filePath, content, includeLineNumbers, documentIndex);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error processing file ${filePath}: ${error.message}`);
    }
    return null;
  }
}

// Process a directory recursively
export function processDirectory(
  dirPath: string, 
  includeHidden: boolean = false,
  respectGitignore: boolean = true,
  includeLineNumbers: boolean = true,
  startIndex: number = 1
): { results: string[], nextIndex: number } {
  let currentIndex = startIndex;
  const results: string[] = [];
  
  // Get gitignore rules if needed
  const ignoreRules = respectGitignore ? readGitignore(dirPath) : ignore();
  
  // Get all files in the directory and subdirectories
  const files = glob.sync('**/*', {
    cwd: dirPath,
    dot: includeHidden,
    nodir: true,
    absolute: false,
  });
  
  // Process each file, respecting gitignore rules
  for (const file of files) {
    const relativePath = file;
    const absolutePath = path.join(dirPath, file);
    
    // Skip if the file is ignored by gitignore
    if (respectGitignore && ignoreRules.ignores(relativePath)) {
      continue;
    }
    
    // Skip hidden files if specified
    if (!includeHidden && (path.basename(file).startsWith('.') || file.split(path.sep).some(part => part.startsWith('.')))) {
      continue;
    }
    
    const result = processFile(absolutePath, includeLineNumbers, currentIndex);
    if (result) {
      results.push(result);
      currentIndex++;
    }
  }
  
  return { results, nextIndex: currentIndex };
}

// Process a path (file or directory)
export function processPath(
  pathToProcess: string,
  includeHidden: boolean = false,
  respectGitignore: boolean = true,
  includeLineNumbers: boolean = true,
  startIndex: number = 1
): { results: string[], nextIndex: number } {
  try {
    const stat = fs.statSync(pathToProcess);
    
    if (stat.isFile()) {
      const result = processFile(pathToProcess, includeLineNumbers, startIndex);
      return { 
        results: result ? [result] : [], 
        nextIndex: result ? startIndex + 1 : startIndex 
      };
    } else if (stat.isDirectory()) {
      return processDirectory(pathToProcess, includeHidden, respectGitignore, includeLineNumbers, startIndex);
    }
    
    return { results: [], nextIndex: startIndex };
  } catch (error) {
    console.error(`Error processing path ${pathToProcess}:`, error);
    return { results: [], nextIndex: startIndex };
  }
}

/**
 * Packs multiple files into a single XML document
 * @param paths Array of file or directory paths to process
 * @param options Configuration options
 * @returns XML string containing the packed files
 */
export function packFilesSync(
  paths: string[],
  options: {
    includeHidden?: boolean,
    respectGitignore?: boolean,
    includeLineNumbers?: boolean
  } = {}
): string {
  if (paths.length === 0) {
    return "<documents></documents>";
  }
  
  const {
    includeHidden = false,
    respectGitignore = true,
    includeLineNumbers = true
  } = options;
  
  // Process all paths
  let results: string[] = [];
  results.push('<documents>');
  
  let currentIndex = 1;
  
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`Error: Path does not exist: ${p}`);
      continue;
    }
    
    const { results: pathResults, nextIndex } = processPath(
      p,
      includeHidden,
      respectGitignore,
      includeLineNumbers,
      currentIndex
    );
    
    results = results.concat(pathResults);
    currentIndex = nextIndex;
  }
  
  results.push('</documents>');
  return results.join('\n');
}

// Main function for CLI usage
async function main() {
  const program = new Command();
  
  program
    .name('pack')
    .description('Pack files into a single prompt for LLMs with token counting')
    .argument('<paths...>', 'Paths to files or directories to include')
    .option('-i, --include-hidden', 'Include hidden files and directories', false)
    .option('-g, --ignore-gitignore', 'Ignore .gitignore files', false)
    .option('-n, --no-line-numbers', 'Exclude line numbers')
    .option('-o, --output <file>', 'Output to a file instead of stdout')
    .option('-t, --tokens-only', 'Output only token count information without XML content')
    .version('1.0.0')
    .addHelpText('after', '\nToken Analysis:\n  The output includes token count estimation using tiktoken.\n  This helps in understanding LLM context window usage.')
    .parse(process.argv);
  
  const options = program.opts();
  const paths: string[] = program.args;
  
  // Process files using the packFilesSync function
  const output = packFilesSync(paths, {
    includeHidden: options.includeHidden,
    respectGitignore: !options.ignoreGitignore,
    includeLineNumbers: options.lineNumbers
  });
  
  // Analyze token usage
  const tokenAnalysis = analyzeXmlTokens(output);
  
  // Function to print token analysis
  const printTokenAnalysis = () => {
    console.log(`\nToken Analysis:`);
    console.log(`- Total Tokens: ${tokenAnalysis.totalTokens.toLocaleString()}`);
    console.log(`- Document Count: ${tokenAnalysis.documentCount}`);
    console.log(`- Average Tokens Per Document: ${tokenAnalysis.averageTokensPerDocument}`);
  };
  
  if (options.tokensOnly) {
    // Only output token information
    console.log(`${tokenAnalysis.totalTokens}`);
  } else if (options.output) {
    fs.writeFileSync(options.output, output);
    // Print token information to console even when writing to file
    printTokenAnalysis();
  } else {
    console.log(output);
    printTokenAnalysis();
  }
}

// Only run the main function if this file is being executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}