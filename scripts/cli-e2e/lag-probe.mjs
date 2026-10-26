/**
 * 用 `node --import` 预加载：量命令行进程事件循环的卡顿，退出时把分位数写到 SFT_LAG_FILE。
 * 只给端到端验证用，不属于产品代码。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import fs from 'node:fs'

const file = process.env.SFT_LAG_FILE
if (file) {
  const h = monitorEventLoopDelay({ resolution: 5 })
  h.enable()
  process.on('exit', () => {
    h.disable()
    const ms = (ns) => Math.round(ns / 1e4) / 100
    fs.writeFileSync(file, JSON.stringify({
      p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), samples: h.count,
    }))
  })
}
