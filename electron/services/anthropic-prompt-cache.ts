/** 仅处理协议缓存标记；不改变提示词内容或执行策略。 */
type Message = Record<string, unknown>
type Block = Record<string, unknown>

export function normalizeAnthropicMessage(message: Message, boundary = false): void {
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
  if (!boundary || !Array.isArray(message.content)) return
  const last = lastCacheable(message.content as Block[])
  if (last) last.cache_control = { type: 'ephemeral' }
}

function cacheable(block: Block): boolean {
  return block.type === 'text' ? typeof block.text === 'string' && block.text.length > 0
    : ['tool_use', 'tool_result', 'image', 'document'].includes(String(block.type))
}

function lastCacheable(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) if (cacheable(blocks[i])) return blocks[i]
}

/** system和tools各占一个断点，消息只留最近的旧边界与本次末尾，合计不超过4个。 */
export function cacheAnthropicMessageTail(messages: Message[]): void {
  const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content as Block[] : [])
  const marked = blocks.filter(block => block.cache_control && cacheable(block))
  for (const block of blocks) delete block.cache_control
  const previous = marked.at(-1)
  const tail = lastCacheable(blocks)
  for (const block of new Set([previous, tail])) {
    if (block) block.cache_control = { type: 'ephemeral' }
  }
}
