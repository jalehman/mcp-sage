/**
 * Code review debate strategy
 * 
 * This strategy handles the debate process for code reviews with SEARCH/REPLACE blocks.
 */

import { ToolType } from "../types/public";
import { DebateContext, DebatePhase, DebateStrategy } from "./strategyTypes";
import { loadPrompt, escapeUserInput } from "../prompts/promptFactory";
import { parseSearchReplace } from "../utils/searchReplaceParser";
import { registerStrategy } from "./registry";

/**
 * Strategy for code review debates
 */
class ReviewStrategy implements DebateStrategy {
  readonly toolType = ToolType.Review;
  
  /**
   * Default configuration for review debates
   */
  readonly configDefaults = {
    rounds: 2,
    logLevel: "info" as const
  };
  
  /**
   * Generate a prompt for the specified debate phase
   */
  getPrompt(phase: DebatePhase, ctx: DebateContext): string {
    const template = loadPrompt(this.toolType, phase);
    
    // Replace placeholders based on the phase
    switch (phase) {
      case "generate":
        return template
          .replace(/\${modelId}/g, String(ctx.round))
          .replace(/\${userPrompt}/g, escapeUserInput(ctx.userPrompt));
          
      case "critique":
        const reviewEntries = ctx.candidates
          .map((review, idx) => `## REVIEW ${idx + 1}\n${review.trim()}`)
          .join("\n\n");
          
        return template
          .replace(/\${modelId}/g, String(ctx.round))
          .replace(/\${planEntries}/g, reviewEntries);
          
      case "judge":
        const judgeReviewEntries = ctx.candidates
          .map((review, idx) => `## REVIEW ${idx + 1}\n${review.trim()}`)
          .join("\n\n");
          
        return template
          .replace(/\${planEntries}/g, judgeReviewEntries);
          
      default:
        throw new Error(`Unknown debate phase: ${phase}`);
    }
  }
  
  /**
   * Parse the judge's decision to determine the winning review
   */
  parseJudge(raw: string, candidates: string[]): { success: true; winnerIdx: number } | { success: false; error: string } {
    // Try to find explicit winner marker (e.g., [[WINNER: #]])
    const winnerMatch = raw.match(/\[\[WINNER:\s*(\d+)\]\]/i);
    if (winnerMatch && winnerMatch[1]) {
      const winnerIdx = parseInt(winnerMatch[1], 10) - 1; // Convert to 0-based
      if (winnerIdx >= 0 && winnerIdx < candidates.length) {
        return { success: true, winnerIdx };
      }
    }
    
    // For reviews, we need to validate the format regardless of winner selection
    const parseResult = parseSearchReplace(raw);
    
    // If the judge provided valid SEARCH/REPLACE blocks, use that
    if (parseResult.valid && parseResult.blocks.length > 0) {
      return { success: true, winnerIdx: -1 }; // -1 indicates the judge's own synthesis
    }
    
    // If there was only one candidate
    if (candidates.length === 1) {
      return { success: true, winnerIdx: 0 };
    }
    
    // If all else fails, return an error
    return { 
      success: false, 
      error: "Could not determine winning review from judge response" 
    };
  }
  
}

// Create and export the singleton instance
export const reviewStrategy = new ReviewStrategy();

// Register this strategy with the registry
registerStrategy(reviewStrategy);