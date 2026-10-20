/**
 * 把终端里的一行拆开：确实存在的路径是附件，其余是要说的话。
 * 斜杠开头、并且是这里认识的命令，才是命令；不靠词义猜测。
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

export type SlashName = 'help' | 'exit' | 'skills' | 'skill' | 'unskill' | 'unknown'

export interface SlashCommand {
  name: SlashName
  arg: string
}

const COMMANDS = new Set<SlashName>(['help', 'exit', 'skills', 'skill', 'unskill'])

/** 行首是命令时返回它。`/Users/文件` 这种路径不是命令。 */
export function parseSlash(line: string): SlashCommand | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const word = match[1].toLowerCase()
  const arg = (match[2] || '').trim().replace(/^["']|["']$/g, '')
  if (word === 'quit') return { name: 'exit', arg: '' }
  if (COMMANDS.has(word as SlashName)) return { name: word as SlashName, arg }
  if (/^\/[A-Za-z][\w-]*$/.test(trimmed)) return { name: 'unknown', arg: word }
  return null
}

/** 外壳会把拖进来的空格写成反斜杠，或包在引号里。 */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (quote === '"' && ch === '\\' && i + 1 < input.length) {
        current += input[++i]
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i]
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

export function pathExists(absolutePath: string): boolean {
  try {
    const stat = fs.statSync(absolutePath)
    return stat.isFile() || stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * 像路径的词（/、./、../、~/、或 @路径）若确实存在，从这句话里拿掉，当作附件。
 * 不存在的留在话里。普通词即使碰巧有同名文件，也不拿掉。
 */
export function composeLine(
  input: string,
  cwd: string,
  isAttachment: (absolutePath: string) => boolean,
): { message: string; paths: string[] } {
  const kept: string[] = []
  const paths: string[] = []
  for (const token of tokenizeShell(input)) {
    const abs = attachmentPath(token, cwd)
    if (abs && isAttachment(abs)) {
      if (!paths.includes(abs)) paths.push(abs)
      continue
    }
    kept.push(token)
  }
  return { message: kept.join(' ').trim(), paths }
}

export function taskFromCompose(composed: { message: string; paths: string[] }): string {
  if (composed.message) return composed.message
  if (composed.paths.length === 0) return ''
  const names = composed.paths.map(file => path.basename(file))
  return `看一下这些文件：${names.join('、')}`
}

function attachmentPath(token: string, cwd: string): string | null {
  let raw = token
  let marked = false
  if (raw.startsWith('@')) {
    marked = true
    raw = raw.slice(1)
  }
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) return null
  const looks = marked
    || raw.startsWith('/')
    || raw.startsWith('./')
    || raw.startsWith('../')
    || raw.startsWith('~/')
  if (!looks) return null
  if (raw.startsWith('~/')) raw = path.join(os.homedir(), raw.slice(2))
  return path.resolve(cwd, raw)
}
