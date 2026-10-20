import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { materializeAttachments } from '../attach'
import { cliLaunch } from '../launch'
import { composeLine, parseSlash, taskFromCompose, tokenizeShell } from '../compose'
import {
  emptyComposer,
  feedComposer,
  flattenTerminalText,
  frameLines,
  renderFrame,
} from '../tui-screen'

describe('cliLaunch', () => {
  it('不带参数、自己开着终端，进同一屏', () => {
    expect(cliLaunch([], true)).toBe('screen')
  })

  it('带上一句话是直接开工，不进那一屏', () => {
    expect(cliLaunch(['看下这个项目'], true)).toBe('run')
    expect(cliLaunch(['看下', '这个项目'], true)).toBe('run')
  })

  it('没开着终端、或说完就走，不进那一屏', () => {
    expect(cliLaunch([], false)).toBe('help')
    expect(cliLaunch(['--once'], true)).toBe('help')
    expect(cliLaunch(['--help'], true)).toBe('help')
    expect(cliLaunch(['--version'], true)).toBe('version')
  })

  it('只带开关时仍进同一屏，--task 算带了话', () => {
    expect(cliLaunch(['--verbose'], true)).toBe('screen')
    expect(cliLaunch(['--mode', 'free'], true)).toBe('screen')
    expect(cliLaunch(['--task', '看一下'], true)).toBe('run')
  })
})

describe('composeLine', () => {
  const cwd = '/work'
  const exists = (abs: string) => abs === '/work/a file.txt' || abs === '/tmp/note.txt' || abs === '/work/src'

  it('把引号和反斜杠里的真实路径拿出来当附件', () => {
    const escaped = composeLine('看下 /work/a\\ file.txt', cwd, exists)
    expect(escaped.paths).toEqual(['/work/a file.txt'])
    expect(escaped.message).toBe('看下')

    const quoted = composeLine("看下 '/tmp/note.txt'", cwd, exists)
    expect(quoted.paths).toEqual(['/tmp/note.txt'])
    expect(quoted.message).toBe('看下')
  })

  it('@路径和相对路径，目录也算', () => {
    expect(composeLine('读一下 @./src', cwd, exists).paths).toEqual(['/work/src'])
    expect(composeLine('./src 里有什么', cwd, exists)).toEqual({
      message: '里有什么',
      paths: ['/work/src'],
    })
  })

  it('普通词和并不存在的路径留在话里', () => {
    expect(composeLine('看下 package', cwd, () => {
      throw new Error('不该去核对普通词')
    })).toEqual({ message: '看下 package', paths: [] })
    expect(composeLine('看下 ./没有.txt', cwd, exists)).toEqual({
      message: '看下 ./没有.txt',
      paths: [],
    })
  })

  it('只拖了文件时，话变成看一下这些文件', () => {
    const composed = composeLine('/tmp/note.txt', cwd, exists)
    expect(taskFromCompose(composed)).toBe('看一下这些文件：note.txt')
  })

  it('外壳分词保留空格文件名', () => {
    expect(tokenizeShell('/work/a\\ file.txt')).toEqual(['/work/a file.txt'])
    expect(tokenizeShell("'/tmp/note.txt'")).toEqual(['/tmp/note.txt'])
  })

  it('用临时文件核对真实存在', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-'))
    const file = path.join(dir, 'readme.txt')
    fs.writeFileSync(file, 'hi')
    const composed = composeLine(`看 ${file}`, dir, (abs) => {
      try {
        return fs.statSync(abs).isFile()
      } catch {
        return false
      }
    })
    expect(composed.paths).toEqual([file])
    expect(composed.message).toBe('看')
    fs.rmSync(dir, { recursive: true })
  })
})

describe('parseSlash', () => {
  it('认识这一屏的命令', () => {
    expect(parseSlash('/skills')).toEqual({ name: 'skills', arg: '' })
    expect(parseSlash('/skill excel')).toEqual({ name: 'skill', arg: 'excel' })
    expect(parseSlash('/unskill "excel"')).toEqual({ name: 'unskill', arg: 'excel' })
    expect(parseSlash('/quit')).toEqual({ name: 'exit', arg: '' })
    expect(parseSlash('/nope')).toEqual({ name: 'unknown', arg: 'nope' })
  })

  it('路径不是命令', () => {
    expect(parseSlash('/Users/yushen/a.txt')).toBeNull()
    expect(parseSlash('看一下')).toBeNull()
  })
})

describe('screen', () => {
  it('输入钉在最后一行', () => {
    const lines = frameLines({
      columns: 40,
      rows: 6,
      title: 'SailFish  /work',
      body: '有，项目名是 SailFish。',
      status: '技能 表格',
      prompt: '› ',
      input: '你好',
      cursor: 2,
      scroll: 0,
    })
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('SailFish')
    expect(lines.some(line => line.includes('有，项目名是 SailFish。'))).toBe(true)
    expect(lines[4]).toContain('技能 表格')
    expect(lines[5]).toContain('› 你好')
    expect(renderFrame({
      columns: 40,
      rows: 6,
      title: 'SailFish',
      body: '有',
      status: '',
      prompt: '› ',
      input: '你好',
      cursor: 2,
      scroll: 0,
    })).toContain('\x1b[6;7H')
  })

  it('往上翻能看见更早的行', () => {
    const body = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n')
    const tail = frameLines({
      columns: 20, rows: 6, title: 't', body, status: '', prompt: '› ', input: '', cursor: 0, scroll: 0,
    })
    const up = frameLines({
      columns: 20, rows: 6, title: 't', body, status: '', prompt: '› ', input: '', cursor: 0, scroll: 3,
    })
    expect(tail.join('\n')).toContain('10')
    expect(tail.join('\n')).not.toContain('\n5\n')
    expect(up.join('\n')).toContain('5')
    expect(up.join('\n')).not.toContain('10')
  })

  it('密钥不出现在画面上', () => {
    const frame = renderFrame({
      columns: 40,
      rows: 6,
      title: 't',
      body: '',
      status: '',
      prompt: '密钥： ',
      input: 'secret',
      cursor: 6,
      scroll: 0,
      hidden: true,
    })
    expect(frame).not.toContain('secret')
    expect(frame).toContain('••••••')
  })

  it('活动行被盖掉，不留回车', () => {
    expect(flattenTerminalText('你好\r\x1b[K· 思考中…\n正文\n')).toBe('· 思考中…\n正文\n')
  })

  it('输入、粘贴、回车和方向键', () => {
    let state = emptyComposer()
    const type = feedComposer(state, '你好')
    state = type.state
    expect(state.value).toBe('你好')
    expect(state.cursor).toBe(2)

    const left = feedComposer(state, '\x1b[D')
    expect(left.state.cursor).toBe(1)

    const pasted = feedComposer(emptyComposer(), '\x1b[200~/tmp/a.txt\n\x1b[201~')
    expect(pasted.state.value).toBe('/tmp/a.txt ')
    expect(pasted.events.some(event => event.type === 'submit')).toBe(false)

    const submitted = feedComposer(pasted.state, '\r')
    expect(submitted.events).toContainEqual({ type: 'submit', text: '/tmp/a.txt ' })
    expect(submitted.state.value).toBe('')

    const split = feedComposer(emptyComposer(), '\x1b')
    const done = feedComposer(split.state, '[D')
    expect(done.state.cursor).toBe(0)

    const emoji = feedComposer(emptyComposer(), '🙂')
    const rubbed = feedComposer(emoji.state, '\x7f')
    expect(rubbed.state.value).toBe('')

    expect(feedComposer(emptyComposer(), '\x03').events.some(event => event.type === 'interrupt')).toBe(true)
  })
})

describe('真实终端', () => {
  const root = path.resolve(__dirname, '../../..')

  it('画得出这一屏', async () => {
    const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs')
    const script = path.join(root, 'electron/cli/tui-paint.ts')
    const term = spawn(process.execPath, [tsx, script], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      env: process.env as Record<string, string>,
    })
    let data = ''
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`paint timeout\n${data.slice(-400)}`)), 20_000)
        term.onData((chunk) => {
          data += chunk
          if (data.includes('__PAINTED__')) {
            clearTimeout(timer)
            resolve()
          }
        })
        term.onExit(() => {
          if (!data.includes('__PAINTED__')) {
            clearTimeout(timer)
            reject(new Error(data.slice(-400) || 'paint exited with no output'))
          }
        })
      })
    } finally {
      term.kill()
    }
    expect(data).toContain('TTY')
    expect(data).toContain('\x1b[?1049h')
    expect(data).toContain('你好')
    expect(data).toContain('SailFish')
  }, 25_000)

  it('文本和图片走桌面贴文件的那条路', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-attach-'))
    const note = path.join(dir, 'note.txt')
    const image = path.join(dir, 'dot.png')
    fs.writeFileSync(note, '旗鱼附件')
    fs.writeFileSync(image, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ))
    try {
      const result = await materializeAttachments([note, image])
      expect(result.errors).toEqual([])
      expect(result.documentContext).toContain('sf_uploaded_docs')
      expect(result.documentContext).toContain('旗鱼附件')
      expect(result.attachments.map(item => item.filename)).toEqual(['note.txt', 'dot.png'])
      expect(result.images?.[0]).toMatch(/^data:image\/png;base64,/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('不带参数会进入这一屏，能看到技能并加上，/exit 离开', async () => {
    const term = spawn(process.execPath, [path.join(root, 'electron/cli/main.js')], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' } as Record<string, string>,
    })
    let data = ''
    let step = 0
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`screen timeout\n${data.slice(-800)}`)), 45_000)
        term.onData((chunk) => {
          data += chunk
          if (step === 0 && data.includes('拖进终端')) {
            step = 1
            term.write('/skills\r')
          } else if (step === 1 && data.includes('可以加')) {
            step = 2
            term.write('/skill excel\r')
          } else if (step === 2 && data.includes('已加上')) {
            step = 3
            term.write('/exit\r')
          }
        })
        term.onExit(({ exitCode }) => {
          clearTimeout(timer)
          resolve(exitCode ?? 0)
        })
      })
      expect(step).toBe(3)
      expect(data).toContain('\x1b[?1049h')
      expect(data).toContain('可以加')
      expect(data).toContain('已加上')
      expect(code).toBe(0)
    } finally {
      term.kill()
    }
  }, 50_000)
})
