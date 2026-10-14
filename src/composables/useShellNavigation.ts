import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import type { ConversationSurfaceState } from '../utils/agent-tab-ui-meta'

const MAX_HISTORY = 50

export interface ShellNavEntry extends ConversationSurfaceState {
  /** 巡检是 App 级整页，不在 conversationSurface 里 */
  smartPatrol: boolean
}

function entryKey(entry: ShellNavEntry): string {
  if (entry.smartPatrol) return 'patrol'
  if (entry.secretaryPanel) return `panel:${entry.secretaryPanel}`
  if (entry.activeTabId) return `tab:${entry.activeTabId}`
  if (entry.terminalPlaceActive) return 'terminal-empty'
  if (entry.hubFocusedAssistantTabId) return `hub:${entry.hubFocusedAssistantTabId}`
  return 'home'
}

/**
 * 主区落点的后退 / 前进。
 * 记录用户走过的会话、秘书面板、终端、巡检；侧栏开合不进栈。
 */
export function useShellNavigation(smartPatrol: Ref<boolean>) {
  const terminalStore = useTerminalStore()
  const backStack = ref<ShellNavEntry[]>([])
  const forwardStack = ref<ShellNavEntry[]>([])
  let lastEntry: ShellNavEntry | null = null
  let suppressRecord = false

  function snapshot(): ShellNavEntry {
    const surface = terminalStore.conversationSurface
    return {
      activeTabId: surface.activeTabId,
      hubFocusedAssistantTabId: surface.hubFocusedAssistantTabId,
      secretaryPanel: surface.secretaryPanel ?? null,
      terminalPlaceActive: !!surface.terminalPlaceActive,
      smartPatrol: smartPatrol.value,
    }
  }

  function canRestore(entry: ShellNavEntry): boolean {
    if (entry.smartPatrol) return true
    if (entry.activeTabId && !terminalStore.tabs.some(t => t.id === entry.activeTabId)) {
      return false
    }
    if (
      entry.hubFocusedAssistantTabId &&
      !entry.activeTabId &&
      !entry.secretaryPanel &&
      !entry.terminalPlaceActive &&
      !terminalStore.tabs.some(t => t.id === entry.hubFocusedAssistantTabId)
    ) {
      return false
    }
    return true
  }

  async function apply(entry: ShellNavEntry) {
    suppressRecord = true
    terminalStore.restoreConversationSurface(entry)
    smartPatrol.value = entry.smartPatrol
    await nextTick()
    lastEntry = snapshot()
    suppressRecord = false
  }

  watch(
    () => entryKey(snapshot()),
    () => {
      if (suppressRecord) return
      const next = snapshot()
      const prev = lastEntry
      lastEntry = next
      if (!prev || entryKey(prev) === entryKey(next)) return
      backStack.value.push(prev)
      if (backStack.value.length > MAX_HISTORY) backStack.value.shift()
      forwardStack.value = []
    }
  )

  lastEntry = snapshot()

  const canGoBack = computed(() => backStack.value.some(canRestore))
  const canGoForward = computed(() => forwardStack.value.some(canRestore))

  function goBack() {
    if (suppressRecord) return
    while (backStack.value.length) {
      const target = backStack.value.pop()
      if (!target || !canRestore(target)) continue
      forwardStack.value.push(snapshot())
      void apply(target)
      return
    }
  }

  function goForward() {
    if (suppressRecord) return
    while (forwardStack.value.length) {
      const target = forwardStack.value.pop()
      if (!target || !canRestore(target)) continue
      backStack.value.push(snapshot())
      void apply(target)
      return
    }
  }

  return { canGoBack, canGoForward, goBack, goForward }
}
