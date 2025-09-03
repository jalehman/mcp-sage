/**
 * Expert opinion debate strategy
 *
 * This strategy handles the debate process for expert opinions.
 */

import { ToolType } from "../types/public";
import { DebateContext, DebatePhase, DebateStrategy } from "./strategyTypes";
import { loadPrompt, escapeUserInput } from "../prompts/promptFactory";
import { registerStrategy } from "./registry";

/**
 * Strategy for expert opinion debates
 */
class OpinionStrategy implements DebateStrategy {
  readonly toolType = ToolType.Opinion;

  /**
   * Default configuration for opinion debates
   */
  readonly configDefaults = {
    rounds: 1,
    logLevel: "info" as const,
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
        const opinionEntries = ctx.candidates
          .map((opinion, idx) => `## OPINION ${idx + 1}\n${opinion.trim()}`)
          .join("\n\n");

        return template
          .replace(/\${modelId}/g, String(ctx.round))
          .replace(/\${planEntries}/g, opinionEntries);

      case "judge":
        const judgeOpinionEntries = ctx.candidates
          .map((opinion, idx) => `## OPINION ${idx + 1}\n${opinion.trim()}`)
          .join("\n\n");

        return template.replace(/\${planEntries}/g, judgeOpinionEntries);

      default:
        throw new Error(`Unknown debate phase: ${phase}`);
    }
  }

  /**
   * Parse the judge's decision to determine the winning opinion
   */
  parseJudge(
    raw: string,
    candidates: string[],
  ): { success: true; winnerIdx: number } | { success: false; error: string } {
    // check if there was only one candidate
    if (candidates.length === 1) {
      return { success: true, winnerIdx: 0 };
    }
    // Try to find explicit winner marker (e.g., [[WINNER: #]])
    const winnerMatch = raw.match(/\[\[WINNER:\s*(\d+)\]\]/i);
    if (winnerMatch && winnerMatch[1]) {
      const winnerIdx = parseInt(winnerMatch[1], 10) - 1; // Convert to 0-based
      if (winnerIdx >= 0 && winnerIdx < candidates.length) {
        return { success: true, winnerIdx };
      }
    }

    // For opinions, we don't allow synthesis - look for references to specific candidates
    for (let i = 0; i < candidates.length; i++) {
      const candidateNumber = i + 1;
      if (raw.toLowerCase().includes(`opinion ${candidateNumber}`)) {
        return { success: true, winnerIdx: i };
      }
    }

    // If we can't determine a winner, default to the first candidate
    return {
      success: true,
      winnerIdx: 0,
    };
  }
}

// Create and export the singleton instance
export const opinionStrategy = new OpinionStrategy();

// Register this strategy with the registry
registerStrategy(opinionStrategy);
