/**
 * 入口那一句算不算交给秘书的任务。
 * shell 会剥掉引号，一句话常常变成好几个参数。
 */

const CLI_COMMANDS = new Set([
  'models', 'companion', 'history', 'watch', 'knowledge', 'agent', 'help',
])

/**
 * 第一个词不是已知命令时，把整句当成任务。
 * 单独一个像命令名的英文词（例如打错的 modell）返回 null，调用方去提示用法。
 */
export function agentTaskFromWords(words: string[]): string | null {
  if (words.length === 0) return null
  const head = words[0]
  if (!head || head.includes(':') || CLI_COMMANDS.has(head)) return null
  const looksLikeCommand = /^[a-z][a-z0-9:_-]*$/i.test(head)
  if (words.length === 1 && looksLikeCommand) return null
  return words.join(' ')
}
