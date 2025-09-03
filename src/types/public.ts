/**
 * Public data models and configuration types for debate features
 * These types are used across the public API surface
 */

/* ------------------------------------------------------------------ */
/* ENUMS                                                              */
/* ------------------------------------------------------------------ */
export enum ToolType {
  Opinion = "opinion",
  Review = "review",
}

/* ------------------------------------------------------------------ */
/* USER-FACING CONFIG                                                 */
/* ------------------------------------------------------------------ */
export interface DebateConfig {
  enabled?: boolean; // default: false
  rounds?: number; // default: 1
  strategy?: "opinion" | "review"; // auto-derived if omitted
  maxTotalTokens?: number; // optional cost guard
  logLevel?: "warn" | "info" | "debug";
}

/* ------------------------------------------------------------------ */
/* PRIMARY INPUT                                                      */
/* ------------------------------------------------------------------ */
export interface DebateOptions {
  toolType: ToolType;
  userPrompt: string;
  codeContext?: string; // Packed files XML to provide context
  debateConfig?: DebateConfig; // NEW preferred field
  debate?: boolean; // LEGACY (plan only) – still honoured
}

/* ------------------------------------------------------------------ */
/* RESULT                                                             */
/* ------------------------------------------------------------------ */
export interface DebateMeta {
  warnings: DebateWarning[]; // always populated
  tokenUsage: { prompt: number; completion: number };
  timings: { totalMs: number; perPhase: Record<string, number> };
  strategy: string;
  rounds: number;
}

export interface DebateWarning {
  code: "GEN_FAIL" | "JUDGE_MALFORMED" | "VALIDATION_FAIL" | "TOKEN_BUDGET";
  message: string;
  phase: "generate" | "critique" | "judge" | "validate";
}

export type DebateResult =
  | ({ toolType: ToolType.Opinion; opinion: string } & { meta: DebateMeta } & (
        | {}
        | { debateLog: DebateLog }
      ))
  | ({ toolType: ToolType.Review; review: string } & { meta: DebateMeta } & (
        | {}
        | { debateLog: DebateLog }
      ));

export interface DebateLog {
  transcript: string[];
  fallbacks: { phase: string; reason: string }[];
}
