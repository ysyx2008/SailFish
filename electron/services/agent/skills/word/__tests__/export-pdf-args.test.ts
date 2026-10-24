import { EventEmitter } from 'node:events'
import * as fs from 'fs'
import { spawn } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import {
  MSWORD_MAC_SCRIPT,
  MSWORD_WINDOWS_SCRIPT,
  exportPdfWithLibreOffice,
  exportPdfWithMsWordMac,
  exportPdfWithMsWordWindows,
  libreOfficePdfLaunch,
} from '../pdf-export-launch'

const DOCX = `/tmp/My Documents/it's a "file";$(whoami).docx`
const PDF = `/tmp/My Documents/it's a "file";$(whoami).pdf`
const OUT_DIR = `/tmp/out's "dir"`

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdout: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stderr = new EventEmitter()
  child.stdout = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => child.emit('close', 0))
  return child
}

function assertPathIsItsOwnArg(args: string[], value: string) {
  expect(Array.isArray(args)).toBe(true)
  expect(args.filter(arg => arg === value)).toEqual([value])
  for (const arg of args) {
    if (arg === value) continue
    expect(arg).not.toContain(value)
  }
}

describe('Word PDF export argv', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
    vi.mocked(spawn).mockImplementation(() => fakeChild() as never)
  })

  it('Windows passes docx and pdf as arguments, not inside the script', async () => {
    let scriptBody = ''
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const list = args as string[]
      const fileIndex = list.indexOf('-File')
      scriptBody = fs.readFileSync(list[fileIndex + 1], 'utf8')
      return fakeChild() as never
    })

    await exportPdfWithMsWordWindows(DOCX, PDF)

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(options).toMatchObject({ shell: false })
    assertPathIsItsOwnArg(args as string[], DOCX)
    assertPathIsItsOwnArg(args as string[], PDF)
    expect(scriptBody).toBe(MSWORD_WINDOWS_SCRIPT)
    expect(scriptBody).not.toContain(DOCX)
    expect(scriptBody).not.toContain(PDF)
    expect(MSWORD_WINDOWS_SCRIPT).not.toContain(DOCX)
  })

  it('macOS passes docx and pdf as osascript argv, not inside the script', async () => {
    await exportPdfWithMsWordMac(DOCX, PDF)

    const [command, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(command).toBe('osascript')
    expect(options).toMatchObject({ shell: false })
    const list = args as string[]
    expect(list[0]).toBe('-e')
    expect(list[1]).toBe(MSWORD_MAC_SCRIPT)
    assertPathIsItsOwnArg(list, DOCX)
    assertPathIsItsOwnArg(list, PDF)
    expect(MSWORD_MAC_SCRIPT).not.toContain(DOCX)
    expect(MSWORD_MAC_SCRIPT).not.toContain("'\\''")
  })

  it('LibreOffice receives the paths as separate arguments', async () => {
    await exportPdfWithLibreOffice(DOCX, OUT_DIR, 'linux')

    const [command, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(command).toBe('libreoffice')
    expect(options).toMatchObject({ shell: false })
    const list = args as string[]
    expect(list).toEqual(['--headless', '--convert-to', 'pdf', '--outdir', OUT_DIR, DOCX])
    assertPathIsItsOwnArg(list, DOCX)
    assertPathIsItsOwnArg(list, OUT_DIR)
  })

  it('picks the platform binary without folding paths into the command', () => {
    expect(libreOfficePdfLaunch('darwin', DOCX, OUT_DIR)).toEqual({
      command: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      args: ['--headless', '--convert-to', 'pdf', '--outdir', OUT_DIR, DOCX],
    })
    expect(libreOfficePdfLaunch('win32', DOCX, OUT_DIR).command).toBe('libreoffice')
  })
})
