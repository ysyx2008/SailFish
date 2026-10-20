/**
 * 两扇门：什么都不带，并且是自己开着终端，进同一屏；
 * 带上一句话就直接开工。帮助、版本、说完就走不进那一屏。
 */

/** 这些开关不吃掉后面的词。 */
const BOOLEAN_FLAGS = new Set(['once', 'verbose', 'free', 'sandbox', 'share-desktop'])

export type CliLaunch = 'help' | 'version' | 'screen' | 'run'

export function cliLaunch(args: string[], interactive: boolean): CliLaunch {
  const first = args[0]
  if (first === '--help' || first === '-h' || first === 'help') return 'help'
  if (first === '--version' || first === '-v') return 'version'
  if (!first) return interactive ? 'screen' : 'help'

  let positional = 0
  let once = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      positional += args.length - i - 1
      break
    }
    if (arg === '--once') {
      once = true
      continue
    }
    if (arg === '--task' || arg === '-t') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) return 'run'
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2).split('=')[0]
      const next = args[i + 1]
      if (!arg.includes('=') && !BOOLEAN_FLAGS.has(key) && next && !next.startsWith('-')) i++
      continue
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const next = args[i + 1]
      if (next && !next.startsWith('-')) i++
      continue
    }
    positional++
  }

  if (positional === 0) return interactive && !once ? 'screen' : 'help'
  return 'run'
}
