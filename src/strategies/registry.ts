/**
 * Strategy registry for debate orchestration
 * 
 * This module manages the registration and retrieval of debate strategies,
 * supporting both eager and lazy loading patterns.
 */

import { ToolType } from "../types/public";
import { DebateStrategy } from "./strategyTypes";

type Loader = () => Promise<{ default: DebateStrategy }>;
const table: Record<string, DebateStrategy | Loader> = {};

/**
 * Register a debate strategy for immediate use
 * @param strategy The strategy instance to register
 */
export function registerStrategy(strategy: DebateStrategy): void {
  table[strategy.toolType] = strategy;
}

/**
 * Register a lazy-loaded debate strategy
 * @param toolType The tool type to associate with this strategy
 * @param loader A function that loads the strategy module when needed
 */
export function registerLazy(toolType: ToolType, loader: Loader): void {
  table[toolType] = loader;
}

/**
 * Get a debate strategy for the specified tool type
 * @param toolType The tool type to get a strategy for
 * @returns The strategy instance, or undefined if none is registered
 */
export async function getStrategy(toolType: ToolType): Promise<DebateStrategy | undefined> {
  const entry = table[toolType];
  if (!entry) return undefined;
  
  if (typeof entry === "function") {  // lazy loading case
    const mod = await entry();
    table[toolType] = mod.default;
    return mod.default;
  }
  
  return entry;
}