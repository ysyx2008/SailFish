import { reactive } from 'vue'

// 复用原来按派出步骤/成员保存的展开状态：顶部、内嵌详情与卸载重挂保持一致。
const expanded = reactive(new Map<string, boolean>())
const heights = new Map<string, number>()
const collapsedHeights = new Map<string, number>()
export const memberDetailStepId = (session: string | undefined, step: string | undefined, name: string): string => `member:${JSON.stringify([session, step, name])}`
export const subAgentExpansionKey = (step: string, member: string): string => `${step}:${member}`
export const isSubAgentExpanded = (key: string, fallback = false): boolean => expanded.get(key) ?? fallback
export function toggleSubAgentExpansion(key: string, fallback = false) {
  const next = !isSubAgentExpanded(key, fallback)
  expanded.set(key, next)
  if (!next) heights.delete(key)
}
export const subAgentExpansionHeight = (key: string): number => heights.get(key) ?? 56
export function rememberSubAgentHeight(key: string, height: number) {
  if (isSubAgentExpanded(key)) heights.set(key, height)
}

/** 收起行也记住实测高度，浮层重开时不退回统一的大行高。 */
export const subAgentCollapsedHeight = (key: string): number => collapsedHeights.get(key) ?? 56
export const rememberSubAgentCollapsedHeight = (key: string, height: number): void => { collapsedHeights.set(key, height) }
