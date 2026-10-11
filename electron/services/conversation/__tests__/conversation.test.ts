/**
 * Conversation 聚合根单测。
 *
 * 这些断言是阶段 0 特征网（agent 行为）在领域模型层的镜像——刻意用同款不变量，
 * 确保「搬进 Conversation 的逻辑」与「Agent 现状行为」字节对齐：
 *   - fromRecord 用 messages 切分重建 taskMemory（_systemInjected 不构成边界）
 *   - toRecord/fromRecord round-trip 稳定（messages/steps/身份/形态/token）
 *   - commitRun：reasoning_content 空串保留进 cache 前缀；transcript/token 累积
 *   - cache 前缀复用判定（无前缀/wakeup/超 70% 跳过）
 *   - reset 清空 transcript + 工作记忆
 *
 * 纯单测，不碰磁盘/electron（Conversation 是纯领域对象）。
 */
import { describe, it, expect } from 'vitest'
import { Conversation } from '../conversation'
import type { AgentRecord, AgentStep } from '@shared/types'
import type { AiMessage } from '../../ai.service'

const userStep = (content: string): AgentStep =>
  ({ id: `u_${content}`, type: 'user_task', content, timestamp: Date.now() } as AgentStep)
const finalStep = (content: string): AgentStep =>
  ({ id: `f_${content}`, type: 'final_result', content, timestamp: Date.now() } as AgentStep)

describe('Conversation 聚合根（领域模型）', () => {
  it('create：kind 默认由 agentKey 推断，形态/身份就位', () => {
    const task = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    expect(task.kind).toBe('task')
    expect(task.terminalType).toBe('local')
    expect(task.agentKey).toBe('tab-1')

    const companion = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    expect(companion.kind).toBe('companion')

    const watch = Conversation.create({ agentKey: '__watch__', terminalType: 'assistant' })
    expect(watch.kind).toBe('watch')

    // 显式 kind 覆盖推断
    const forced = Conversation.create({ agentKey: 'tab-x', terminalType: 'ssh', kind: 'companion' })
    expect(forced.kind).toBe('companion')
  })

  it('fromRecord：用 messages 切分重建 taskMemory，_systemInjected 不构成任务边界', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '真实任务一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '系统注入占位', _systemInjected: true } as AiMessage,
      { role: 'assistant', content: '答一续' },
      { role: 'user', content: '真实任务二' },
      { role: 'assistant', content: '答二' }
    ]
    const record: AgentRecord = {
      id: 'sess_x', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: '真实任务一', steps: [], messages,
      duration: 0, status: 'completed'
    } as AgentRecord

    const conv = Conversation.fromRecord(record)
    // 只在两条真实 user 处断开 → 2 个任务（注入那条并入前一任务）
    expect(conv.taskMemory.getTaskCount()).toBe(2)
    // transcript 全量恢复
    expect(conv.messages.length).toBe(6)
    // 身份/形态从记录恢复
    expect(conv.id).toBe('sess_x')
    expect(conv.kind).toBe('task')
  })

  it('另开一聊时，屏幕上有、记录里没有的半截回复补进给它看的记录，排在插话前面', () => {
    const partial = '收到，来一次真正的深度测试。派 5 个伙计并行开工，分工如下：'
    const stopped = '行，那就停在这，不动手了。'
    const record = {
      id: 'sess_gap', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: '深度测试下', duration: 0, status: 'completed',
      messages: [
        { role: 'user', content: '<sf_user_message>深度测试下</sf_user_message>' },
        { role: 'user', content: '<sf_user_message>算了不做了</sf_user_message>', _systemInjected: true },
        { role: 'assistant', content: stopped }
      ],
      steps: [
        { id: 'u', type: 'user_task', content: '深度测试下', timestamp: 1 },
        { id: 'm', type: 'message', content: `<details><summary>思考</summary>草稿</details>\n\n${partial}`, timestamp: 2 },
        { id: 's', type: 'user_supplement', content: '算了不做了', timestamp: 3 },
        { id: 'a', type: 'message', content: stopped, timestamp: 4 },
        { id: 'f', type: 'final_result', content: stopped, timestamp: 5 }
      ]
    } as AgentRecord

    const forked = Conversation.forkFromRecord(record, 'sess_fork')
    expect(forked).not.toBeNull()
    const contents = forked!.record.messages!.map(m => m.content)
    expect(contents[0]).toContain('深度测试下')
    expect(contents[1]).toBe(partial)
    expect(contents[2]).toContain('算了不做了')
    expect(contents[3]).toBe(stopped)
    expect(forked!.conversation.messages.map(m => m.content)).toEqual(contents)

    const tasks = forked!.conversation.taskMemory.getTasksInOrder()
    const remembered = tasks.flatMap(t => t.messages ?? []).map(m => m.content).join('\n')
    expect(remembered).toContain(partial)
    expect(remembered.indexOf(partial)).toBeLessThan(remembered.indexOf('算了不做了'))
  })

  it('审批方式是会话自己的：随记录往返，接回时已定的不被覆盖', () => {
    const base: AgentRecord = {
      id: 'sess_a', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: 'hi', steps: [],
      messages: [{ role: 'user', content: 'hi' }], duration: 0, status: 'completed'
    } as AgentRecord
    expect(Conversation.fromRecord(base).approval).toBeUndefined()

    const conv = Conversation.fromRecord({ ...base, approval: 'autoReview' })
    expect(conv.approval).toBe('autoReview')
    expect(conv.setApproval('autoReview')).toBe(false)
    expect(conv.setApproval('free')).toBe(true)
    conv.adoptApproval('strict')
    expect(conv.approval).toBe('free')

    const saved = conv.toCheckpointRecord({ steps: [userStep('hi')], taskMessageLog: [] })
    expect(saved?.approval).toBe('free')
  })

  it('fromRecord：缺 kind 的老记录按 agentKey 推断', () => {
    const record: AgentRecord = {
      id: 'sess_legacy', timestamp: Date.now(), terminalId: '', agentKey: '__companion__',
      terminalType: 'assistant', userTask: 'hi', steps: [],
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      duration: 0, status: 'completed'
    } as AgentRecord
    expect(Conversation.fromRecord(record).kind).toBe('companion')
  })

  it('fromRecord：刻意不恢复 token 账（与现状 restoreFromSessionRecord 对齐，重开从零累积）', () => {
    const record: AgentRecord = {
      id: 'sess_tok', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: 'q', steps: [],
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
      duration: 0, status: 'completed',
      tokenUsage: { prompt_tokens: 99, completion_tokens: 11, total_tokens: 110 }
    } as AgentRecord
    // 历史记录带 tokenUsage，但恢复后会话 token 账保持空白（保留当前行为）
    expect(Conversation.fromRecord(record).tokenUsage).toBeUndefined()
  })

  it('交接检查点：toRecord 带上 workingContext，fromRecord 接上 cache 前缀', () => {
    const conv = Conversation.create(
      { agentKey: 'tab-h', terminalType: 'assistant' },
      { id: 'sess_h', createdAt: 1000 }
    )
    conv.commitRun({
      runId: 'run1',
      userRequest: '写周报',
      steps: [userStep('写周报'), finalStep('已写好')],
      taskMessageLog: [{ role: 'user', content: '写周报' }],
      runMessages: [{ role: 'user', content: '写周报' }],
      taskStatus: 'success',
      result: '已写好',
    })
    const handoff: AiMessage[] = [
      { role: 'user', content: '[交接] 周报写在 weekly.docx' },
      { role: 'user', content: '接着改格式' },
    ]
    conv.setWorkingContext(handoff)

    const record = conv.toRecord({ terminalId: 'pty-1' })!
    expect(record.workingContext).toEqual(handoff)

    const restored = Conversation.fromRecord(record)
    expect(restored.hasHandoff()).toBe(true)
    expect(restored.getCachePrefix()).toEqual(handoff)
    expect(restored.toRecord({ terminalId: 'pty-1' })!.workingContext).toEqual(handoff)
  })

  it('压缩归档跟这场对话一起留下：第二次编号接着走，reset 清掉，重开还能按编号取回', () => {
    const conv = Conversation.create(
      { agentKey: 'tab-ca', terminalType: 'assistant' },
      { id: 'sess_ca', createdAt: 1000 }
    )
    conv.commitRun({
      runId: 'run1',
      userRequest: '写周报',
      steps: [userStep('写周报'), finalStep('已写好')],
      taskMessageLog: [{ role: 'user', content: '写周报' }],
      runMessages: [{ role: 'user', content: '写周报' }],
      taskStatus: 'success',
      result: '已写好',
    })
    conv.adoptCompressedArchives([
      { id: 'ca-1', messages: [{ role: 'user', content: '第一段原文' }], summary: '第一段', timestamp: 11 }
    ])
    conv.adoptCompressedArchives([
      { id: 'ca-1', messages: [{ role: 'user', content: '不该覆盖' }], summary: '假的', timestamp: 12 },
      { id: 'ca-2', messages: [{ role: 'assistant', content: '第二段原文' }], summary: '第二段', timestamp: 13 }
    ])

    const archives = conv.getCompressedArchives()
    expect(archives.map(a => a.id)).toEqual(['ca-1', 'ca-2'])
    expect(archives[0].messages).toEqual([{ role: 'user', content: '第一段原文' }])
    expect(conv.getCompressedArchive('ca-1')).toEqual([{ role: 'user', content: '第一段原文' }])
    expect(conv.getCompressedArchive('ca-9')).toBeNull()

    const record = conv.toRecord({ terminalId: 'pty-1' })!
    expect(record.compressedArchives?.map(a => a.id)).toEqual(['ca-1', 'ca-2'])

    const restored = Conversation.fromRecord(record)
    expect(restored.getCompressedArchives().map(a => a.id)).toEqual(['ca-1', 'ca-2'])
    expect(restored.getCompressedArchive('ca-2')).toEqual([{ role: 'assistant', content: '第二段原文' }])
    expect(restored.toRecord({ terminalId: 'pty-1' })!.compressedArchives?.map(a => a.id)).toEqual(['ca-1', 'ca-2'])

    conv.reset()
    expect(conv.getCompressedArchives()).toEqual([])
    expect(conv.getCompressedArchive('ca-1')).toBeNull()
  })

  it('toRecord：空会话（无 user_task）返回 null', () => {
    const conv = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    expect(conv.toRecord()).toBeNull()
  })

  it('toRecord / fromRecord round-trip：messages/steps/身份/形态/token 稳定', () => {
    const conv = Conversation.create(
      { agentKey: 'tab-rt', terminalType: 'ssh' },
      { id: 'sess_rt', createdAt: 1000, sshHost: 'h1' }
    )
    conv.commitRun({
      runId: 'run1',
      userRequest: '问题一',
      steps: [userStep('问题一'), finalStep('回答一')],
      taskMessageLog: [{ role: 'user', content: '问题一' }],
      runMessages: [{ role: 'user', content: '问题一' }],
      taskStatus: 'success',
      result: '回答一',
      reasoningContent: '',
      tokenUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    const record = conv.toRecord({ terminalId: 'pty-1' })!
    expect(record).toBeTruthy()
    expect(record.id).toBe('sess_rt')
    expect(record.kind).toBe('task')
    expect(record.terminalType).toBe('ssh')
    expect(record.sshHost).toBe('h1')
    expect(record.userTask).toBe('问题一')
    expect(record.finalResult).toBe('回答一')
    expect(record.tokenUsage?.total_tokens).toBe(15)
    // transcript：user + 最终 assistant 回复
    expect(record.messages!.length).toBe(2)

    // 反序列化后再序列化：核心字段保持
    const conv2 = Conversation.fromRecord(record)
    const record2 = conv2.toRecord({ terminalId: 'pty-1' })!
    expect(record2.id).toBe('sess_rt')
    expect(record2.kind).toBe('task')
    expect(record2.terminalType).toBe('ssh')
    expect(record2.userTask).toBe('问题一')
    expect(record2.messages!.length).toBe(2)
    expect(conv2.taskMemory.getTaskCount()).toBe(1)
  })

  it('commitRun：reasoning_content 空串保留进 cache 前缀（带 tool_calls 的 assistant 不丢字段）', () => {
    const conv = Conversation.create({ agentKey: 'tab-r', terminalType: 'assistant' })
    const runMessages: AiMessage[] = [
      { role: 'user', content: '用工具' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } }]
      } as AiMessage,
      { role: 'tool', content: 'Unknown tool', tool_call_id: 'c1' } as AiMessage
    ]
    conv.commitRun({
      runId: 'run-r',
      userRequest: '用工具',
      steps: [userStep('用工具'), finalStep('完成')],
      taskMessageLog: [...runMessages],
      runMessages,
      taskStatus: 'success',
      result: '完成',
      reasoningContent: ''
    })

    const prefix = conv.getCachePrefix()!
    expect(prefix).toBeTruthy()
    // 带 tool_calls 的那条 assistant 仍带 reasoning_content（=== '' 保留，非 undefined）
    const assistantWithTools = prefix.find(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)!
    expect(assistantWithTools).toBeDefined()
    expect(assistantWithTools.reasoning_content).not.toBeUndefined()
    expect(assistantWithTools.reasoning_content).toBe('')
    // 末尾补了最终纯文本回复
    expect(prefix[prefix.length - 1]).toMatchObject({ role: 'assistant', content: '完成' })
  })

  it('commitRun：imagesStripped 时 cache 前缀快照剔除 images（剥图自愈，防毒前缀循环）', () => {
    const conv = Conversation.create({ agentKey: 'tab-s', terminalType: 'assistant' })
    const runMessages: AiMessage[] = [
      { role: 'user', content: '看图', images: ['data:image/png;base64,AAA'] },
      { role: 'assistant', content: '画面没传过来，请重新发送' }
    ]
    conv.commitRun({
      runId: 'run-s',
      userRequest: '看图',
      steps: [userStep('看图'), finalStep('画面没传过来，请重新发送')],
      taskMessageLog: runMessages.map(m => ({ ...m })),
      runMessages,
      taskStatus: 'success',
      result: '画面没传过来，请重新发送',
      imagesStripped: true,
    })

    const prefix = conv.getCachePrefix()!
    expect(prefix).toBeTruthy()
    expect(prefix.every(m => !m.images || m.images.length === 0)).toBe(true)
    // 文本内容保留
    expect(prefix[0]).toMatchObject({ role: 'user', content: '看图' })
  })

  it('commitRun：未触发剥图降级时 cache 前缀原样保留 images', () => {
    const conv = Conversation.create({ agentKey: 'tab-k', terminalType: 'assistant' })
    const runMessages: AiMessage[] = [
      { role: 'user', content: '看图', images: ['data:image/png;base64,BBB'] },
      { role: 'assistant', content: '这是一只猫' }
    ]
    conv.commitRun({
      runId: 'run-k',
      userRequest: '看图',
      steps: [userStep('看图'), finalStep('这是一只猫')],
      taskMessageLog: runMessages.map(m => ({ ...m })),
      runMessages,
      taskStatus: 'success',
      result: '这是一只猫',
    })

    const prefix = conv.getCachePrefix()!
    expect(prefix[0].images).toEqual(['data:image/png;base64,BBB'])
  })

  it('cache 前缀复用判定：无前缀 / wakeup / 前缀大到压缩都做不了才跳过', () => {
    const estimate = (msgs: AiMessage[]) => msgs.length * 100
    const conv = Conversation.create({ agentKey: 'tab-c', terminalType: 'assistant' })

    // 无前缀 → false
    expect(conv.shouldReuseCachePrefix(10000, { estimateTokens: estimate })).toBe(false)

    conv.commitRun({
      runId: 'r1', userRequest: 'q', steps: [userStep('q'), finalStep('a')],
      taskMessageLog: [{ role: 'user', content: 'q' }], runMessages: [{ role: 'user', content: 'q' }],
      taskStatus: 'success', result: 'a'
    })

    // 前缀 2 条 × 100 = 200，上限 10000 → 复用（历史变长本身不构成重建理由）
    expect(conv.shouldReuseCachePrefix(10000, { estimateTokens: estimate })).toBe(true)
    // wakeup → false（内心独白不复用对话前缀）
    expect(conv.shouldReuseCachePrefix(10000, { wakeup: true, estimateTokens: estimate })).toBe(false)
    // 上限降到 200（如换到更小窗口的模型）→ 连压缩的空间都不剩，回冷启动重建
    expect(conv.shouldReuseCachePrefix(200, { estimateTokens: estimate })).toBe(false)

    conv.setWorkingContext(conv.getCachePrefix())
    // 有交接后，窗口再小也接着检查点，不展开已交原文
    expect(conv.shouldReuseCachePrefix(200, { estimateTokens: estimate })).toBe(true)
    expect(conv.shouldReuseCachePrefix(1, { estimateTokens: estimate })).toBe(true)
    expect(conv.shouldResumeWorkingPrefix({ skipVisionCache: true })).toBe(true)
    expect(conv.shouldResumeWorkingPrefix({ wakeup: true })).toBe(false)
  })

  it('shouldResumeWorkingPrefix：没交接时新图首投才跳过，热路径接着前缀', () => {
    const conv = Conversation.create({ agentKey: 'tab-resume', terminalType: 'assistant' })
    expect(conv.shouldResumeWorkingPrefix({})).toBe(false)
    conv.commitRun({
      runId: 'r1', userRequest: 'q', steps: [userStep('q'), finalStep('a')],
      taskMessageLog: [{ role: 'user', content: 'q' }], runMessages: [{ role: 'user', content: 'q' }],
      taskStatus: 'success', result: 'a'
    })
    expect(conv.shouldResumeWorkingPrefix({})).toBe(true)
    expect(conv.shouldResumeWorkingPrefix({ skipVisionCache: true })).toBe(false)
  })

  it('reset：清空 transcript / 工作记忆 / cache / token', () => {
    const conv = Conversation.create({ agentKey: 'tab-z', terminalType: 'local' })
    conv.commitRun({
      runId: 'r1', userRequest: 'q', steps: [userStep('q'), finalStep('a')],
      taskMessageLog: [{ role: 'user', content: 'q' }], runMessages: [{ role: 'user', content: 'q' }],
      taskStatus: 'success', result: 'a', tokenUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
    expect(conv.taskMemory.getTaskCount()).toBe(1)
    expect(conv.messages.length).toBeGreaterThan(0)
    conv.adoptCompressedArchives([
      { id: 'ca-1', messages: [{ role: 'user', content: '原文' }], summary: '小结', timestamp: 1 }
    ])
    expect(conv.getCompressedArchives()).toHaveLength(1)

    conv.reset()
    expect(conv.taskMemory.getTaskCount()).toBe(0)
    expect(conv.messages.length).toBe(0)
    expect(conv.steps.length).toBe(0)
    expect(conv.getCachePrefix()).toBeUndefined()
    expect(conv.tokenUsage).toBeUndefined()
    expect(conv.getCompressedArchives()).toEqual([])
  })

  it('用量序列：相邻两次上报相减 = 那段消息的真实规模', () => {
    const conv = Conversation.create({ agentKey: 'tab-l', terminalType: 'local' })
    // 第 1 次请求带 3 条消息用了 1000；第 2 次带 5 条用了 1800
    // → 中间新增的那 2 条消息真实占 800（固定前缀在两边约掉）
    conv.recordPromptUsage(3, 1000)
    conv.recordPromptUsage(5, 1800)
    expect(conv.measureMessageRange(3, 5)).toBe(800)
    expect(conv.lastPromptTokens).toBe(1800)
  })

  it('用量序列：端点没有真实读数时返回 undefined，交给调用方回退估算', () => {
    const conv = Conversation.create({ agentKey: 'tab-l2', terminalType: 'local' })
    conv.recordPromptUsage(5, 1800)
    // 起点 5 有读数，终点 9 还没发过请求 → 不给近似值
    expect(conv.measureMessageRange(5, 9)).toBeUndefined()
    // 起点早于任何记录 → 同样说"不知道"
    expect(conv.measureMessageRange(1, 5)).toBeUndefined()
    expect(conv.measureMessageRange(5, 5)).toBe(0)
  })

  it('用量序列：作废锚点（压缩/冷启动重建）时一并清空，索引不再对不上号', () => {
    const conv = Conversation.create({ agentKey: 'tab-l3', terminalType: 'local' })
    conv.recordPromptUsage(3, 1000)
    conv.recordPromptUsage(5, 1800)
    conv.setLastPromptTokens(undefined)
    expect(conv.measureMessageRange(3, 5)).toBeUndefined()
  })

  it('用量序列：同一位置重复上报以最后一次为准（如剥图重试）', () => {
    const conv = Conversation.create({ agentKey: 'tab-l4', terminalType: 'local' })
    conv.recordPromptUsage(3, 1000)
    conv.recordPromptUsage(5, 1800)
    conv.recordPromptUsage(5, 1500)  // 同一条数重试，读数变小
    expect(conv.measureMessageRange(3, 5)).toBe(500)
  })

  it('用量序列：条数回退说明序列被改过，旧记录整体丢弃', () => {
    const conv = Conversation.create({ agentKey: 'tab-l5', terminalType: 'local' })
    conv.recordPromptUsage(5, 1800)
    conv.recordPromptUsage(9, 3000)
    conv.recordPromptUsage(4, 900)   // 变短了
    expect(conv.measureMessageRange(5, 9)).toBeUndefined()
    expect(conv.lastPromptTokens).toBe(900)
  })

  it('toRecord / toCheckpointRecord：传入的技能清单会跟着落盘', () => {
    const conv = Conversation.create(
      { agentKey: 'tab-sk', terminalType: 'assistant' },
      { id: 'sess_sk', createdAt: 1000 }
    )
    conv.commitRun({
      runId: 'run1',
      userRequest: '写文档',
      steps: [userStep('写文档'), finalStep('好')],
      taskMessageLog: [{ role: 'user', content: '写文档' }],
      runMessages: [{ role: 'user', content: '写文档' }],
      taskStatus: 'success',
      result: '好'
    })

    const saved = conv.toRecord({ loadedSkills: ['word', 'mcp:qcc'] })!
    expect(saved.loadedSkills).toEqual(['word', 'mcp:qcc'])

    const ckpt = conv.toCheckpointRecord({
      steps: [],
      taskMessageLog: [],
      loadedSkills: ['excel']
    })!
    expect(ckpt.loadedSkills).toEqual(['excel'])

    expect(conv.toRecord()!.loadedSkills).toBeUndefined()
  })

  it('forkFromRecord：把源记录的技能清单带到新任务', () => {
    const source: AgentRecord = {
      id: 'sess_src',
      timestamp: Date.now(),
      terminalId: '',
      agentKey: 'tab-1',
      terminalType: 'assistant',
      userTask: '写文档',
      steps: [{ id: 'u1', type: 'user_task', content: '写文档', timestamp: Date.now() }],
      messages: [{ role: 'user', content: '写文档' }, { role: 'assistant', content: '好' }],
      duration: 0,
      status: 'completed',
      loadedSkills: ['word', 'mcp:qcc']
    }
    const forked = Conversation.forkFromRecord(source, 'sess_fork')
    expect(forked?.record.loadedSkills).toEqual(['word', 'mcp:qcc'])
    expect(Conversation.forkFromRecord({ ...source, loadedSkills: undefined }, 'sess_fork2')?.record.loadedSkills).toBeUndefined()
  })

  it('rebind：会话漫游只换 agentKey，身份/形态不变', () => {
    const conv = Conversation.create({ agentKey: 'tab-A', terminalType: 'ssh' }, { id: 'sess_roam', sshHost: 'h1' })
    conv.rebind('tab-B')
    expect(conv.agentKey).toBe('tab-B')
    expect(conv.id).toBe('sess_roam')
    expect(conv.terminalType).toBe('ssh')
    expect(conv.sshHost).toBe('h1')
  })

  it('appendSteps：只追加过程，不另开一轮', () => {
    const conv = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    conv.commitRun({
      runId: 'run1',
      userRequest: '写文档',
      steps: [userStep('写文档'), finalStep('好')],
      taskMessageLog: [{ role: 'user', content: '写文档' }],
      runMessages: [{ role: 'user', content: '写文档' }],
      taskStatus: 'success',
      result: '好'
    })
    const beforeMessages = conv.messages.length
    conv.appendSteps([{
      id: 'compact_1',
      type: 'tool_call',
      content: '交接上下文',
      toolName: 'compress_context',
      timestamp: Date.now()
    }])
    expect(conv.steps.some(s => s.id === 'compact_1')).toBe(true)
    expect(conv.messages.length).toBe(beforeMessages)
    expect(conv.toRecord()!.steps.some(s => s.id === 'compact_1')).toBe(true)
  })

  it('commitTranscriptTurn：人主动压是新的一轮，不改工作上下文', () => {
    const conv = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    conv.commitRun({
      runId: 'run1',
      userRequest: '写文档',
      steps: [userStep('写文档'), finalStep('好')],
      taskMessageLog: [{ role: 'user', content: '写文档' }],
      runMessages: [{ role: 'user', content: '写文档' }],
      taskStatus: 'success',
      result: '好'
    })
    const handoff = [{ role: 'assistant' as const, content: '交接小结' }]
    conv.setWorkingContext(handoff)
    conv.setCachePrefix(handoff)

    conv.commitTranscriptTurn({
      runId: 'compact_1',
      userRequest: '压缩上下文',
      steps: [
        userStep('压缩上下文'),
        { id: 'c1', type: 'tool_call', content: '压缩上下文', timestamp: Date.now() } as AgentStep,
        finalStep('已压缩')
      ],
      taskStatus: 'success',
      result: '已压缩'
    })

    expect(conv.steps.some(s => s.content === '压缩上下文' && s.type === 'user_task')).toBe(true)
    expect(conv.taskMemory.getTask('compact_1')?.userRequest).toBe('压缩上下文')
    expect(conv.getCachePrefix()).toEqual(handoff)
    expect(conv.messages.some(m => m.role === 'user' && m.content === '压缩上下文')).toBe(true)
  })
})
