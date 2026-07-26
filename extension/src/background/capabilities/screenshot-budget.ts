export type StageBudgetInput = {
  deadline: number
  now: number
  stageDefault: number
  reserve: number
  floor: number
}

export type StageBudget = {
  timeoutMs: number
  budgetExhausted: boolean
}

/**
 * Derive a stage timeout from one absolute screenshot deadline. Callers do
 * not start a stage when `budgetExhausted` is true; the floor makes that state
 * explicit and keeps the boundary deterministic.
 */
export function deriveStageBudget({ deadline, now, stageDefault, reserve, floor }: StageBudgetInput): StageBudget {
  const available = deadline - now - reserve
  if (available <= floor) return { timeoutMs: floor, budgetExhausted: true }
  return { timeoutMs: Math.min(stageDefault, available), budgetExhausted: false }
}
