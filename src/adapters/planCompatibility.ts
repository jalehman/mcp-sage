/**
 * Adapter for backwards compatibility with the original debate implementation
 * 
 * This module provides compatibility layers to ensure that code using the
 * original debate API continues to work with the new implementation.
 */

import { DebateResult, ToolType } from '../types/public';
import { runDebate } from '../orchestrator/debateOrchestrator';
import { NotificationFn } from '../orchestrator/debateOrchestrator';

/**
 * Old debate options interface for backward compatibility
 */
export interface LegacyDebateOptions {
  paths: string[];                    // Paths to include as context
  userPrompt: string;                 // Task to generate plan for
  codeContext?: string;               // Pre-packed code context (optional)
  rounds?: number;                    // Default 3
  models?: string[];                  // Override auto-selection
  parallelism?: number;               // # of concurrent calls
  judgeModel?: string | "auto";       // "auto" = o3 if available
  abortSignal?: AbortSignal;          // For cancellation support
  timeoutMs?: number;                 // Overall debate timeout (default: 10 minutes)
  maxTotalTokens?: number;            // Budget cap
  outputPath?: string;                // Path to save the final plan markdown file
}

/**
 * Old debate result interface for backward compatibility
 */
export interface LegacyDebateResult {
  finalPlan: string;                  // The winner (or merged) plan
  logs: any[];                        // Structured debate transcript
  stats: { 
    totalTokens: number; 
    perModel: Record<string, {
      tokens: number;
      apiCalls: number;
      cost: number;                   // Estimated cost based on pricing
    }>; 
    totalApiCalls: number;
    totalCost: number;
    consensus: {                      // Information about consensus
      reached: boolean;               // Was early consensus reached?
      round: number;                  // At which round?
      score: number;                  // Confidence score (0-1)
    }
  };
  complete: boolean;                  // Whether debate completed all rounds or was partial
}

/**
 * Legacy adapter function that maps the new debate API to the old interface
 */
export async function legacyDebateAdapter(
  opts: LegacyDebateOptions, 
  sendNotification: NotificationFn
): Promise<LegacyDebateResult> {
  try {
    // Map old options to new format
    const newOptions = {
      toolType: ToolType.Plan,
      userPrompt: opts.userPrompt,
      debateConfig: {
        enabled: true,
        rounds: opts.rounds || 3,
        maxTotalTokens: opts.maxTotalTokens,
        logLevel: "debug" as const  // Always include debug info for legacy adapter
      },
      // Include the legacy field for backward compatibility
      debate: true
    };
    
    // Run the debate with the new implementation
    const result = await runDebate(newOptions, sendNotification);
    
    // Convert the result back to the legacy format
    const legacyResult: LegacyDebateResult = {
      finalPlan: 'finalPlan' in result ? result.finalPlan : 'No plan generated',
      logs: [], // We don't have detailed logs in the new format
      stats: {
        totalTokens: result.meta.tokenUsage.prompt + result.meta.tokenUsage.completion,
        perModel: {}, // We don't have per-model stats in the new format
        totalApiCalls: 0, // We don't track this in the new format
        totalCost: 0, // We don't calculate this in the new format
        consensus: {
          reached: false, // We don't track this in the new format
          round: result.meta.rounds,
          score: 0.5 // Default mid-level confidence
        }
      },
      complete: result.meta.warnings.length === 0 // Assume complete if no warnings
    };
    
    // Extract any available logs if debug was enabled
    if ('debateLog' in result) {
      // Process transcript entries into a format similar to old logs
      // This is a very simplified version and won't match exactly
      const transcriptLogs = result.debateLog.transcript.map(entry => ({
        message: entry,
        timestamp: new Date().toISOString()
      }));
      
      legacyResult.logs = transcriptLogs;
    }
    
    return legacyResult;
  } catch (error) {
    // Return a basic error result in the legacy format
    return {
      finalPlan: `Debate failed: ${error instanceof Error ? error.message : String(error)}`,
      logs: [],
      stats: {
        totalTokens: 0,
        perModel: {},
        totalApiCalls: 0,
        totalCost: 0,
        consensus: {
          reached: false,
          round: 0,
          score: 0
        }
      },
      complete: false
    };
  }
}