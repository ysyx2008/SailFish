// 认出「这是哪一路工作树」。vite.config.ts（工作树里 npm run dev）和 scripts/review.mjs（npm run review）共用。
import { execFileSync } from 'node:child_process'
import path from 'node:path'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** cwd 在工作树里时返回这一路的分支与位置；在主目录或不在 Git 里返回 null */
export function laneOf(cwd) {
  try {
    const gitDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']))
    const commonDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']))
    if (gitDir === commonDir) return null
    const worktree = git(cwd, ['rev-parse', '--show-toplevel'])
    const branch = git(cwd, ['branch', '--show-current']) || `detached-${git(cwd, ['rev-parse', '--short', 'HEAD'])}`
    return { branch, worktree }
  } catch {
    return null
  }
}
