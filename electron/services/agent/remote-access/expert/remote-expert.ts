/**
 * 运维专家：照眼前这一批具体的事，判断远程命令该放行、问用户还是拒绝。
 *
 * 一批只调一次模型，不起会话线。模型通道、超时、取消沿用评审员那一套。
 * 它只给结论和话；怎么落到各审批方式、出错怎么办由授权门定。
 */
import type { AiMessage, TokenUsageInfo } from '../../../ai.service'
import { formatUserWords, type UserWord } from '../../auto-review/evidence'
import type { AutoReviewChat } from '../../auto-review/reviewer'
import { describeCommands, formatCommandFacts } from './facts'
import { buildExpertPolicy } from './policy'
import { parseExpertVerdict, readExpertPartial, type ExpertPartial, type ExpertVerdict } from './verdict'

export interface RemoteExpertEnv {
  chat: AutoReviewChat
  profileId?: string
  locale: 'zh-CN' | 'en-US'
  /** 用户亲口说过的话，每次评判时取最新的 */
  words: () => readonly UserWord[]
  /** 整场任务被停时触发 */
  signal?: AbortSignal
  onUsage?: (usage: TokenUsageInfo) => void
  timeoutMs?: number
}

export interface ExpertHost {
  name: string
  address: string
  group?: string
}

export interface ExpertInput {
  hosts: readonly ExpertHost[]
  commands: readonly string[]
  /** 这一批派几个伙计 */
  workerCount?: number
  /** 补单：给哪个已派出的伙计补命令 */
  forWorker?: string
  executionMode: 'strict' | 'relaxed' | 'free'
  /** 此刻有没有人能当场回答 */
  attended: boolean
  /** 结论一出来就叫一次，说明变长再叫。用来让界面先显示结论、说明随后补上 */
  onPartial?: (partial: ExpertPartial) => void
}

export type ExpertResult =
  | { kind: 'verdict'; verdict: ExpertVerdict }
  /** 没拿到可用的结论：出错、超时、输出看不懂 */
  | { kind: 'unavailable'; detail: string }
  | { kind: 'cancelled' }

const DEFAULT_TIMEOUT_MS = 60_000

export class RemoteExpert {
  constructor(private readonly env: RemoteExpertEnv) {}

  async judge(input: ExpertInput): Promise<ExpertResult> {
    const { env } = this
    if (env.signal?.aborted) return { kind: 'cancelled' }

    const facts = await describeCommands(input.commands)
    const messages: AiMessage[] = [
      { role: 'system', content: buildExpertPolicy(env.locale) },
      { role: 'user', content: this.render(input, formatCommandFacts(facts)) },
    ]

    const timeout = AbortSignal.timeout(env.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = env.signal ? AbortSignal.any([env.signal, timeout]) : timeout
    let streamed = ''
    let lastPartial = ''
    try {
      const result = await untilAborted(
        // 输出上限跟模型配置走。推理型模型的思考也算在里面，单独压小会把结论截掉，看起来像没给意见。
        // 正文按增量交出去：第一行是结论，后面的说明写到哪界面补到哪。思考过程不在这条增量里。
        env.chat(messages, [], env.profileId, signal, {
          toolChoice: 'none',
          onContent: (delta) => {
            streamed += delta
            const partial = readExpertPartial(streamed)
            if (!partial) return
            const key = `${partial.outcome}\n${partial.text}`
            if (key === lastPartial) return
            lastPartial = key
            input.onPartial?.(partial)
          },
        }),
        signal,
      )
      if (result.usage) env.onUsage?.(result.usage)
      if (result.aborted || env.signal?.aborted) return { kind: 'cancelled' }
      const verdict = parseExpertVerdict(result.content) ?? parseExpertVerdict(streamed)
      return verdict
        ? { kind: 'verdict', verdict }
        : { kind: 'unavailable', detail: 'unparseable' }
    } catch (e) {
      if (env.signal?.aborted) return { kind: 'cancelled' }
      return { kind: 'unavailable', detail: timeout.aborted ? 'timeout' : e instanceof Error ? e.message : String(e) }
    }
  }

  private render(input: ExpertInput, commandFacts: string): string {
    const words = this.env.words()
    const hostLines = input.hosts.map(h => `- ${h.name}（${h.address}）${h.group ? `，分组：${h.group}` : ''}`)
    const scope = input.forWorker
      ? `给已经派出的伙计「${input.forWorker}」补几条命令，他连的主机不变。`
      : `这一批派 ${input.workerCount ?? '若干'} 个伙计，共涉及 ${input.hosts.length} 台主机。`
    const mode = input.executionMode === 'strict' ? '严格' : input.executionMode === 'free' ? '自由' : '宽松'
    return [
      '【用户原话】',
      words.length ? formatUserWords(words) : '（没有）',
      '',
      '【主机】',
      scope,
      ...hostLines,
      '',
      '【命令】',
      commandFacts,
      '',
      '【审批方式】',
      `${mode}；${input.attended ? '此刻有人在场' : '此刻没有人在场'}`,
    ].join('\n')
  }
}

class Cancelled extends Error {}

/** 有些模型通道不认中止信号；超时或被停时不再等它 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}
