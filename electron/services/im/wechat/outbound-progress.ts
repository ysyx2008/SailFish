/**
 * 微信出站过程消息策略：对 IMProgressOutboundCapable 的具体实现，
 * 内部委托 progress-buffer 合并 digest，经 adapter 串行 lane 发出。
 */
import { WechatProgressBuffer } from './progress-buffer.js'

export type WechatOutboundProgressSend = (text: string) => Promise<void>

export type WechatOutboundProgressOptions = {
  sendDigest: WechatOutboundProgressSend
}

export class WechatOutboundProgress {
  private readonly buffer: WechatProgressBuffer

  constructor(options: WechatOutboundProgressOptions) {
    this.buffer = new WechatProgressBuffer(options.sendDigest, {})
  }

  /** 入队一行工具进度文本（🔧/❌） */
  push(text: string): void {
    this.buffer.push(text)
  }

  /** 入队一段正文（AI 写给用户的消息内容），触发 body 边界感知 flush */
  pushBody(text: string): void {
    this.buffer.pushBody(text)
  }

  /** 开始等用户回复：攒着的马上发，之后也不再定时攒。 */
  beginUserWait(): void {
    this.buffer.beginUserWait()
  }

  /** 用户已经回复，过程消息恢复节流。 */
  endUserWait(): void {
    this.buffer.endUserWait()
  }

  flush(): Promise<void> {
    return this.buffer.flush()
  }

  dispose(): Promise<void> {
    return this.buffer.dispose()
  }
}
