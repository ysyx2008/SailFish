<script setup lang="ts">
/**
 * 专家团完整群聊：左边是成员栏（谁在团里、在干什么），右边是头像加气泡的消息，点名的人写在气泡里，
 * 组长的话靠右，长的先显示几行。
 * 全文从随会话保存的群聊文件里翻页读：先读最近一页，翻到顶再往前读，有新消息往后补；
 * 读不到时用派出那一步里的那一小段。
 * 贴着底部时跟着新消息走，往上翻时不动。
 * 助手页开在右侧面板，终端页和联络盖在对话栏上，同一个组件。
 */
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, X, ArrowDown, Crown, MessagesSquare } from 'lucide-vue-next'
import { EXPERT_TEAM_LEADER, type ExpertTeamChatCursor, type ExpertTeamMessageView } from '@shared/types'
import { useTerminalStore } from '../../stores/terminal'
import { useMarkdown } from '../../composables/useMarkdown'
import { avatarHue, avatarInitial, continuesPrevious, memberLabel } from '../../utils/expert-team-view'
import { countSubAgents, subAgentBucket, type SubAgentBucket } from '../../utils/sub-agent-summary'
import { ExpertTeamChatPages } from '../../utils/expert-team-chat-pages'

const props = withDefaults(defineProps<{
  tabId: string
  /** 派出这个专家团的那一步 */
  stepId: string
  /** panel：右侧面板，右上角关掉；overlay：盖在对话栏上，左上角返回对话 */
  mode?: 'panel' | 'overlay'
}>(), { mode: 'panel' })
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const terminalStore = useTerminalStore()
const { renderMarkdown, renderMermaidBlocks, handleCodeBlockClick, handleFilePathContextMenu } = useMarkdown()

/** 超过这么多字或这么多行先收起 */
const FOLD_CHARS = 600
const FOLD_LINES = 10
/** 离底部这么近算贴着底 */
const STICK_SLACK_PX = 24
/** 离顶部这么近就往前读一页 */
const EARLIER_SLACK_PX = 80

const step = computed(() => terminalStore.tabs
  .find(tab => tab.id === props.tabId)?.agentState?.steps
  .find(s => s.id === props.stepId))
const team = computed(() => step.value?.expertTeam)
const agents = computed(() => step.value?.subAgents ?? [])

const readPage = (file: string, cursor: ExpertTeamChatCursor) =>
  window.electronAPI.history.readExpertTeamChat(file, cursor)
const pages = shallowRef<ExpertTeamChatPages | null>(null)
/** 全文读进来了就看全文，否则看派出那一步里的那一小段 */
const paged = computed(() => {
  const p = pages.value
  if (!p?.loaded || p.failed) return false
  return p.messages.length > 0 || !team.value?.messages.length
})
const messages = computed<ExpertTeamMessageView[]>(() =>
  paged.value ? pages.value!.messages : team.value?.messages ?? [])
/** 单条没放全时，全文在哪 */
const fullTextPath = computed(() => paged.value ? pages.value!.path : team.value?.transcriptPath)
const labels = computed(() => ({ leader: t('ai.expertTeam.leader') }))

const nameOf = (from: string) => from === EXPERT_TEAM_LEADER ? labels.value.leader : from
const roleOf = (from: string) => from === EXPERT_TEAM_LEADER ? '' : agents.value.find(a => (a.name ?? a.id) === from)?.role ?? ''
const avatarStyle = (name: string) => ({ background: `hsl(${avatarHue(name)} 42% 32%)` })
const mentions = (m: ExpertTeamMessageView) => m.to.map(name => ({
  name,
  text: `@${nameOf(name)}`,
  title: memberLabel(name, agents.value, labels.value),
}))
/** 成员栏：组长在最上面，后面是专家 */
const members = computed(() => agents.value.map(a => ({
  key: a.id,
  name: a.name ?? a.id,
  role: a.role ?? '',
  description: a.description,
  bucket: subAgentBucket(a),
})))
/** 窄栏里看不到文字，名字、角色、状态都放进鼠标停上去的提示和读屏名称里 */
const memberTip = (member: { name: string; role: string; description: string; bucket: SubAgentBucket }) =>
  [member.name, member.role, t(`ai.expertTeam.status.${member.bucket}`), member.description].filter(Boolean).join(' · ')
const runningCount = computed(() => countSubAgents(agents.value).running)
/** 同一个人连着说的几条并成一组 */
const rows = computed(() => messages.value.map((m, i) => ({ m, follow: continuesPrevious(messages.value[i - 1], m) })))
const isLeader = (m: ExpertTeamMessageView) => m.from === EXPERT_TEAM_LEADER
const isLong = (m: ExpertTeamMessageView) => m.text.length > FOLD_CHARS || m.text.split('\n').length > FOLD_LINES
const expanded = reactive(new Set<number>())
const toggle = (seq: number) => { if (expanded.has(seq)) expanded.delete(seq); else expanded.add(seq) }
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const listEl = ref<HTMLElement | null>(null)
const stuckToBottom = ref(true)
const unseen = ref(0)

function onScroll() {
  const el = listEl.value
  if (!el) return
  stuckToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX
  if (stuckToBottom.value) unseen.value = 0
  if (el.scrollTop <= EARLIER_SLACK_PX) void loadEarlier()
}

/** 往前读一页，补进来后原来最上面那条留在眼前原处 */
async function loadEarlier() {
  const p = pages.value
  const el = listEl.value
  if (!p || !el || !paged.value || !p.hasEarlier || p.loadingEarlier) return
  const anchor = el.querySelector<HTMLElement>('.etc-bubble')
  const anchorTop = anchor?.offsetTop ?? 0
  const added = await p.loadEarlier()
  if (!added || pages.value !== p) return
  await nextTick()
  if (anchor?.isConnected) el.scrollTop += anchor.offsetTop - anchorTop
  void renderMermaidBlocks(el)
}

/** 打开这个团的群聊：有全文文件就读末尾一页，然后贴底 */
async function openChat(force = false) {
  const file = team.value?.chatFile
  if (!force && pages.value?.file === file) return
  expanded.clear()
  unseen.value = 0
  const p = file ? reactive(new ExpertTeamChatPages(file, readPage)) as ExpertTeamChatPages : null
  pages.value = p
  if (p) {
    await p.loadLatest()
    if (viewLastSeq.value > p.lastSeq) await p.loadNewer()
  }
  if (pages.value !== p) return
  await nextTick()
  void renderMermaidBlocks(listEl.value)
  scrollToBottom()
}

function scrollToBottom() {
  const el = listEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  stuckToBottom.value = true
  unseen.value = 0
}

const lastSeq = computed(() => messages.value[messages.value.length - 1]?.seq ?? 0)

watch(lastSeq, async (seq, before) => {
  await nextTick()
  void renderMermaidBlocks(listEl.value)
  if (stuckToBottom.value) scrollToBottom()
  else if (seq > before) unseen.value += seq - before
})

/** 群里有新消息：看全文时去文件里补 */
const viewLastSeq = computed(() => {
  const view = team.value?.messages ?? []
  return view[view.length - 1]?.seq ?? 0
})
watch(viewLastSeq, (seq) => {
  const p = pages.value
  if (p?.loaded && !p.failed && seq > p.lastSeq) void p.loadNewer()
})

/** 换了一个团就从头打开；这个团的全文文件刚有时换成看全文 */
watch(() => props.stepId, () => { void openChat(true) })
watch(() => team.value?.chatFile, () => { void openChat() })

watch(() => !!team.value, (has, had) => { if (had && !has) emit('close') })

onMounted(() => { void openChat(true) })
</script>

<template>
  <section class="expert-team-chat" :class="`is-${mode}`">
    <header class="etc-header">
      <button
        v-if="mode === 'overlay'"
        type="button"
        class="etc-icon-btn"
        :title="t('ai.expertTeam.back')"
        :aria-label="t('ai.expertTeam.back')"
        @click="emit('close')"
      >
        <ArrowLeft :size="15" />
      </button>
      <span class="etc-title-icon" aria-hidden="true"><MessagesSquare :size="14" /></span>
      <div class="etc-title">
        <span class="etc-title-name">{{ t('ai.expertTeam.title', { team: team?.name ?? '' }) }}</span>
        <span class="etc-title-meta">
          {{ t('ai.expertTeam.members', { count: agents.length }) }}<template v-if="runningCount > 0"> · {{ t('ai.subAgentCount.running', { count: runningCount }) }}</template>
        </span>
      </div>
      <button
        v-if="mode === 'panel'"
        type="button"
        class="etc-icon-btn"
        :title="t('ai.expertTeam.close')"
        :aria-label="t('ai.expertTeam.close')"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </header>

    <div class="etc-main">
      <aside class="etc-members" :aria-label="t('ai.expertTeam.membersTitle')">
        <p class="etc-members-title">{{ t('ai.expertTeam.membersTitle') }}</p>
        <ul class="etc-member-list">
          <li class="etc-member" :title="labels.leader" :aria-label="labels.leader">
            <span class="etc-avatar is-leader" aria-hidden="true"><Crown :size="14" /></span>
            <span class="etc-member-text">
              <span class="etc-member-name">{{ labels.leader }}</span>
            </span>
          </li>
          <li
            v-for="member in members"
            :key="member.key"
            class="etc-member"
            :title="memberTip(member)"
            :aria-label="memberTip(member)"
          >
            <span class="etc-avatar" :style="avatarStyle(member.name)" aria-hidden="true">
              {{ avatarInitial(member.name) }}
              <i class="etc-status-dot" :class="`is-${member.bucket}`" />
            </span>
            <span class="etc-member-text">
              <span class="etc-member-name">{{ member.name }}</span>
              <span class="etc-member-sub">
                <template v-if="member.role">{{ member.role }} · </template><span class="etc-status" :class="`is-${member.bucket}`">{{ t(`ai.expertTeam.status.${member.bucket}`) }}</span>
              </span>
            </span>
          </li>
        </ul>
      </aside>

      <div class="etc-chat">
        <div ref="listEl" class="etc-list" @scroll.passive="onScroll">
          <div v-if="messages.length === 0" class="etc-empty">
            <MessagesSquare :size="22" aria-hidden="true" />
            <p>{{ t('ai.expertTeam.empty') }}</p>
          </div>
          <template v-if="paged">
            <p v-if="pages?.loadingEarlier" class="etc-omitted etc-earlier">{{ t('ai.expertTeam.loadingEarlier') }}</p>
            <button v-else-if="pages?.hasEarlier" type="button" class="etc-fold-btn etc-earlier-btn" @click="loadEarlier">
              {{ t('ai.expertTeam.loadEarlier') }}
            </button>
          </template>
          <p v-else-if="team?.earlierOmitted" class="etc-omitted etc-earlier">
            {{ team.transcriptPath
              ? t('ai.expertTeam.earlierOmitted', { count: team.earlierOmitted, path: team.transcriptPath })
              : t('ai.expertTeam.earlierOmittedNoPath', { count: team.earlierOmitted }) }}
          </p>
          <article
            v-for="{ m, follow } in rows"
            :key="m.seq"
            class="etc-message"
            :class="{ 'is-leader': isLeader(m), 'is-follow': follow }"
          >
            <span v-if="isLeader(m)" class="etc-avatar is-leader" aria-hidden="true"><Crown :size="14" /></span>
            <span v-else class="etc-avatar" :style="avatarStyle(m.from)" aria-hidden="true">{{ avatarInitial(m.from) }}</span>
            <div class="etc-content">
              <div v-if="!follow" class="etc-message-head">
                <span class="etc-name">{{ nameOf(m.from) }}</span>
                <span v-if="roleOf(m.from)" class="etc-role">{{ roleOf(m.from) }}</span>
                <span class="etc-time">{{ timeOf(m.at) }}</span>
              </div>
              <div class="etc-bubble" :title="follow ? timeOf(m.at) : undefined">
                <p v-if="m.to.length" class="etc-mentions">
                  <span v-for="mention in mentions(m)" :key="mention.name" class="etc-mention" :title="mention.title">{{ mention.text }}</span>
                </p>
                <div
                  class="etc-body markdown-content"
                  :class="{ 'is-folded': isLong(m) && !expanded.has(m.seq) }"
                  @click="handleCodeBlockClick"
                  @contextmenu="handleFilePathContextMenu"
                  v-html="renderMarkdown(m.text)"
                />
                <p v-if="m.omitted" class="etc-omitted">
                  {{ fullTextPath
                    ? t('ai.expertTeam.omitted', { count: m.omitted, path: fullTextPath })
                    : t('ai.expertTeam.omittedNoPath', { count: m.omitted }) }}
                </p>
                <button v-if="isLong(m)" type="button" class="etc-fold-btn" @click="toggle(m.seq)">
                  {{ expanded.has(m.seq) ? t('ai.expertTeam.collapse') : t('ai.expertTeam.showAll') }}
                </button>
              </div>
            </div>
          </article>
          <p v-if="team?.waitingLeader" class="etc-waiting">
            {{ t('ai.expertTeam.waitingLeaderNote', { limit: team.wakeLimit }) }}
          </p>
        </div>

        <button v-if="unseen > 0" type="button" class="etc-jump" @click="scrollToBottom">
          <ArrowDown :size="13" />
          <span>{{ t('ai.expertTeam.jumpLatest') }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.expert-team-chat {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  container: etc / inline-size;
}

.expert-team-chat.is-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
}

/* 头部 */
.etc-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--workbench-panel-header-height, 38px);
  padding: 0 10px;
  border-bottom: 1px solid var(--border-color);
}

.etc-title-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
}

.etc-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.etc-title-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etc-title-meta {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.etc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.etc-icon-btn:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--text-primary);
}

.etc-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 头像（成员栏和消息共用） */
.etc-avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  user-select: none;
}

.etc-avatar.is-leader {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.18);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb, 137, 180, 250), 0.4);
}

/* 成员栏 */
.etc-members {
  flex-shrink: 0;
  width: 156px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 6px;
  border-right: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow-y: auto;
}

.etc-members-title {
  margin: 0 6px 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.etc-member-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.etc-member {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 6px;
  border-radius: 8px;
}

.etc-member:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.05));
}

.etc-member-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.etc-member-name {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etc-member-sub {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etc-status.is-running { color: var(--color-success); }
.etc-status.is-waiting { color: var(--color-warning); }
.etc-status.is-failed { color: var(--color-error); }

.etc-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--bg-secondary);
  background: var(--text-muted);
}

.etc-status-dot.is-running { background: var(--color-success); }
.etc-status-dot.is-waiting { background: var(--color-warning); }
.etc-status-dot.is-failed { background: var(--color-error); }
.etc-status-dot.is-completed { background: var(--color-success); opacity: 0.45; }

/* 太窄时成员栏只留头像，名字、角色、状态放在鼠标停上去的提示里 */
@container etc (max-width: 520px) {
  .etc-members {
    width: 48px;
    align-items: center;
    padding: 10px 0;
  }
  .etc-members-title,
  .etc-member-text {
    display: none;
  }
  .etc-member {
    padding: 4px;
  }
}

/* 聊天区 */
.etc-chat {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.etc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.etc-empty {
  margin: 40px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.etc-empty p {
  margin: 0;
}

/* 消息 */
.etc-message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.etc-message.is-leader {
  flex-direction: row-reverse;
}

.etc-message.is-follow {
  margin-top: -10px;
}

.etc-message.is-follow .etc-avatar {
  visibility: hidden;
  height: 0;
}

.etc-content {
  min-width: 0;
  max-width: calc(100% - 44px);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.etc-message.is-leader .etc-content {
  align-items: flex-end;
}

.etc-message-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}

.etc-message.is-leader .etc-message-head {
  flex-direction: row-reverse;
}

.etc-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etc-role {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.etc-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.etc-bubble {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  padding: 8px 12px;
  border-radius: 4px 12px 12px 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.etc-message.is-leader .etc-bubble {
  border-radius: 12px 4px 12px 12px;
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
}

.etc-mentions {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-primary);
}

.etc-body {
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.etc-body :deep(> :first-child) {
  margin-top: 0;
}

.etc-body :deep(> :last-child) {
  margin-bottom: 0;
}

.etc-body.is-folded {
  max-height: 10.5em;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent);
  mask-image: linear-gradient(180deg, #000 70%, transparent);
}

.etc-omitted {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  user-select: text;
  word-break: break-all;
}

.etc-earlier {
  text-align: center;
}

.etc-earlier-btn {
  align-self: center;
}

.etc-fold-btn {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--accent-primary);
  cursor: pointer;
}

.etc-waiting {
  align-self: center;
  margin: 2px 0 0;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  text-align: center;
  color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.1);
}

.etc-jump {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
</style>
