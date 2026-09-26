/**
 * 编程技能 - 每轮留检查点
 * 每轮开始在后台拍，不耽误开口；这一轮的任何工具真正执行前先等它拍完，保证不会先改后拍。
 */
import * as path from 'path'
import { app } from 'electron'
import type { SkillData, SkillRunStartContext } from '../types'
import type { ToolResult } from '../../tools/types'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { CheckpointStore, type CheckpointKind, type SnapshotResult } from './checkpoint'
import { CodingState } from './state'

const log = createLogger('CodingCheckpoint')

export type TakeResult = SnapshotResult | { ok: false; reason: 'unavailable' }

export class CheckpointKeeper {
  private readonly pending = new WeakMap<SkillData, Promise<unknown>>()

  constructor(private readonly baseDir: () => string) {}

  storeFor(root: string): CheckpointStore {
    return CheckpointStore.for(root, this.baseDir())
  }

  async take(state: CodingState, kind: CheckpointKind): Promise<TakeResult> {
    const root = state.root
    if (!root || !(await CheckpointStore.isAvailable())) return { ok: false, reason: 'unavailable' }
    const result = await this.storeFor(root).snapshot(kind)
    if (result.ok) state.recordCheckpoint(result.checkpoint.id)
    else log.warn(`checkpoint (${kind}) not taken for ${root}: ${result.reason} ${result.detail}`)
    return result
  }

  onRunStart(ctx: SkillRunStartContext): void {
    if (ctx.isSubAgent) return
    const state = new CodingState(ctx.data)
    if (!state.root) return
    const job = this.take(state, 'turn')
      .then(result => {
        if (!result.ok && result.reason !== 'unavailable') state.setMissedNote(missedNote(result.reason))
      })
      .catch(error => log.error('checkpoint failed:', error))
    this.pending.set(ctx.data, job)
  }

  async guard(data: SkillData, proceed: () => Promise<ToolResult>): Promise<ToolResult> {
    await this.pending.get(data)
    const result = await proceed()
    const note = new CodingState(data).takeMissedNote()
    if (!note) return result
    return result.success
      ? { ...result, output: result.output ? `${result.output}\n\n${note}` : note }
      : { ...result, error: result.error ? `${result.error}\n\n${note}` : note }
  }
}

function missedNote(reason: 'timeout' | 'failed'): string {
  return reason === 'timeout' ? t('coding.checkpoint_missed_timeout') : t('coding.checkpoint_missed_failed')
}

export const checkpointKeeper = new CheckpointKeeper(() => path.join(app.getPath('userData'), 'coding', 'checkpoints'))
