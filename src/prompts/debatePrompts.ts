/**
 * Prompt templates for the multi-model debate process
 * 
 * These templates are used throughout the debate orchestrator to generate
 * prompts for different models and phases of the debate process.
 */

/**
 * Escapes special characters in user prompts to prevent prompt injection
 */
export function escapeUserInput(input: string): string {
  // Replace quotes and other special characters that could break prompt formatting
  return input
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Generation prompt - asks a model to create an implementation plan
 */
export function generatePrompt(modelId: string, userPrompt: string): string {
  const escapedPrompt = escapeUserInput(userPrompt);
  
  return `
You are MODEL ${modelId}. Write a step-by-step implementation plan for:

"${escapedPrompt}"

Context from the code base is provided below.
Return ONLY a plan in Markdown under the heading
"# Implementation Plan (Model ${modelId})".

The plan should include:
1. Components/files to be created or modified
2. Data structures and interfaces
3. Key functions and their purposes
4. Implementation steps in priority order
5. Potential challenges and solutions
6. Testing approach

IMPORTANT: Do not reveal your underlying model identity. Always refer to yourself as MODEL ${modelId}.
`;
}

/**
 * Critique prompt - asks a model to critique plans from other models
 */
export function critiquePrompt(modelId: string, plans: Record<string, string>): string {
  const planEntries = Object.entries(plans)
    .filter(([id]) => id !== modelId) // Don't critique your own plan
    .map(([id, plan]) => `
## PLAN ${id}
${plan.trim()}
`).join('\n\n');
  
  return `
You are MODEL ${modelId}. You will critique the following plans
from other anonymous models. For EACH plan provide:

1. Strengths
2. Weaknesses
3. Specific actionable improvements

${planEntries}

Use the heading "## Critique of Plan {ID}" for each plan.
Ensure your critiques are specific, actionable, and focus on improving the implementation approach.

IMPORTANT: Do not reveal your underlying model identity. Always refer to yourself as MODEL ${modelId}.
`;
}

/**
 * Synthesis prompt - asks a model to improve its plan based on critiques
 */
export function synthesizePrompt(modelId: string, previousPlan: string, critiques: string[]): string {
  return `
You are MODEL ${modelId}. Review your previous implementation plan and the critiques it received.
Create an improved implementation plan that addresses the valid critiques while
maintaining the strengths of your original plan.

Your previous plan:
${previousPlan.trim()}

Critiques received:
${critiques.map(c => c.trim()).join('\n\n')}

Return ONLY your improved plan in Markdown under the heading
"# Improved Implementation Plan (Model ${modelId})".

Your improved plan should:
1. Address specific weaknesses pointed out in the critiques
2. Retain the strengths acknowledged in the critiques
3. Incorporate useful suggestions from other models
4. Maintain consistent formatting and structure
5. Be comprehensive and detailed

IMPORTANT: Do not reveal your underlying model identity. Always refer to yourself as MODEL ${modelId}.
`;
}

/**
 * Judge prompt - asks a model (typically O3) to select or synthesize the best plan
 */
export function judgePrompt(plans: Record<string, string>): string {
  const planEntries = Object.entries(plans)
    .map(([id, plan]) => `
## PLAN ${id}
${plan.trim()}
`).join('\n\n');
  
  return `
You are the judge. Evaluate the following implementation plans and select the SINGLE best plan
or synthesize a superior merged plan that combines the best elements of each.

${planEntries}

You should evaluate each plan based on:
1. Comprehensiveness - does it cover all aspects of the implementation?
2. Clarity - is it well-structured and easy to follow?
3. Feasibility - can it be implemented as described?
4. Efficiency - does it use resources efficiently?
5. Robustness - does it handle edge cases and potential issues?

Return only the winning plan under "# Final Implementation Plan".
Also include a confidence score (0.0-1.0) indicating your confidence in this selection,
in the format: "Confidence Score: X.X"

EXTREMELY IMPORTANT:
- Your final plan MUST be completely self-contained with all necessary context
- If you reference aspects from Plan A, B, or C, you MUST fully incorporate that content
- DO NOT make references like "Using Plan A's approach for X" without including the actual approach
- Your plan should be readable and complete on its own, without requiring the reader to know what was in the original plans
- Include ALL relevant details from any plan you reference

IMPORTANT: Do not reveal your underlying model identity.
`;
}

/**
 * Self-debate prompt - for CoRT-style debate when only one model is available
 */
export function selfDebatePrompt(modelId: string, userPrompt: string, existingPlans?: string[]): string {
  const escapedPrompt = escapeUserInput(userPrompt);
  
  let existingPlansText = '';
  if (existingPlans && existingPlans.length > 0) {
    existingPlansText = `
You have already generated the following plans:

${existingPlans.map((plan, i) => `--- PLAN ${i+1} ---\n${plan.trim()}`).join('\n\n')}

Now generate ${existingPlans.length < 3 ? 'another' : 'a final'} implementation plan that addresses any weaknesses in the previous plans.
`;
  }
  
  return `
You are MODEL ${modelId} participating in a Chain of Recursive Thoughts debate with yourself.
${existingPlans ? '' : 'Generate an implementation plan for:'}

${existingPlans ? existingPlansText : `"${escapedPrompt}"`}

Context from the code base is provided below.
${existingPlans && existingPlans.length >= 3 
  ? 'After examining all previous plans, provide your FINAL implementation plan that represents the best approach.'
  : 'Generate a NEW implementation plan that takes a different approach from any previous plans.'}

Return ONLY your plan in Markdown under the heading
"# Implementation Plan ${existingPlans ? (existingPlans.length + 1) : '1'}".

IMPORTANT: Do not reveal your underlying model identity. Always refer to yourself as MODEL ${modelId}.
`;
}

/**
 * Consensus check prompt - to determine if plans have converged
 */
export function consensusCheckPrompt(plans: Record<string, string>): string {
  const planEntries = Object.entries(plans)
    .map(([id, plan]) => `
## PLAN ${id}
${plan.trim()}
`).join('\n\n');
  
  return `
You are evaluating multiple implementation plans to determine if they have reached consensus.
Review the following plans and determine their similarity and consensus level:

${planEntries}

Calculate a consensus score from 0.0 to 1.0, where:
- 0.0 means completely different approaches with no overlap
- 0.5 means similar high-level approach but different implementation details
- 1.0 means effectively identical plans with only minor variations

Return ONLY a JSON object with the following structure:
{
  "consensusScore": 0.0 to 1.0,
  "consensusReached": true/false (true if score >= 0.9),
  "reasoning": "Brief explanation of your scoring"
}

IMPORTANT: Do not include any other text before or after the JSON.
`;
}