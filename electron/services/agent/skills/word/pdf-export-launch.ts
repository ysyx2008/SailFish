/**
 * Word 导出 PDF：docx / pdf 路径只出现在进程参数里，不写进命令字符串。
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const PDF_EXPORT_TIMEOUT_MS = 60_000

/** 静态脚本，不含任何文件路径。路径由 -DocxPath / -PdfPath 传入。 */
export const MSWORD_WINDOWS_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$DocxPath,
  [Parameter(Mandatory = $true)][string]$PdfPath
)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Open($DocxPath)
  $doc.SaveAs($PdfPath, 17)
  $doc.Close()
} finally {
  $word.Quit()
}
`

/** 静态脚本。路径在 osascript 的 run argv 里，不写进这段文本。 */
export const MSWORD_MAC_SCRIPT = `on run argv
  set docxPath to item 1 of argv
  set pdfPath to item 2 of argv
  tell application "Microsoft Word"
    activate
    open POSIX file docxPath
    set theDoc to active document
    save as theDoc file name POSIX file pdfPath file format format PDF
    close theDoc saving no
  end tell
end run
`

export function msWordWindowsPdfArgs(scriptPath: string, docxPath: string, pdfPath: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    scriptPath,
    '-DocxPath',
    docxPath,
    '-PdfPath',
    pdfPath,
  ]
}

export function msWordMacPdfArgs(docxPath: string, pdfPath: string): string[] {
  return ['-e', MSWORD_MAC_SCRIPT, docxPath, pdfPath]
}

export function libreOfficePdfLaunch(
  platform: NodeJS.Platform,
  docxPath: string,
  outDir: string,
): { command: string; args: string[] } {
  const command = platform === 'darwin'
    ? '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    : 'libreoffice'
  return {
    command,
    args: ['--headless', '--convert-to', 'pdf', '--outdir', outDir, docxPath],
  }
}

/** 不用 shell。超时后杀掉子进程。 */
export function runArgv(command: string, args: string[], timeoutMs = PDF_EXPORT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stderr = ''
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`PDF export timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(stderr.trim() || `PDF export exited with code ${code}`))
    })
  })
}

export async function exportPdfWithMsWordWindows(docxPath: string, pdfPath: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-word-pdf-'))
  const scriptPath = path.join(dir, 'export.ps1')
  try {
    fs.writeFileSync(scriptPath, MSWORD_WINDOWS_SCRIPT, 'utf8')
    await runArgv('powershell.exe', msWordWindowsPdfArgs(scriptPath, docxPath, pdfPath))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function exportPdfWithMsWordMac(docxPath: string, pdfPath: string): Promise<void> {
  await runArgv('osascript', msWordMacPdfArgs(docxPath, pdfPath))
}

export async function exportPdfWithLibreOffice(
  docxPath: string,
  outDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { command, args } = libreOfficePdfLaunch(platform, docxPath, outDir)
  await runArgv(command, args)
}
