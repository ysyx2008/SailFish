import { reactive } from 'vue'
import type { GoalContract } from '@shared/types'

const byAgentKey = reactive<Record<string, GoalContract | null>>({})
const revealTicks = reactive<Record<string, number>>({})
let listening = false

export function rememberLiveGoal(agentKey: string, goal?: GoalContract | null): void {
  if (!agentKey) return
  byAgentKey[agentKey] = goal ?? null
}

export function rememberLiveGoalFor(keys: string[], goal?: GoalContract | null): void {
  for (const key of uniqueKeys(keys)) rememberLiveGoal(key, goal)
}

export function liveGoalOf(agentKey: string): GoalContract | undefined {
  return byAgentKey[agentKey] ?? undefined
}

export function liveGoalOfAny(keys: string[]): GoalContract | undefined {
  for (const key of uniqueKeys(keys)) {
    if (!Object.prototype.hasOwnProperty.call(byAgentKey, key)) continue
    return byAgentKey[key] ?? undefined
  }
}

export function hasLiveGoalDecision(keys: string[]): boolean {
  return uniqueKeys(keys).some(key => Object.prototype.hasOwnProperty.call(byAgentKey, key))
}

/** 本地已记下（含刚清除）就用它，不要再掉回旧的 seed。 */
export function liveGoalOrSeed(keys: string[], seed?: GoalContract | null): GoalContract | undefined {
  if (hasLiveGoalDecision(keys)) return liveGoalOfAny(keys)
  return seed ?? undefined
}

export function revealLiveGoal(agentKey: string): void {
  if (!agentKey) return
  revealTicks[agentKey] = (revealTicks[agentKey] ?? 0) + 1
}

export function liveRevealTick(agentKey: string): number {
  return revealTicks[agentKey] ?? 0
}

export function ensureGoalLiveListener(): void {
  if (listening) return
  const api = window.electronAPI?.goal
  if (!api?.onUpdated) return
  listening = true
  api.onUpdated((payload) => {
    if (payload.goal) rememberLiveGoal(payload.agentKey, payload.goal)
  })
}

function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys.filter(Boolean))]
}
