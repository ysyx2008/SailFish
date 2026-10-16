<script setup lang="ts">
/**
 * Canvas Markdown：Milkdown Crepe 真 WYSIWYG 单编辑面（表格/代码块/数学公式可视化编辑）。
 *
 * WYSIWYG 的结构性代价是「保存即规范化」（序列化输出 ≠ 原文件字节），
 * 本组件以「基线恒为编辑器规范化内容」契约消化：每次程序化替换编辑器内容后，
 * 立即序列化回写 store 并前进磁盘基线，dirty/冲突比较全在规范化空间进行。
 * 选区引用无文件行号（内容锚定），见 SPEC「设计目标：编辑器形态」。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wand2 } from 'lucide-vue-next'
import { buildArtifactPreviewUrl } from '@shared/types'
import { useAssistantArtifactStore } from '../store'
import { useArtifactSaveBridge } from '../domain/artifact-save-bridge'
import {
  decideRendererContentArrival,
  shouldReportDraftDirty
} from '../domain/coedit-conflict'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'
import { requireArtifactDesktopHost } from '../host'
import { SET_COMPOSER_DRAFT_KEY, SUBMIT_COMPOSER_MESSAGE_KEY, type ArtifactComposerQuote } from '../composer-quote'
import { registerSelectionScopeProvider } from '../selection-scope'
import { useToast } from '@sailfish/workbench-sdk/toast'
import type { MarkdownWysiwygHandle } from '../editor/markdown-wysiwyg-editor'
import { clampContextMenuPosition, intersectViewport } from '../domain/context-menu-position'
import {
  claimMarkdownSaveShortcut,
  isMarkdownSaveShortcut
} from '../domain/markdown-save-shortcut'
import { useSelectionActionHint } from '../composables/useSelectionActionHint'
import SelectionActionHint from '../ui/SelectionActionHint.vue'
import '../ui/quote-context-menu.css'

const CTX_MENU_ESTIMATE = { width: 200, height: 200 }

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t, locale } = useI18n()
const artifactStore = useAssistantArtifactStore()
const saveBridge = useArtifactSaveBridge()
const { loadingFromDisk } = useArtifactContentHydration(props.tabId, toRef(props, 'artifactId'))
const setComposerDraft = inject(SET_COMPOSER_DRAFT_KEY, undefined)
const submitComposerMessage = inject(SUBMIT_COMPOSER_MESSAGE_KEY, undefined)
const desktopHost = requireArtifactDesktopHost()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()

const draft = ref('')
const saving = ref(false)
const mountError = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const editorWrapRef = ref<HTMLElement | null>(null)
let editorHandle: MarkdownWysiwygHandle | null = null
/** 菜单标题里叫助手的名字，而不是「AI」 */
const assistantName = computed(() => desktopHost.getAssistantName())

const {
  anchor: hintAnchor,
  show: showSelectionHint,
  hide: hideSelectionHint,
  hideOnTyping: hideHintOnTyping
} = useSelectionActionHint(() => editorHandle?.dom ?? null)
/** 程序化 setContent / 初次挂载期间屏蔽 onDocChanged 回环 */
let applyingExternal = false
/** 编辑器异步挂载完成前到达的外部内容 */
let pendingExternalDoc: string | null = null
/** 编辑器已完成首次规范化；此前空草稿对基线不算 dirty */
const editorReady = ref(false)

function releaseApplyingExternal() {
  void nextTick(() => {
    applyingExternal = false
  })
}

const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxMenuRef = ref<HTMLElement | null>(null)
/** 右键菜单打开时的摘录快照（点击菜单项时选区可能已丢失） */
const ctxQuotePayload = ref<{
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
} | null>(null)

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const filePath = computed(() => artifact.value?.filePath ?? null)
const canSave = computed(() => typeof filePath.value === 'string' && filePath.value.length > 0)

// ── 人机双写：磁盘基线 / dirty / 外部版本冲突 ──
/** 磁盘基线（store 协同状态，恒为编辑器规范化内容）；未建立时回退为当前内容（视为干净） */
const diskBaseline = computed(
  () => artifactStore.getDiskBaseline(props.tabId, props.artifactId) ?? artifact.value?.content ?? ''
)
/** dirty = 草稿 ≠ 磁盘基线；编辑器未就绪时不报（空草稿对基线会误报） */
const isDirty = computed(() =>
  shouldReportDraftDirty(editorReady.value, draft.value, diskBaseline.value)
)
/** 未保存或无路径时才显示底部状态行（选区提示浮在选区旁，不进状态行——否则高度跳变会打断选择） */
const showStatusBar = computed(() => (canSave.value && isDirty.value) || !canSave.value)
/** 本组件最近一次展示/接受的内容（accept-vs-defer 判定；store 基线在挂起时会前进，不能替代它） */
const lastSynced = ref('')
/** 冲突时被挂起的外部版本（store 响应式，驱动横幅） */
const deferredContent = computed(() => artifactStore.getDeferredContent(props.tabId, props.artifactId))

/**
 * 外部内容进入编辑器：程序化替换 → 规范化序列化 → 回写 store + 基线前进。
 * 编辑器未就绪时暂存，挂载后补上。
 * 守卫：拒绝把非空内容规范化成空串后写回（Crepe 瞬时空文档 / 销毁副作用）。
 */
function applyExternalContent(raw: string) {
  if (!editorHandle) {
    pendingExternalDoc = raw
    return
  }
  applyingExternal = true
  try {
    editorHandle.setContent(raw)
    const canonical = editorHandle.getContent()
    if (!canonical.trim() && raw.trim()) {
      // 序列化异常：保留原 raw，不推进空基线
      draft.value = raw
      lastSynced.value = raw
      artifactStore.updateContent(props.tabId, raw, props.artifactId)
      return
    }
    draft.value = canonical
    lastSynced.value = canonical
    artifactStore.updateContent(props.tabId, canonical, props.artifactId)
    artifactStore.syncCoeditBaseline(props.tabId, props.artifactId, canonical)
  } finally {
    releaseApplyingExternal()
  }
}

watch(
  () => artifact.value?.content,
  (c) => {
    const next = c ?? ''
    const decision = decideRendererContentArrival({
      next,
      draft: draft.value,
      lastSynced: lastSynced.value,
      editorReady: editorReady.value,
      hasEditor: !!editorHandle,
      storeDirty: artifactStore.isArtifactDirty(props.tabId, props.artifactId)
    })
    if (decision === 'ignore') return
    if (decision === 'restore-dirty') {
      // 重挂载恢复 dirty 草稿：store 里是用户未保存内容，不视为外部版本、不动基线
      draft.value = next
      lastSynced.value = artifactStore.getDiskBaseline(props.tabId, props.artifactId) ?? next
      return
    }
    if (decision === 'apply') {
      applyExternalContent(next)
      return
    }
    artifactStore.deferExternalContent(props.tabId, props.artifactId, next)
  },
  { immediate: true }
)

// 基线变化后：保存成功（基线 = 草稿）时重对齐 lastSynced；并重算 dirty 推送
watch(diskBaseline, (b) => {
  if (b === draft.value) lastSynced.value = b
  if (!artifact.value || !editorReady.value) return
  saveBridge?.setDirty(props.artifactId, isDirty.value)
  artifactStore.setArtifactDirty(props.tabId, props.artifactId, isDirty.value)
})

function flushDraftToStore() {
  if (!artifact.value) return
  if (draft.value !== artifact.value.content) {
    artifactStore.updateContent(props.tabId, draft.value, props.artifactId)
  }
}

watch(
  () => props.artifactId,
  (_next, prev) => {
    if (prev) saveBridge?.flush(prev)
  }
)

watch(draft, () => {
  if (!artifact.value || !editorReady.value) return
  // dirty 推送两处：saveBridge（面板保存按钮）与 store 协同状态（Agent 快照/冲突分流）
  saveBridge?.setDirty(props.artifactId, isDirty.value)
  artifactStore.setArtifactDirty(props.tabId, props.artifactId, isDirty.value)
}, { immediate: true })

/** 相对路径图片 → sailfish-artifact:// 协议 URL（主进程受限映射到产出物所在目录） */
function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:|sailfish-artifact:|file:)/i.test(src)) return src
  return buildArtifactPreviewUrl(props.tabId, props.artifactId) + src.replace(/^\.\//, '')
}

async function mountEditor() {
  const el = editorWrapRef.value
  if (!el) return
  mountError.value = false
  applyingExternal = true
  try {
    // 动态引入：Crepe + ProseMirror + KaTeX 不进主包
    const { createMarkdownWysiwygEditor } = await import('../editor/markdown-wysiwyg-editor')
    if (!editorWrapRef.value) return
    const initialDoc = pendingExternalDoc ?? draft.value
    pendingExternalDoc = null
    editorHandle = await createMarkdownWysiwygEditor({
      parent: el,
      doc: initialDoc,
      onDocChanged: (md) => {
        if (applyingExternal) return
        // 拒绝用空串覆盖非空草稿（Crepe destroy / 瞬时清空的常见副作用）
        if (!md.trim() && draft.value.trim()) return
        if (md !== draft.value) draft.value = md
      },
      resolveImageSrc,
      locale: locale.value === 'en-US' ? 'en-US' : 'zh-CN',
      onHasSelectionChange: (has) => {
        if (!has) hideSelectionHint()
      }
    })
    editorHandle.dom.addEventListener('contextmenu', openCtxMenu)
    editorHandle.dom.addEventListener('mouseup', onEditorMouseUp)
    // 图片相对资源走 sailfish-artifact:// 协议，需主进程缓存条目存在（content 不用于资源映射）
    void window.electronAPI?.artifactPreview?.sync({ tabId: props.tabId, artifactId: props.artifactId, content: '' })
    // 干净态挂载：初始内容规范化回写基线（dirty 态挂载 = 恢复用户草稿，不动基线）。
    // 以 store 的 dirty 标记为准——draft===lastSynced 在「dirty 但基线未建立」的边界下会误判
    if (!artifactStore.isArtifactDirty(props.tabId, props.artifactId)) {
      const canonical = editorHandle.getContent()
      if (!canonical.trim() && initialDoc.trim()) {
        // 序列化异常：不推进空基线，保留 initialDoc
        draft.value = initialDoc
        lastSynced.value = initialDoc
      } else {
        if (canonical !== draft.value) {
          draft.value = canonical
          artifactStore.updateContent(props.tabId, canonical, props.artifactId)
        }
        artifactStore.syncCoeditBaseline(props.tabId, props.artifactId, canonical)
        lastSynced.value = canonical
      }
    }
    editorReady.value = true
    saveBridge?.setDirty(props.artifactId, isDirty.value)
    artifactStore.setArtifactDirty(props.tabId, props.artifactId, isDirty.value)
  } catch (err) {
    mountError.value = true
    toastError(err instanceof Error ? err.message : t('canvas.htmlPreviewFailed'))
  } finally {
    releaseApplyingExternal()
  }
}

type QuoteMeta = {
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
}

/**
 * 眼前这份才响应保存。
 * 切走的对话用 v-show 藏着，编辑器还在，布局盒为空。
 */
function isMarkdownEditorInFront(): boolean {
  const root = rootRef.value
  if (!root?.isConnected) return false
  if (root.getClientRects().length === 0) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  const active = artifactStore.getActiveArtifact(props.tabId)
  return active?.id === props.artifactId && active.renderer === 'markdown'
}

/** 面板激活即可引用（失焦后选区由 sticky decoration + 缓存保留） */
function isMarkdownPanelActive(): boolean {
  const root = rootRef.value
  if (!root?.isConnected) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.id !== props.artifactId) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.renderer !== 'markdown') return false
  return desktopHost.isTabActive(props.tabId)
}

function captureQuoteMeta(): QuoteMeta | null {
  return editorHandle?.getQuoteMeta() ?? null
}

function basenamePath(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

/** 组装发送时静默附带的选区作用域（不进 Composer 胶囊） */
function buildSelectionScope(): ArtifactComposerQuote | null {
  const meta = captureQuoteMeta()
  const trimmed = meta?.excerpt.trim()
  if (!trimmed || !meta) return null
  const fp = filePath.value
  const title = artifact.value?.title ?? ''
  const label = fp ? basenamePath(fp) : (title || 'Markdown')
  return {
    label,
    sourcePath: fp || null,
    sourceLinesAccurate: meta.accurate,
    quoteOrigin: 'canvas',
    startLine: meta.startLine,
    endLine: meta.endLine,
    excerpt: trimmed
  }
}

/** 选区快捷指令：只预填输入框；选区由发送时静默附带 */
const QUOTE_ACTION_KEYS = ['rewrite', 'polish', 'proofread', 'translate', 'expand'] as const

function applyCtxQuoteAction(actionKey: string) {
  const meta = ctxQuotePayload.value
  if (!meta?.excerpt.trim()) {
    closeCtxMenu()
    return
  }
  submitComposerMessage?.(t(`canvas.quoteActions.${actionKey}`))
  closeCtxMenu()
}

/** 冲突横幅：载入 AI（磁盘）版本，丢弃本地未保存草稿（含规范化回写与基线前进） */
function acceptExternal() {
  const c = deferredContent.value
  if (c === undefined) return
  applyExternalContent(c)
}

/** 冲突横幅：保留我的修改（随后保存即覆盖磁盘上的 AI 版本） */
function dismissExternal() {
  artifactStore.dismissDeferredContent(props.tabId, props.artifactId)
}

function placeCtxMenu(x: number, y: number, size = CTX_MENU_ESTIMATE) {
  const placed = clampContextMenuPosition({
    x,
    y,
    menuWidth: size.width,
    menuHeight: size.height,
    viewport: intersectViewport(rootRef.value?.getBoundingClientRect())
  })
  ctxX.value = placed.left
  ctxY.value = placed.top
}

function refineCtxMenu(x: number, y: number) {
  void nextTick(() => {
    const el = ctxMenuRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    placeCtxMenu(x, y, { width: r.width, height: r.height })
  })
}

/** 松手才提示：拖选途中不闪 */
function onEditorMouseUp(e: MouseEvent) {
  if (e.button === 2) return
  if (!captureQuoteMeta()?.excerpt.trim()) {
    hideSelectionHint()
    return
  }
  showSelectionHint()
}

function openCtxMenu(e: MouseEvent) {
  const meta = captureQuoteMeta()
  if (!meta || !meta.excerpt.trim()) return
  e.preventDefault()
  hideSelectionHint()
  ctxQuotePayload.value = meta
  placeCtxMenu(e.clientX, e.clientY)
  ctxVisible.value = true
  refineCtxMenu(e.clientX, e.clientY)
}

function closeCtxMenu() {
  ctxVisible.value = false
  ctxQuotePayload.value = null
}

function onGlobalKeydown(e: KeyboardEvent) {
  hideHintOnTyping(e)
  if (e.key === 'Escape') closeCtxMenu()
}

function onGlobalMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest?.('.md-ctx-menu')) return
  hideSelectionHint()
  closeCtxMenu()
}

async function saveToDisk() {
  const path = filePath.value
  if (!path || saving.value) return
  const api = window.electronAPI?.localFs
  if (!api?.writeFile) {
    toastError(t('canvas.saveFailed'))
    return
  }
  // 拒绝对非空基线静默写空（防止 destroy/规范化异常把磁盘清空）
  const baseline = diskBaseline.value
  if (!draft.value.trim() && baseline.trim()) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saving.value = true
  try {
    const res = await api.writeFile(path, draft.value)
    if (res.success) {
      artifactStore.updateContent(props.tabId, draft.value, props.artifactId)
      artifactStore.markSavedToDisk(props.tabId, props.artifactId, draft.value)
      lastSynced.value = draft.value
      saveBridge?.clearDirty(props.artifactId)
      toastSuccess(t('canvas.savedToDisk'))
    } else {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.saveFailed'))
  } finally {
    saving.value = false
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey
  if (!meta) return

  const k = e.key.toLowerCase()

  // Ctrl/Cmd+L：聚焦输入框（选区作隐式作用域，发送时静默附带，不弹胶囊）
  if (!e.shiftKey && !e.altKey && k === 'l' && isMarkdownPanelActive()) {
    const quoteMeta = captureQuoteMeta()
    if (quoteMeta?.excerpt.trim()) {
      e.preventDefault()
      e.stopPropagation()
      setComposerDraft?.('')
      hideSelectionHint()
      closeCtxMenu()
      return
    }
  }

  if (!isMarkdownSaveShortcut(e)) return
  if (!canSave.value || !isMarkdownEditorInFront()) return
  if (!claimMarkdownSaveShortcut()) return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (!isDirty.value) {
    toastInfo(t('canvas.saveNoChanges'))
    return
  }
  void saveToDisk()
}

let unregisterSelectionScope: (() => void) | null = null

onMounted(() => {
  saveBridge?.register(props.artifactId, {
    getContent: () => {
      // 异常空草稿不得经面板保存写空盘：回退基线（用户真要清空可删文件）
      if (!draft.value.trim() && diskBaseline.value.trim()) return diskBaseline.value
      return draft.value
    },
    flushToStore: flushDraftToStore,
    isDirty: () => isDirty.value
  })
  unregisterSelectionScope = registerSelectionScopeProvider(props.tabId, {
    getScope: () => buildSelectionScope(),
    clearScope: () => editorHandle?.clearStickySelection()
  })
  void mountEditor()
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('mousedown', onGlobalMouseDown, true)
})
onUnmounted(() => {
  unregisterSelectionScope?.()
  unregisterSelectionScope = null
  // 先 flush 再 destroy：destroy 会触发文档清空，disposed 标志挡住回灌
  flushDraftToStore()
  saveBridge?.unregister(props.artifactId)
  editorHandle?.dom.removeEventListener('contextmenu', openCtxMenu)
  editorHandle?.dom.removeEventListener('mouseup', onEditorMouseUp)
  editorHandle?.destroy()
  editorHandle = null
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
})
</script>

<template>
  <div ref="rootRef" class="markdown-renderer">
    <div v-if="deferredContent !== undefined" class="md-coedit-banner" role="alert">
      <Wand2 :size="13" aria-hidden="true" class="md-coedit-icon" />
      <span class="md-coedit-text">{{ t('canvas.coeditExternalHint') }}</span>
      <button type="button" class="md-coedit-btn primary" @click="acceptExternal">
        {{ t('canvas.coeditLoadExternal') }}
      </button>
      <button type="button" class="md-coedit-btn" @click="dismissExternal">
        {{ t('canvas.coeditKeepMine') }}
      </button>
    </div>

    <div class="md-body">
      <div
        ref="editorWrapRef"
        class="md-editor-wrap"
        :aria-label="t('canvas.markdownSource')"
      />
      <div v-if="loadingFromDisk && !draft.trim()" class="md-loading">{{ t('canvas.htmlPreviewLoading') }}</div>
      <div v-else-if="mountError" class="md-loading">{{ t('canvas.htmlPreviewFailed') }}</div>
    </div>

    <div v-if="showStatusBar" class="md-status-bar" role="status">
      <div class="md-status-right">
        <span v-if="canSave && isDirty" class="md-dirty-hint">
          {{ t('canvas.unsavedChanges') }}
        </span>
        <span v-else-if="!canSave" class="md-hint">{{ t('canvas.noPathHint') }}</span>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ctxVisible"
        ref="ctxMenuRef"
        class="md-ctx-menu"
        :style="{ left: ctxX + 'px', top: ctxY + 'px' }"
        role="menu"
        @mousedown.prevent
      >
        <template v-if="submitComposerMessage || setComposerDraft">
          <div class="md-ctx-group">{{ t('canvas.quoteActionGroup', { name: assistantName }) }}</div>
          <button
            v-for="key in QUOTE_ACTION_KEYS"
            :key="key"
            type="button"
            role="menuitem"
            class="md-ctx-item"
            @click="applyCtxQuoteAction(key)"
          >
            <Wand2 :size="14" aria-hidden="true" />
            <span>{{ t(`canvas.quoteActions.${key}`) }}</span>
          </button>
        </template>
      </div>
    </Teleport>

    <SelectionActionHint :anchor="hintAnchor" :clip-el="rootRef" />
  </div>
</template>

<style scoped>
.markdown-renderer {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary, #1e1e1e);
}

.md-status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-height: 22px;
  padding: 3px 10px;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  font-size: 11px;
}

.md-status-right {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.md-hint {
  color: var(--text-tertiary, #888);
  max-width: 200px;
  text-align: right;
  line-height: 1.35;
  font-size: 10px;
}

.md-dirty-hint {
  color: var(--accent-primary, #89b4fa);
  font-size: 11px;
  white-space: nowrap;
}

.md-body {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.md-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary, #1e1e1e);
  color: var(--text-secondary, #888);
  font-size: 13px;
}

.md-editor-wrap {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
}

/* Crepe 主题变量对齐应用主题（frame-dark 为底，关键色跟随 CSS 变量） */
.md-editor-wrap :deep(.milkdown) {
  --crepe-color-background: var(--bg-secondary, #1a1a1a);
  --crepe-color-on-background: var(--text-primary, #e6e6e6);
  --crepe-color-surface: var(--bg-primary, #121212);
  --crepe-color-surface-low: var(--bg-secondary, #1c1c1c);
  --crepe-color-on-surface: var(--text-primary, #d1d1d1);
  --crepe-color-on-surface-variant: var(--text-secondary, #a9a9a9);
  --crepe-color-outline: var(--border-color, #757575);
  --crepe-color-primary: var(--accent-primary, #b5b5b5);
  --crepe-color-hover: var(--hover-bg, #232323);
  /* 选区/光标用主题强调色，避免 frame-dark 灰底在浅/深主题下都看不清 */
  --crepe-color-selected: color-mix(in srgb, var(--accent-primary, #4d9eff) 32%, transparent);
  --crepe-base-font-size: 13px;
}

/* 文本选区高亮（编辑器聚焦时） */
.md-editor-wrap :deep(.milkdown .ProseMirror ::selection),
.md-editor-wrap :deep(.milkdown .ProseMirror *::selection) {
  background: color-mix(in srgb, var(--accent-primary, #4d9eff) 35%, transparent);
}

/* 失焦后 sticky 选区（原生 ::selection 会消失，用 decoration 保留「正在改这段」的视觉） */
.md-editor-wrap :deep(.milkdown .ProseMirror .sf-sticky-selection) {
  background: color-mix(in srgb, var(--accent-primary, #4d9eff) 28%, transparent);
}
.md-editor-wrap :deep(.milkdown .ProseMirror-focused .sf-sticky-selection) {
  background: transparent;
}

/* 节点选区（表格/图片/代码块等） */
.md-editor-wrap :deep(.milkdown .ProseMirror .ProseMirror-selectednode) {
  background: color-mix(in srgb, var(--accent-primary, #4d9eff) 22%, transparent);
  outline: 1px solid color-mix(in srgb, var(--accent-primary, #4d9eff) 55%, transparent);
}

/* 光标颜色：普通文本用强调色；代码块/图片等 Crepe 覆盖区域也统一 */
.md-editor-wrap :deep(.milkdown .ProseMirror),
.md-editor-wrap :deep(.milkdown .ProseMirror .cm-content),
.md-editor-wrap :deep(.milkdown .ProseMirror .image-block),
.md-editor-wrap :deep(.milkdown .ProseMirror [contenteditable]) {
  caret-color: var(--accent-primary, #4d9eff);
}

.md-editor-wrap :deep(.milkdown .ProseMirror) {
  padding: 12px 16px 24px;
  min-height: 100%;
  box-sizing: border-box;
}

/* TopBar 紧凑化：面板宽度有限，缩小图标与间距 */
.md-editor-wrap :deep(.milkdown .milkdown-top-bar) {
  min-height: 36px;
  padding: 0 8px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-item) {
  width: 26px;
  height: 26px;
  margin: 2px;
  padding: 2px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-item svg) {
  width: 16px;
  height: 16px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-divider) {
  height: 18px;
  margin: 6px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-heading-button) {
  height: 26px;
  padding: 2px 2px 2px 8px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-heading-button .top-bar-heading-label) {
  min-width: 56px;
  font-size: 12px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-heading-button .top-bar-chevron) {
  width: 18px;
  height: 18px;
}

.md-editor-wrap :deep(.milkdown .milkdown-top-bar .top-bar-heading-button .top-bar-chevron svg) {
  width: 12px;
  height: 12px;
}
</style>

<style>
/* 人机双写：外部版本冲突横幅 */
.md-coedit-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--accent-primary, #89b4fa) 12%, transparent);
  font-size: 11px;
}

.md-coedit-icon {
  color: var(--accent-primary, #89b4fa);
  flex-shrink: 0;
}

.md-coedit-text {
  flex: 1;
  min-width: 0;
  color: var(--text-primary, #eee);
}

.md-coedit-btn {
  padding: 3px 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.md-coedit-btn:hover {
  color: var(--text-primary, #fff);
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.md-coedit-btn.primary {
  border-color: var(--accent-primary, #89b4fa);
  color: var(--accent-primary, #89b4fa);
}

.md-coedit-btn.primary:hover {
  background: color-mix(in srgb, var(--accent-primary, #89b4fa) 15%, transparent);
}
</style>
