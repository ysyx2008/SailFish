/**
 * PowerShell 官方 AST 提取（Parser::ParseInput via pwsh-extract.ps1）
 *
 * Windows 默认 shell 为 PowerShell 时，替代 regex 回退，归一化为 AuditedCall。
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { resolveDefaultShell } from '../../../utils/shell'
import type { AuditedCall, AuditedRedirect, AuditContext } from './types'

const PWSH_EXTRACT_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pwsh-extract.ps1',
)

const PARSE_TIMEOUT_MS = 8_000

interface PwshExtractCall {
  raw: string
  cmd: string
  flags: string[]
  paths: string[]
  args: string[]
  redirects: AuditedRedirect[]
  dynamicPaths?: boolean
}

interface PwshExtractResult {
  ok: boolean
  calls: PwshExtractCall[]
  writeRedirects: AuditedRedirect[]
  errors?: string[]
}

function runPwshExtract(command: string): Promise<PwshExtractResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PWSH_EXTRACT_SCRIPT)) {
      reject(new Error(`pwsh-extract.ps1 not found: ${PWSH_EXTRACT_SCRIPT}`))
      return
    }

    const payloadB64 = Buffer.from(JSON.stringify({ command }), 'utf8').toString('base64')
    const shell = resolveDefaultShell()
    const child = spawn(
      shell.path,
      [
        '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
        '-File', PWSH_EXTRACT_SCRIPT,
        '-PayloadB64', payloadB64,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PowerShell AST parse timeout'))
    }, PARSE_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && code !== 1 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `pwsh-extract exited with code ${code}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as PwshExtractResult
        resolve(parsed)
      } catch (err) {
        reject(new Error(`pwsh-extract invalid JSON: ${stderr || stdout || String(err)}`))
      }
    })
  })
}

function toAuditedCall(raw: PwshExtractCall): AuditedCall {
  const flags = raw.flags ?? []
  return {
    cmd: raw.cmd,
    flags,
    args: raw.args ?? [],
    paths: raw.paths ?? [],
    redirects: raw.redirects ?? [],
    raw: raw.raw,
    source: 'powershell',
    dynamicPaths: raw.dynamicPaths || undefined,
    // PowerShell 这边 `--` 作为一个 flag 留下，看不出位置
    endOfOptions: flags.includes('--') || undefined,
  }
}

const INLINE_SCRIPT_FLAGS = new Set(['-Command', '-c', '--command', '-EncodedCommand'])

function scriptFromInlineCall(call: AuditedCall): string | null {
  for (const f of call.flags) {
    if (!INLINE_SCRIPT_FLAGS.has(f)) continue
    const candidate = call.args[0] ?? call.paths[0]
    return candidate?.trim() || null
  }
  return null
}

/** 展开 powershell/pwsh -Command 内联脚本（递归审计） */
async function unwrapPwshInlineScripts(
  calls: AuditedCall[],
  ctx: AuditContext,
): Promise<AuditedCall[]> {
  const out: AuditedCall[] = []
  for (const call of calls) {
    if (call.cmd === 'powershell' || call.cmd === 'pwsh') {
      const script = scriptFromInlineCall(call)
      if (script) {
        const inner = await extractPwshAuditedCalls(script, ctx)
        if (inner.calls.length > 0) {
          out.push(...inner.calls)
          continue
        }
      }
    }
    out.push(call)
  }
  return out
}

/** 从 PowerShell 命令串提取可审计子命令 */
export async function extractPwshAuditedCalls(
  command: string,
  ctx: AuditContext = {},
): Promise<{ calls: AuditedCall[]; writeRedirects: AuditedRedirect[] }> {
  void ctx
  const result = await runPwshExtract(command)
  if (!result.ok && result.calls.length === 0) {
    const msg = result.errors?.join('; ') || 'PowerShell parse produced no calls'
    throw new Error(msg)
  }

  let calls = result.calls.map(toAuditedCall)
  calls = await unwrapPwshInlineScripts(calls, ctx)

  return {
    calls,
    writeRedirects: result.writeRedirects ?? [],
  }
}

/** 预热：首次审计前可选调用，摊平 pwsh 冷启动 */
let preloadPromise: Promise<void> | null = null

export function ensurePwshAstReady(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  preloadPromise ??= extractPwshAuditedCalls('Write-Output ok')
    .then(() => undefined)
    .catch(() => undefined)
  return preloadPromise
}
