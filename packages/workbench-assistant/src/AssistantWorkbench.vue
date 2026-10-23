<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge）。
 * 「跳到生成处」/「引用到 Composer」经 AiPanel defineExpose，由本壳持 ref 转发。
 * 产出物选区作用域：发送前经 consumeSelectionScope 静默附带，不进引用胶囊。
 */
import { computed, reactive, ref, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { List, PanelRightClose, PanelRightOpen } from 'lucide-vue-next'
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
import { TerminalPaneHost } from '@sailfish/workbench-sdk/terminal-pane-host'
import { ExpertTeamChat } from '@sailfish/workbench-sdk/expert-team'
import type { ArtifactComposerQuote } from './artifact/composer-quote'
import { consumeSelectionScope } from './artifact/selection-scope'
import type { WorkbenchContext } from '@shared/types'
import { useAssistantArtifactStore } from './artifact/store'
import { requireArtifactDesktopHost } from './artifact/host'
import { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
import ArtifactPanel from './artifact/components/ArtifactPanel.vue'
import ArtifactListPopover from './artifact/components/ArtifactListPopover.vue'

const props = defineProps<WorkbenchRendererProps>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
useArtifactAgentBridge(() => props.tab.id)

/** AiPanel 对外接口（defineExpose） */
const aiPanelRef = ref<{
  scrollToAgentStep: (stepId: string) => void | Promise<void>
  addComposerQuote: (snippet: ArtifactComposerQuote) => void
  addComposerImage: (image: { dataUrl: string; name: string; width?: number; height?: number; filePath?: string }) => void
  setComposerDraft: (text: string) => void
  submitComposerMessage: (text: string) => void
} | null>(null)

const artifactPanelRef = ref<{ minimizePanel: () => void } | null>(null)

function scrollToAgentStep(stepId: string) {
  void aiPanelRef.value?.scrollToAgentStep(stepId)
}

function addComposerQuote(snippet: ArtifactComposerQuote) {
  aiPanelRef.value?.addComposerQuote(snippet)
}

function addComposerImage(image: { dataUrl: string; name: string; width?: number; height?: number; filePath?: string }) {
  void aiPanelRef.value?.addComposerImage(image)
}

function setComposerDraft(text: string) {
  aiPanelRef.value?.setComposerDraft(text)
}

function submitComposerMessage(text: string) {
  aiPanelRef.value?.submitComposerMessage(text)
}

/** 发送时静默取出产出物选区作用域（取出即清除 sticky；不上聊天气泡） */
function consumeWorkbenchContext(): WorkbenchContext | undefined {
  const scope = consumeSelectionScope(props.tab.id)
  if (!scope?.excerpt.trim()) return undefined
  return {
    selectionScope: {
      label: scope.label,
      sourcePath: scope.sourcePath,
      sourceLinesAccurate: scope.sourceLinesAccurate,
      startLine: scope.startLine,
      endLine: scope.endLine,
      excerpt: scope.excerpt
    }
  }
}

function hostedTerminalCount(tab: { splitLayout?: unknown }): number {
  const walk = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0
    const n = node as { type?: string; ptyId?: string; children?: unknown[] }
    if (n.type === 'terminal' && n.ptyId) return 1
    return (n.children || []).reduce((sum: number, c) => sum + walk(c), 0)
  }
  return walk(tab.splitLayout)
}

const hasHostedTerminal = computed(() => hostedTerminalCount(props.tab) > 0)
const chatWidth = ref(420)
const chatVisible = ref(true)
const stageResizing = ref(false)
const stageRef = ref<HTMLElement | null>(null)
const MIN_CHAT_WIDTH = 300

type DeskSeat = 'none' | 'terminal' | 'artifact' | 'team'
const seat = ref<DeskSeat>('none')
/** 右侧在看哪个专家团的群聊（派出那一步的 id） */
const teamStepId = ref<string | null>(null)
/** 打开群聊前坐的是谁，关掉群聊回到它 */
let seatBeforeTeam: DeskSeat = 'none'
const teamSeated = computed(() => seat.value === 'team' && !!teamStepId.value)
watch(seat, (now, before) => {
  if (before === 'team' && now !== 'team') teamStepId.value = null
})
/** 文件在座时的看法：铺满只活在这一次入座。跨页签能保住，是因为工作台用 v-show 常驻、不卸载。 */
const focusMode = ref(false)

const terminalSeated = computed(() => hasHostedTerminal.value && seat.value === 'terminal')
const artifactSeated = computed(() =>
  seat.value === 'artifact' && artifactStore.isVisible(props.tab.id)
)
const focusActive = computed(() => focusMode.value && artifactSeated.value)

const chatFocusEl = ref<HTMLElement | null>(null)
const artifactFocusEl = ref<HTMLElement | null>(null)
/** 浮层实际高度：文档预览让出这一截，避免盖住输入，也避免网页预览吃掉点击 */
const overlaySpacePx = ref(160)
let overlaySpaceObserver: ResizeObserver | null = null

function syncOverlaySpace() {
  const el = chatFocusEl.value
  const height = el?.getBoundingClientRect().height
  overlaySpacePx.value = !height || height <= 0 ? 160 : Math.max(120, Math.ceil(height))
}

function stopOverlaySpaceObserver() {
  overlaySpaceObserver?.disconnect()
  overlaySpaceObserver = null
}

watch(focusActive, async (active) => {
  stopOverlaySpaceObserver()
  if (!active) return
  await nextTick()
  const el = chatFocusEl.value
  if (el && typeof ResizeObserver !== 'undefined') {
    overlaySpaceObserver = new ResizeObserver(() => syncOverlaySpace())
    overlaySpaceObserver.observe(el)
  }
  syncOverlaySpace()
}, { flush: 'post', immediate: true })

watch(artifactSeated, (seated) => {
  if (!seated) focusMode.value = false
})

function toggleFocus() {
  if (!artifactSeated.value) return
  focusMode.value = !focusMode.value
}
const docExpanded = computed(() => artifactSeated.value)
const hasArtifacts = computed(() => artifactStore.hasArtifacts(props.tab.id))
const showDeskList = computed(() =>
  hasArtifacts.value || (hasHostedTerminal.value && !terminalSeated.value)
)
const showArtifactFold = computed(() =>
  !terminalSeated.value && (
    artifactStore.isVisible(props.tab.id) || artifactStore.isPanelMinimized(props.tab.id)
  )
)
const showDeskChrome = computed(() =>
  showDeskList.value || (showArtifactFold.value && !docExpanded.value)
)
const ratio = computed({
  get: () => artifactStore.splitRatio,
  set: (v: number) => { artifactStore.splitRatio = v },
})

const panelToggleTitle = computed(() =>
  docExpanded.value ? t('canvas.minimizePanel') : t('canvas.expandPanel')
)
const listOpen = ref(false)
/** 清单按钮所在槽位；清单浮层挂在 body 上，靠它定位 */
const listSlotRef = ref<HTMLElement | null>(null)
let listHideTimer: ReturnType<typeof setTimeout> | null = null
const artifacts = computed(() => artifactStore.getArtifacts(props.tab.id))
const activeArtifactId = computed(() => artifactStore.getActiveArtifact(props.tab.id)?.id ?? null)
const deskTerminalTitle = computed(() => {
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null
    const n = node as {
      type?: string
      terminalType?: string
      sshSessionId?: string
      sshConfig?: { username?: string; host?: string }
      isActive?: boolean
      children?: unknown[]
    }
    if (n.type === 'terminal') {
      if (n.terminalType === 'ssh') {
        if (n.sshConfig?.host) {
          return n.sshConfig.username
            ? `${n.sshConfig.username}@${n.sshConfig.host}`
            : n.sshConfig.host
        }
        return t('tabs.sshTerminal')
      }
      return t('terminal.localTerminal')
    }
    for (const child of n.children || []) {
      const title = walk(child)
      if (title) return title
    }
    return null
  }
  return walk(props.tab.splitLayout) ?? t('terminal.localTerminal')
})

watch(hasArtifacts, (has, had) => {
  if (!has) listOpen.value = false
  if (had && !has && hasHostedTerminal.value && !teamSeated.value) {
    seat.value = 'terminal'
    chatVisible.value = true
    artifactStore.dismissPanel(props.tab.id)
  }
})

watch(hasHostedTerminal, (hosted, wasHosted) => {
  if (wasHosted === undefined) {
    if (hosted) {
      seat.value = 'terminal'
      artifactStore.minimizePanel(props.tab.id)
    } else if (artifactStore.isVisible(props.tab.id)) {
      seat.value = 'artifact'
    }
    return
  }
  if (hosted && !wasHosted) {
    if (teamSeated.value) seatBeforeTeam = 'terminal'
    else seat.value = 'terminal'
    chatVisible.value = true
    listOpen.value = false
    artifactStore.minimizePanel(props.tab.id)
    return
  }
  if (!hosted && wasHosted && seat.value === 'terminal') {
    seat.value = 'none'
  }
}, { immediate: true })

watch(() => artifactStore.isVisible(props.tab.id), (visible) => {
  if (visible) {
    if (seat.value === 'terminal' || teamSeated.value) {
      const steal = artifactStore.lastCanvasOpen
      if (steal?.tabId === props.tab.id && steal.stealSeat) {
        artifactStore.lastCanvasOpen = null
        seat.value = 'artifact'
        return
      }
      artifactStore.minimizePanel(props.tab.id)
      return
    }
    seat.value = 'artifact'
    return
  }
  if (seat.value === 'artifact') {
    seat.value = 'none'
  }
})

function startStageResize(e: MouseEvent) {
  if (e.button !== 0) return
  stageResizing.value = true
  document.addEventListener('mousemove', onStageResize)
  document.addEventListener('mouseup', stopStageResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onStageResize(e: MouseEvent) {
  if (!stageResizing.value) return
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect) return
  const next = rect.right - e.clientX
  const max = Math.max(MIN_CHAT_WIDTH, rect.width - 240)
  if (next >= MIN_CHAT_WIDTH && next <= max) chatWidth.value = next
}

function stopStageResize() {
  stageResizing.value = false
  document.removeEventListener('mousemove', onStageResize)
  document.removeEventListener('mouseup', stopStageResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  stopStageResize()
  stopOverlaySpaceObserver()
  if (listHideTimer) {
    clearTimeout(listHideTimer)
    listHideTimer = null
  }
})

function handleSendToAi(text: string) {
  const addQuote = () =>
    (aiPanelRef.value as { addQuotedTerminalSelection?: (t: string, title: string) => boolean } | null)
      ?.addQuotedTerminalSelection?.(text, props.tab.title ?? '')
  void nextTick(() => {
    if (!addQuote()) void nextTick(addQuote)
  })
}

function openList() {
  if (listHideTimer) {
    clearTimeout(listHideTimer)
    listHideTimer = null
  }
  listOpen.value = true
}

function closeList() {
  if (listHideTimer) clearTimeout(listHideTimer)
  listHideTimer = setTimeout(() => {
    listOpen.value = false
    listHideTimer = null
  }, 120)
}

function onListFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as HTMLElement | null
  const here = e.currentTarget as HTMLElement
  // 焦点在按钮槽位与浮出的清单之间移动，不算离开
  if (next && (here.contains(next) || listSlotRef.value?.contains(next) || next.closest?.('.artifact-list-pop'))) return
  closeList()
}

function openArtifact(artifactId: string) {
  seat.value = 'artifact'
  listOpen.value = false
  artifactStore.setActiveArtifact(props.tab.id, artifactId)
}

function removeFromDesk(artifactId: string) {
  artifactStore.removeArtifact(props.tab.id, artifactId)
  persistDeskArtifacts()
}

function persistDeskArtifacts() {
  requireArtifactDesktopHost().persistArtifacts(props.tab.id)
}

function seatTerminal() {
  if (!hasHostedTerminal.value) return
  seat.value = 'terminal'
  listOpen.value = false
  artifactStore.minimizePanel(props.tab.id)
}

function openExpertTeam(stepId: string) {
  if (seat.value !== 'team') seatBeforeTeam = seat.value
  teamStepId.value = stepId
  seat.value = 'team'
  listOpen.value = false
  chatVisible.value = true
}

function closeExpertTeam() {
  teamStepId.value = null
  if (seat.value !== 'team') return
  if (seatBeforeTeam === 'terminal' && hasHostedTerminal.value) seat.value = 'terminal'
  else if (seatBeforeTeam === 'artifact' && artifactStore.isVisible(props.tab.id)) seat.value = 'artifact'
  else seat.value = 'none'
}

function togglePanel() {
  if (terminalSeated.value) return
  listOpen.value = false
  if (docExpanded.value) {
    if (artifactPanelRef.value) {
      artifactPanelRef.value.minimizePanel()
    } else {
      artifactStore.minimizePanel(props.tab.id)
    }
    seat.value = 'none'
    return
  }
  seat.value = 'artifact'
  artifactStore.expandPanel(props.tab.id)
}

function toggleAiPanel() {
  if (!terminalSeated.value) return
  chatVisible.value = !chatVisible.value
}

function ensureAiPanel() {
  chatVisible.value = true
}

/** 给窗口右上折叠开关用：普通 ref 经实例取出后会丢响应，用 reactive 对象让父级跟得上 */
const deskChat = reactive({
  seated: false,
  visible: true,
})
watch(terminalSeated, (seated) => {
  deskChat.seated = seated
  artifactStore.setCatalogOnlyOpen(seated)
}, { immediate: true })
watch(chatVisible, (visible) => { deskChat.visible = visible })

defineExpose({
  toggleAiPanel,
  ensureAiPanel,
  showAiPanel: chatVisible,
  hasDeskChatToggle: terminalSeated,
  deskChat,
})
</script>

<template>
  <div
    ref="stageRef"
    class="assistant-workbench"
    :class="{
      'is-panel-open': docExpanded,
      'is-artifact-focus': focusActive,
      'is-terminal-stage': terminalSeated,
      'is-chat-collapsed': terminalSeated && !chatVisible,
      'is-stage-resizing': stageResizing,
      'has-desk-list': showDeskList,
      'has-artifact-fold': showArtifactFold && !docExpanded
    }"
  >
    <div v-if="hasHostedTerminal" v-show="terminalSeated" class="assistant-terminal">
      <TerminalPaneHost :tab="tab" :is-active="isActive" show-stage-chrome @send-to-ai="handleSendToAi" />
    </div>
    <div
      v-show="!focusActive"
      class="assistant-chat-column"
      :style="terminalSeated && chatVisible ? { width: chatWidth + 'px' } : undefined"
    >
      <div
        v-if="terminalSeated && chatVisible"
        class="stage-resizer"
        :class="{ resizing: stageResizing }"
        @mousedown="startStageResize"
      />
      <WorkbenchShell
        class="assistant-shell"
        :toggle-visible="(docExpanded && hasArtifacts) || teamSeated"
        v-model:toggle-ratio="ratio"
        toggle-side="right"
      >
        <template #anchor>
          <div class="assistant-teleport-slot">
            <Teleport :disabled="!focusActive" :to="chatFocusEl || 'body'">
              <div class="assistant-chat">
                <AiPanel
                  ref="aiPanelRef"
                  :tab-id="tab.id"
                  :tab-active="isActive"
                  :hide-avatar="terminalSeated || focusActive"
                  :peek="focusActive"
                  :consume-workbench-context="consumeWorkbenchContext"
                  :open-expert-team="openExpertTeam"
                />
                <div v-if="showDeskChrome && !focusActive" class="artifact-chrome artifact-chrome--cluster">
                  <div
                    v-if="showDeskList"
                    ref="listSlotRef"
                    class="artifact-list-slot"
                    @mouseenter="openList"
                    @mouseleave="closeList"
                    @focusin="openList"
                    @focusout="onListFocusOut"
                  >
                    <button
                      type="button"
                      class="artifact-chrome-btn"
                      :class="{ 'is-open': listOpen }"
                      :aria-label="t('canvas.artifactList')"
                      :aria-expanded="listOpen"
                    >
                      <List :size="14" />
                    </button>
                    <Teleport to="body">
                      <Transition name="artifact-list-pop">
                        <ArtifactListPopover
                          v-if="listOpen"
                          :artifacts="artifacts"
                          :active-artifact-id="activeArtifactId"
                          :show-terminal="hasHostedTerminal"
                          :terminal-title="deskTerminalTitle"
                          :terminal-active="terminalSeated"
                          :anchor="listSlotRef"
                          @select="openArtifact"
                          @select-terminal="seatTerminal"
                          @remove="removeFromDesk"
                          @close="listOpen = false"
                          @mouseenter="openList"
                          @mouseleave="closeList"
                          @focusin="openList"
                          @focusout="onListFocusOut"
                        />
                      </Transition>
                    </Teleport>
                  </div>
                  <button
                    v-if="showArtifactFold && !docExpanded"
                    type="button"
                    class="artifact-chrome-btn"
                    :title="panelToggleTitle"
                    :aria-label="panelToggleTitle"
                    :aria-expanded="docExpanded"
                    @click="togglePanel"
                  >
                    <PanelRightOpen :size="14" />
                  </button>
                </div>
              </div>
            </Teleport>
          </div>
        </template>
        <template #toggle>
          <div class="assistant-teleport-slot">
            <ExpertTeamChat
              v-if="teamSeated"
              mode="panel"
              :tab-id="tab.id"
              :step-id="teamStepId!"
              @close="closeExpertTeam"
            />
            <Teleport :disabled="!focusActive" :to="artifactFocusEl || 'body'">
              <ArtifactPanel
                v-if="hasArtifacts"
                v-show="!teamSeated"
                ref="artifactPanelRef"
                :tab-id="tab.id"
                :focus-active="focusActive"
                :scroll-to-agent-step="scrollToAgentStep"
                :add-composer-quote="addComposerQuote"
                :add-composer-image="addComposerImage"
                :set-composer-draft="setComposerDraft"
                :submit-composer-message="submitComposerMessage"
                @toggle-focus="toggleFocus"
              />
            </Teleport>
          </div>
        </template>
      </WorkbenchShell>
    </div>
    <div
      v-show="focusActive"
      class="assistant-focus-stage"
      :style="{ '--assistant-focus-overlay': overlaySpacePx + 'px' }"
    >
      <div ref="artifactFocusEl" class="assistant-focus-doc" />
      <div ref="chatFocusEl" class="assistant-focus-chat" />
    </div>
    <div v-if="(showArtifactFold && docExpanded && !focusActive) || (focusActive && showDeskList)" class="artifact-chrome artifact-chrome--fold">
      <div
        v-if="focusActive && showDeskList"
        ref="listSlotRef"
        class="artifact-list-slot"
        @mouseenter="openList"
        @mouseleave="closeList"
        @focusin="openList"
        @focusout="onListFocusOut"
      >
        <button
          type="button"
          class="artifact-chrome-btn"
          :class="{ 'is-open': listOpen }"
          :aria-label="t('canvas.artifactList')"
          :aria-expanded="listOpen"
        >
          <List :size="14" />
        </button>
        <Teleport to="body">
          <Transition name="artifact-list-pop">
            <ArtifactListPopover
              v-if="listOpen"
              :artifacts="artifacts"
              :active-artifact-id="activeArtifactId"
              :show-terminal="hasHostedTerminal"
              :terminal-title="deskTerminalTitle"
              :terminal-active="terminalSeated"
              :anchor="listSlotRef"
              @select="openArtifact"
              @select-terminal="seatTerminal"
              @remove="removeFromDesk"
              @close="listOpen = false"
              @mouseenter="openList"
              @mouseleave="closeList"
              @focusin="openList"
              @focusout="onListFocusOut"
            />
          </Transition>
        </Teleport>
      </div>
      <button
        v-if="showArtifactFold && !focusActive"
        type="button"
        class="artifact-chrome-btn"
        :title="panelToggleTitle"
        :aria-label="panelToggleTitle"
        :aria-expanded="docExpanded"
        @click="togglePanel"
      >
        <PanelRightClose :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant-workbench {
  position: relative;
  display: flex;
  flex-direction: row;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  --workbench-panel-header-height: 38px;
}

.assistant-terminal {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-chat-column {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.assistant-workbench.is-terminal-stage .assistant-chat-column {
  flex: 0 0 auto;
  min-width: 300px;
  border-left: 1px solid var(--border-color);
  transition: width 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}

.assistant-workbench.is-terminal-stage .assistant-chat-column::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
  pointer-events: none;
}

.assistant-workbench.is-stage-resizing .assistant-chat-column {
  transition: none;
}

.assistant-workbench.is-terminal-stage.is-chat-collapsed .assistant-chat-column {
  width: 0 !important;
  min-width: 0;
  border-left: none;
  overflow: hidden;
  pointer-events: none;
}

.assistant-shell {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-teleport-slot {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-focus-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-focus-doc {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.assistant-focus-chat {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  min-width: 0;
  padding: 0 24px 48px;
  overflow: visible;
  pointer-events: none;
}

.assistant-workbench.is-artifact-focus {
  flex-direction: column;
}

.assistant-workbench.is-artifact-focus .assistant-chat-column {
  display: none;
}

.assistant-teleport-slot > .assistant-chat,
.assistant-focus-doc > .canvas-panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-focus-chat > .assistant-chat {
  height: auto;
  flex: none;
  min-height: 0;
  pointer-events: auto;
}

.stage-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.25s ease;
  z-index: 5;
}

.stage-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.stage-resizer:hover::after,
.stage-resizer.resizing::after {
  opacity: 1;
}

.stage-resizer:hover,
.stage-resizer.resizing {
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.3), transparent);
}

.stage-resizer.resizing::after {
  background: var(--accent-primary);
  box-shadow: 0 0 10px var(--accent-primary);
}

.assistant-chat {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  container-type: inline-size;
  container-name: assistant-chat;
}

.artifact-chrome {
  position: absolute;
  top: 0;
  right: 8px;
  /* 高于对话区计划进度条，避免清单小面板被挡住 */
  z-index: 20;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  border-bottom: 1px solid transparent;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.artifact-list-slot {
  position: relative;
  display: flex;
  align-items: center;
}

.artifact-chrome-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  line-height: 0;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.artifact-chrome-btn svg {
  display: block;
}

.artifact-chrome-btn:hover,
.artifact-chrome-btn.is-open {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text-primary);
}

.artifact-list-pop-enter-active {
  animation: artifact-list-pop-in 0.52s cubic-bezier(0.16, 1.42, 0.28, 1) both;
}

.artifact-list-pop-leave-active {
  animation: artifact-list-pop-out 0.2s cubic-bezier(0.4, 0, 0.72, 0.2) both;
}

@keyframes artifact-list-pop-in {
  0% {
    opacity: 0;
    transform: translateY(-10px) scale(0.9);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes artifact-list-pop-out {
  0% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translateY(-6px) scale(0.94);
  }
}
</style>
