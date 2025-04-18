#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as glob from 'glob';
import ignore from 'ignore';

// Map file extensions to language names for syntax highlighting
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  sh: 'bash',
};

let globalIndex = 1;

// Add line numbers to content
function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const padding = String(lines.length).length;
  
  return lines.map((line, i) => 
    `${String(i + 1).padStart(padding)}  ${line}`
  ).join('\n');
}

// Read .gitignore file and return an ignore instance
function readGitignore(dirPath: string): ignore.Ignore {
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
function formatFileAsXml(filePath: string, content: string, includeLineNumbers: boolean): string {
  let formattedContent = content;
  if (includeLineNumbers) {
    formattedContent = addLineNumbers(content);
  }
  
  return [
    `<document index="${globalIndex++}">`,
    `<source>${filePath}</source>`,
    '<document_content>',
    formattedContent,
    '</document_content>',
    '</document>'
  ].join('\n');
}

// Process a single file
function processFile(filePath: string, includeLineNumbers: boolean = true): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return formatFileAsXml(filePath, content, includeLineNumbers);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error processing file ${filePath}: ${error.message}`);
    }
    return null;
  }
}

// Process a directory recursively
function processDirectory(
  dirPath: string, 
  includeHidden: boolean = false,
  respectGitignore: boolean = true,
  includeLineNumbers: boolean = true
): string[] {
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
    
    const result = processFile(absolutePath, includeLineNumbers);
    if (result) {
      results.push(result);
    }
  }
  
  return results;
}

// Process a path (file or directory)
function processPath(
  pathToProcess: string,
  includeHidden: boolean = false,
  respectGitignore: boolean = true,
  includeLineNumbers: boolean = true
): string[] {
  const stat = fs.statSync(pathToProcess);
  
  if (stat.isFile()) {
    const result = processFile(pathToProcess, includeLineNumbers);
    return result ? [result] : [];
  } else if (stat.isDirectory()) {
    return processDirectory(pathToProcess, includeHidden, respectGitignore, includeLineNumbers);
  }
  
  return [];
}

// Main function
async function main() {
  const program = new Command();
  
  program
    .name('pack')
    .description('Pack files into a single prompt for LLMs')
    .argument('<paths...>', 'Paths to files or directories to include')
    .option('-i, --include-hidden', 'Include hidden files and directories', false)
    .option('-g, --ignore-gitignore', 'Ignore .gitignore files', false)
    .option('-n, --no-line-numbers', 'Exclude line numbers')
    .option('-o, --output <file>', 'Output to a file instead of stdout')
    .version('1.0.0')
    .parse(process.argv);
  
  const options = program.opts();
  const paths: string[] = program.args;
  
  // Reset global index
  globalIndex = 1;
  
  // Process all paths
  let results: string[] = [];
  results.push('<documents>');
  
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`Error: Path does not exist: ${p}`);
      process.exit(1);
    }
    
    const pathResults = processPath(
      p,
      options.includeHidden,
      !options.ignoreGitignore,
      options.lineNumbers
    );
    
    results = results.concat(pathResults);
  }
  
  results.push('</documents>');
  const output = results.join('\n');
  
  if (options.output) {
    fs.writeFileSync(options.output, output);
  } else {
    console.log(output);
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});