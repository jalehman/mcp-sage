/**
 * Strategy interface for debate orchestration
 * 
 * This defines the common interface that all debate strategies must implement,
 * enabling a pluggable strategy pattern for different tool types.
 */

import { ToolType } from "../types/public";

export type DebatePhase = "generate" | "critique" | "judge";

export interface DebateContext {
  userPrompt: string;
  candidates: string[];
  critiques: string[];
  round: number;
}

export interface DebateStrategy {
  readonly toolType: ToolType;
  /* --- Prompt helpers --------------------------------------------------- */
  getPrompt(phase: DebatePhase, ctx: DebateContext): string;
  /* --- Judge parsing ----------------------------------------------------- */
  parseJudge(raw: string, candidates: string[]): { success: true; winnerIdx: number }
                                              | { success: false; error: string };
  /* --- Defaults --------------------------------------------------------- */
  configDefaults?: Partial<import("../types/public").DebateConfig>;
}