/**
 * 这场对话开着的技能（输入区胶囊）。
 * 真相在后端；这里只做展示和把用户的点上/点掉交出去。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { useTerminalStore } from './terminal'

export interface ConversationSkillChip {
  id: string
  name: string
  description?: string
  unavailable?: boolean
  systemManaged?: boolean
}

function isMcpSkillId(id: string): boolean {
  return id.startsWith('mcp:')
}

function mergeKeepingOrder(
  prevList: ConversationSkillChip[],
  incoming: ConversationSkillChip[],
  retained: ConversationSkillChip[]
): ConversationSkillChip[] {
  const byId = new Map<string, ConversationSkillChip>()
  for (const s of incoming) byId.set(s.id, s)
  for (const s of retained) byId.set(s.id, s)
  const next: ConversationSkillChip[] = []
  const seen = new Set<string>()
  for (const s of prevList) {
    const chip = byId.get(s.id)
    if (!chip || seen.has(chip.id)) continue
    next.push(chip)
    seen.add(chip.id)
  }
  for (const s of incoming) {
    if (seen.has(s.id)) continue
    next.push(s)
    seen.add(s.id)
  }
  return next
}

export const useConversationSkillsStore = defineStore('conversationSkills', () => {
  const skillsByTabId = ref<Record<string, ConversationSkillChip[]>>({})
  const justAddedByTabId = ref<Record<string, string[]>>({})
  /** 首页已经挂上、搬进这场对话的技能。后端还在一个个装时不要当成刚加上。 */
  const alreadyShownByTabId = ref<Record<string, string[]>>({})
  /** 欢迎页刚搬过来、正在往 Agent 上装。只有这段时间才把快照里缺的胶囊留着。 */
  const seedingByTabId = ref<Record<string, boolean>>({})
  let listening = false
  let stopListen: (() => void) | null = null

  function resolveAgentKey(tabId: string): string | null {
    if (!tabId || tabId === WELCOME_COMPOSER_TAB_ID) return null
    const terminalStore = useTerminalStore()
    const tab = terminalStore.tabs.find(t => t.id === tabId)
    if (!tab) return tabId
    if (tab.type === 'assistant') return tab.agentId || tab.id
    return tab.id
  }

  function resolveTabId(agentKey: string): string | undefined {
    const terminalStore = useTerminalStore()
    return terminalStore.findTabIdByAgentId(agentKey)
      ?? terminalStore.tabs.find(t => t.id === agentKey)?.id
  }

  function getSkills(tabId: string): ConversationSkillChip[] {
    return skillsByTabId.value[tabId] ?? []
  }

  function justAddedIds(tabId: string): string[] {
    return justAddedByTabId.value[tabId] ?? []
  }

  /** 系统按处境装的技能（「终端」）：这场还开着终端窗时点不掉 */
  function canRemove(tabId: string, chip: ConversationSkillChip): boolean {
    if (!chip.systemManaged) return true
    const terminalStore = useTerminalStore()
    const tab = terminalStore.tabs.find(t => t.id === tabId)
    return !tab || terminalStore.getAllTabPtyIds(tab).length === 0
  }

  function applySnapshot(tabId: string, skills: ConversationSkillChip[], animateNew: boolean): void {
    const visible = skills.filter(s => !isMcpSkillId(s.id))
    const prevList = skillsByTabId.value[tabId] ?? []
    const prev = new Set(prevList.map(s => s.id))
    const incomingIds = new Set(visible.map(s => s.id))
    const alreadyShown = new Set(alreadyShownByTabId.value[tabId] ?? [])
    // 欢迎页刚搬过来、还在往 Agent 上装：快照会先少几颗，先按原顺序留着。
    // 装完就不再留——没装上的不要装成还开着，秘书卸掉的也不要粘住。
    const retained = seedingByTabId.value[tabId]
      ? prevList.filter(s => alreadyShown.has(s.id) && !incomingIds.has(s.id))
      : []
    const next = retained.length === 0
      ? visible
      : mergeKeepingOrder(prevList, visible, retained)
    const added = next
      .filter(s => !prev.has(s.id) && !alreadyShown.has(s.id) && !s.unavailable)
      .map(s => s.id)
    skillsByTabId.value = { ...skillsByTabId.value, [tabId]: next }
    if (animateNew && added.length > 0) {
      justAddedByTabId.value = { ...justAddedByTabId.value, [tabId]: added }
      window.setTimeout(() => {
        const current = justAddedByTabId.value[tabId] ?? []
        justAddedByTabId.value = {
          ...justAddedByTabId.value,
          [tabId]: current.filter(id => !added.includes(id))
        }
      }, 1300)
    }
  }

  function hydrateFromRecord(tabId: string, loadedSkills?: string[]): void {
    const visible = (loadedSkills ?? []).filter(id => !isMcpSkillId(id))
    applySnapshot(tabId, visible.map(id => ({ id, name: id })), false)
    if (visible.length > 0) {
      alreadyShownByTabId.value = {
        ...alreadyShownByTabId.value,
        [tabId]: [...new Set([...(alreadyShownByTabId.value[tabId] ?? []), ...visible])]
      }
    }
  }

  function clearTab(tabId: string): void {
    const next = { ...skillsByTabId.value }
    delete next[tabId]
    skillsByTabId.value = next
    const shown = { ...alreadyShownByTabId.value }
    delete shown[tabId]
    alreadyShownByTabId.value = shown
    const added = { ...justAddedByTabId.value }
    delete added[tabId]
    justAddedByTabId.value = added
    const seeding = { ...seedingByTabId.value }
    delete seeding[tabId]
    seedingByTabId.value = seeding
  }

  function forgetShown(tabId: string, skillId: string): void {
    const cur = alreadyShownByTabId.value[tabId]
    if (!cur?.includes(skillId)) return
    alreadyShownByTabId.value = {
      ...alreadyShownByTabId.value,
      [tabId]: cur.filter(id => id !== skillId)
    }
  }

  function transferWelcomeSkills(toTabId: string): ConversationSkillChip[] {
    const chips = getSkills(WELCOME_COMPOSER_TAB_ID)
    if (chips.length > 0) {
      applySnapshot(toTabId, chips, false)
      alreadyShownByTabId.value = {
        ...alreadyShownByTabId.value,
        [toTabId]: chips.map(s => s.id)
      }
      seedingByTabId.value = { ...seedingByTabId.value, [toTabId]: true }
    }
    clearTab(WELCOME_COMPOSER_TAB_ID)
    return chips
  }

  async function finishWelcomeHydration(tabId: string): Promise<void> {
    // 等逐个 pin 的变更事件到齐，再收口，避免半份快照在装完后把胶囊抹掉。
    await new Promise<void>(resolve => { window.setTimeout(resolve, 200) })
    const seeding = { ...seedingByTabId.value }
    delete seeding[tabId]
    seedingByTabId.value = seeding
    await sync(tabId)
  }

  async function pin(tabId: string, skill: ConversationSkillChip): Promise<boolean> {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      const cur = getSkills(tabId)
      if (cur.some(s => s.id === skill.id)) return true
      applySnapshot(tabId, [...cur, skill], true)
      return true
    }
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return false
    const result = await window.electronAPI.agent.pinSkill(agentKey, skill.id)
    if (result.ok) {
      const alreadyVisible = getSkills(tabId).some(s => s.id === skill.id)
        || (alreadyShownByTabId.value[tabId] ?? []).includes(skill.id)
      applySnapshot(tabId, result.skills, !alreadyVisible)
      return true
    }
    return false
  }

  async function unpin(tabId: string, skillId: string): Promise<void> {
    forgetShown(tabId, skillId)
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      applySnapshot(tabId, getSkills(tabId).filter(s => s.id !== skillId), false)
      return
    }
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const result = await window.electronAPI.agent.unpinSkill(agentKey, skillId)
    applySnapshot(tabId, result.skills, false)
  }

  async function sync(tabId: string): Promise<void> {
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const skills = await window.electronAPI.agent.getVisibleSkills(agentKey)
    // Agent 还没建起来时是空列表，不等于这场对话没技能。
    // 打开历史时先从记录画上胶囊，再被这次空结果抹掉。
    if (skills.length === 0) return
    applySnapshot(tabId, skills, false)
  }

  async function hydrateBackend(tabId: string, loadedSkills?: string[], userDismissedSkills?: string[]): Promise<void> {
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const skills = await window.electronAPI.agent.hydrateSkills(agentKey, loadedSkills, userDismissedSkills)
    // 记录里没清单时后端是空的，不等于这场对话没技能；别把已经画上的胶囊抹掉。
    if (skills.length === 0 && !Array.isArray(loadedSkills)) return
    applySnapshot(tabId, skills, false)
  }

  function startListening(): void {
    if (listening) return
    listening = true
    stopListen = window.electronAPI.agent.onSkillsChanged((data) => {
      const tabId = resolveTabId(data.agentId)
      if (!tabId) return
      applySnapshot(tabId, data.skills, true)
    })
  }

  function stopListening(): void {
    stopListen?.()
    stopListen = null
    listening = false
  }

  return {
    getSkills,
    justAddedIds,
    hydrateFromRecord,
    hydrateBackend,
    clearTab,
    transferWelcomeSkills,
    finishWelcomeHydration,
    pin,
    unpin,
    canRemove,
    sync,
    startListening,
    stopListening
  }
})
