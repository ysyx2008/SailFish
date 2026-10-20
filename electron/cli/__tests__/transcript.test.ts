import { describe, it, expect } from 'vitest'
import { CliTranscript, confirmationLines, visibleReply } from '../transcript'
import { agentTaskFromWords } from '../invoke'

function capture(options: { tty?: boolean; verbose?: boolean; color?: boolean } = {}) {
  let out = ''
  const transcript = new CliTranscript({
    ...options,
    write: (chunk) => { out += chunk },
    columns: 80,
  })
  return {
    transcript,
    text: () => out.replace(/\x1b\[[0-9;]*m/g, ''),
    raw: () => out,
  }
}

const thinking = [
  '<details open>',
  '<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>',
  '<blockquote>',
  '用户说看下这个项目，我先在家里翻翻。',
  '</blockquote>',
  '</details>',
  '',
  '这是旗鱼的仓库，桌面端和命令行共用同一套秘书。',
].join('\n')

describe('visibleReply', () => {
  it('去掉思考块，只留说出来的话', () => {
    expect(visibleReply(thinking)).toBe('这是旗鱼的仓库，桌面端和命令行共用同一套秘书。')
  })

  it('思考还没写完时，正文是空的', () => {
    expect(visibleReply('<details open>\n<summary>思考过程</summary>\n还在想')).toBe('')
  })

  it('普通比较符号留着', () => {
    expect(visibleReply('3 < 5 and 7 > 2')).toBe('3 < 5 and 7 > 2')
  })
})

describe('CliTranscript', () => {
  it('流式思考不占正文，说出来的话只出现一次', () => {
    const { transcript, text } = capture({ tty: true })
    transcript.push({
      id: 'm1',
      type: 'message',
      isStreaming: true,
      content: '<details open>\n<summary>思考过程</summary>\n先看看目录',
    })
    transcript.push({
      id: 'm1',
      type: 'message',
      isStreaming: true,
      content: thinking.slice(0, 40),
    })
    transcript.push({ id: 'm1', type: 'message', isStreaming: false, content: thinking })
    transcript.finish(thinking)
    const printed = text()
    expect(printed).toContain('这是旗鱼的仓库')
    expect(printed).not.toContain('思考过程')
    expect(printed).not.toContain('<details')
    expect(printed.split('这是旗鱼的仓库').length - 1).toBe(1)
  })

  it('做事是一行，不打工具名和参数', () => {
    const { transcript, text } = capture({ tty: false })
    transcript.push({
      id: 't1',
      type: 'tool_call',
      content: '执行命令: pwd',
      toolName: 'execute_command',
      toolArgs: { command: 'pwd' },
    })
    transcript.push({
      id: 'r1',
      type: 'tool_result',
      content: '/Users/yushen/Source/SFTerminal',
      toolName: 'execute_command',
      toolResult: '/Users/yushen/Source/SFTerminal',
      success: true,
    })
    const printed = text()
    expect(printed).toContain('· 执行命令: pwd')
    expect(printed).not.toContain('Tool:')
    expect(printed).not.toContain('Args:')
    expect(printed).not.toContain('SFTerminal')
  })

  it('失败只补一句，正文不被过程打断后再重复', () => {
    const { transcript, text } = capture({ tty: false })
    transcript.push({ id: 't1', type: 'tool_call', content: '读取 README', toolName: 'read_file' })
    transcript.push({ id: 't1', type: 'tool_call', content: '读取 README', success: false, toolName: 'read_file' })
    transcript.push({
      id: 'm1',
      type: 'message',
      content: 'README 没读到。',
    })
    transcript.finish('README 没读到。')
    const printed = text()
    expect(printed).toContain('· 读取 README')
    expect(printed).toContain('没有做成')
    expect(printed.split('README 没读到').length - 1).toBe(1)
  })

  it('提问不把已经说过的问句再打一遍，选项单独列出', () => {
    const { transcript, text } = capture({ tty: false })
    transcript.push({ id: 'm1', type: 'message', content: '订哪间？' })
    transcript.push({
      id: 'a1',
      type: 'asking',
      content: '订哪间？',
      toolArgs: { options: ['湖景', '城景'] },
    })
    const printed = text()
    expect(printed.split('订哪间').length - 1).toBe(1)
    expect(printed).toContain('1. 湖景')
    expect(printed).toContain('2. 城景')
  })

  it('同一句先说过，再标成联络说，不再打一遍', () => {
    const { transcript, text } = capture({ tty: false })
    transcript.push({ id: 'm1', type: 'message', content: '任务做完了，目录里有 12 个文件。' })
    transcript.push({
      id: 's1',
      type: 'tool_call',
      toolName: 'talk_to_user',
      toolArgs: { message: '任务做完了，目录里有 12 个文件。' },
    })
    expect(text().split('12 个文件').length - 1).toBe(1)
    expect(text()).not.toContain('联络说')
  })

  it('联络说的话按正文打出来', () => {
    const { transcript, text } = capture({ tty: false })
    transcript.push({
      id: 's1',
      type: 'tool_call',
      toolName: 'talk_to_user',
      content: 'talk',
      toolArgs: { message: '任务做完了，目录里有 12 个文件。' },
    })
    transcript.finish('任务做完了，目录里有 12 个文件。')
    const printed = text()
    expect(printed).toContain('联络说')
    expect(printed.split('12 个文件').length - 1).toBe(1)
  })
})

describe('confirmationLines', () => {
  it('点头时能看见要执行的命令，看不见参数堆', () => {
    const lines = confirmationLines({
      toolName: 'execute_command',
      displayName: '执行命令',
      riskLabel: '高风险',
      reasons: ['会删除目录'],
      toolArgs: { command: 'rm -rf /tmp/demo', timeout: 30 },
    })
    const text = lines.join('\n')
    expect(text).toContain('高风险')
    expect(text).toContain('rm -rf /tmp/demo')
    expect(text).toContain('会删除目录')
    expect(text).not.toContain('timeout')
    expect(text).not.toContain('{')
  })
})

describe('agentTaskFromWords', () => {
  it('没加引号的一句中文是任务', () => {
    expect(agentTaskFromWords(['看下', '这个', '项目'])).toBe('看下 这个 项目')
  })

  it('已知命令不拿去当任务', () => {
    expect(agentTaskFromWords(['history', 'list'])).toBeNull()
    expect(agentTaskFromWords(['models'])).toBeNull()
  })

  it('单独一个像命令的英文词留给用法提示', () => {
    expect(agentTaskFromWords(['modell'])).toBeNull()
  })
})
