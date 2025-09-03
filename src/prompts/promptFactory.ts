/**
 * Prompt factory for debate orchestration
 * 
 * This module handles loading prompt templates from the filesystem,
 * providing a centralized way to access prompts for different debate phases.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolType } from '../types/public';
import { DebatePhase } from '../strategies/strategyTypes';

/**
 * Load a prompt template from the filesystem
 * @param tool The tool type associated with the prompt
 * @param phase The debate phase for the prompt
 * @returns The raw prompt template as a string
 */
export function loadPrompt(tool: ToolType, phase: DebatePhase): string {
  try {
    return fs.readFileSync(
      path.join(__dirname, "templates", tool, `${phase}.txt`),
      "utf8"
    );
  } catch (error) {
    // Fall back to default templates if specific ones don't exist
    console.warn(`Template not found for ${tool}/${phase}, using default.`);
    try {
      return fs.readFileSync(
        path.join(__dirname, "templates", "plan", `${phase}.txt`),
        "utf8"
      );
    } catch (error) {
      throw new Error(`Failed to load prompt template for ${tool}/${phase}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Escapes special characters in user prompts to prevent prompt injection
 * @param input The raw user input to escape
 * @returns The escaped input string
 */
export function escapeUserInput(input: string): string {
  // Replace quotes and other special characters that could break prompt formatting
  return input.replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}