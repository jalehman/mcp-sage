/**
 * Implementation plan debate strategy
 * 
 * This strategy handles the debate process for implementation plans.
 */

import { ToolType } from "../types/public";
import { DebateContext, DebatePhase, DebateStrategy } from "./strategyTypes";
import { loadPrompt, escapeUserInput } from "../prompts/promptFactory";
import { registerStrategy } from "./registry";

/**
 * Strategy for implementation plan debates
 */
class PlanStrategy implements DebateStrategy {
  readonly toolType = ToolType.Plan;
  
  /**
   * Default configuration for plan debates
   */
  readonly configDefaults = {
    rounds: 3,
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
        const planEntries = ctx.candidates
          .map((plan, idx) => `## PLAN ${idx + 1}\n${plan.trim()}`)
          .join("\n\n");
          
        return template
          .replace(/\${modelId}/g, String(ctx.round))
          .replace(/\${planEntries}/g, planEntries);
          
      case "judge":
        const judgePlanEntries = ctx.candidates
          .map((plan, idx) => `## PLAN ${idx + 1}\n${plan.trim()}`)
          .join("\n\n");
          
        return template
          .replace(/\${planEntries}/g, judgePlanEntries);
          
      default:
        throw new Error(`Unknown debate phase: ${phase}`);
    }
  }
  
  /**
   * Parse the judge's decision to determine the winning plan
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
    
    // If no explicit winner, look for headers like "# Final Implementation Plan"
    if (raw.includes("# Final Implementation Plan")) {
      // The judge provided a synthesized plan
      return { success: true, winnerIdx: -1 }; // -1 indicates the judge's own synthesis
    }
    
    // If still no match, check if there was only one candidate
    if (candidates.length === 1) {
      return { success: true, winnerIdx: 0 };
    }
    
    // If all else fails, return an error
    return { 
      success: false, 
      error: "Could not determine winning plan from judge response" 
    };
  }
  
}

// Create and export the singleton instance
export const planStrategy = new PlanStrategy();

// Register this strategy with the registry
registerStrategy(planStrategy);