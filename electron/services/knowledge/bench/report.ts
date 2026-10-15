/**
 * 召回基线：报告呈现与两次结果对比
 *
 * 不自动裁决好坏——只把数字摆齐，包括「主动搜得到、但自动到场拿不到」那份清单，
 * 那是最有诊断价值的一栏。
 */

import type { BenchReport } from './types'

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

export class BenchReportFormatter {
  static toText(report: BenchReport): string {
    const m = report.metrics
    const lines: string[] = []

    lines.push(`召回基线：${report.name}`)
    lines.push(
      `跑于 ${new Date(report.runAt).toLocaleString()}　嵌入 ${report.embedding.mode}/${report.embedding.model}`
    )
    lines.push(`语料 ${report.corpusCount} 份　问题 ${report.caseCount} 条`)
    lines.push(
      `门槛　　　自动到场相似度 ${report.recallParams.autoSimilarity}　条数 ${report.recallParams.autoLimit}　分数下限 ${report.recallParams.minRrfScore}`
    )
    lines.push('')
    lines.push(`主动检索　top-1 ${pct(m.manualTop1)}　top-5 ${pct(m.manualTop5)}`)
    lines.push(`自动到场　命中 ${pct(m.autoHit)}　平均篇幅 ${m.autoAvgChars} 字/轮`)
    if (m.sectionAccuracy !== null) {
      lines.push(`段落准确　${pct(m.sectionAccuracy)}（找对文件的那些里，条款也对的比例）`)
    }
    lines.push(
      `噪音　　　${report.noise.length} 条无关问题中 ${report.noise.filter(n => n.recalled).length} 条发生召回`
    )

    const blindSpot = report.cases.filter(c => !c.autoHit && c.manualRank !== null)
    if (blindSpot.length > 0) {
      lines.push('')
      lines.push(`主动搜得到、自动到场拿不到（${blindSpot.length} 条）：`)
      for (const c of blindSpot) {
        lines.push(`  · ${c.question}　主动搜排第 ${c.manualRank}`)
      }
    }

    const missed = report.cases.filter(c => c.manualRank === null)
    if (missed.length > 0) {
      lines.push('')
      lines.push(`两个口都没搜到（${missed.length} 条）：`)
      for (const c of missed) lines.push(`  · ${c.question}`)
    }

    const noisy = report.noise.filter(n => n.recalled)
    if (noisy.length > 0) {
      lines.push('')
      lines.push('无关问题却召回了：')
      for (const n of noisy) lines.push(`  · ${n.question}　注入 ${n.chars} 字`)
    }

    return lines.join('\n')
  }

  /** 两份报告并排。嵌入模型不同会直接说明分数不可比 */
  static compare(before: BenchReport, after: BenchReport): string {
    const lines: string[] = []
    const sameEmbedding =
      before.embedding.mode === after.embedding.mode &&
      before.embedding.model === after.embedding.model

    lines.push(`对比：${before.name} → ${after.name}`)
    lines.push(
      `${new Date(before.runAt).toLocaleString()} → ${new Date(after.runAt).toLocaleString()}`
    )
    if (!sameEmbedding) {
      lines.push(
        `注意：嵌入不同（${before.embedding.mode}/${before.embedding.model} → ${after.embedding.mode}/${after.embedding.model}），分数不可直接比`
      )
    }
    if (before.caseCount !== after.caseCount) {
      lines.push(`注意：问题数不同（${before.caseCount} → ${after.caseCount}），分数不可直接比`)
    }

    // 门槛变化不是「不可比」，恰恰是对比的目的——所以单独说清动了哪个数
    const paramChanges = BenchReportFormatter.describeParamChanges(before, after)
    if (paramChanges.length > 0) {
      lines.push(`门槛变化：${paramChanges.join('　')}`)
    } else {
      lines.push('门槛未变')
    }
    lines.push('')

    const row = (label: string, a: number, b: number, fmt: (v: number) => string) => {
      const delta = b - a
      const sign = delta > 0 ? '+' : delta < 0 ? '' : '　'
      const deltaText = delta === 0 ? '—' : `${sign}${fmt(Math.abs(delta) === 0 ? 0 : delta)}`
      lines.push(`${label}　${fmt(a)} → ${fmt(b)}　${deltaText}`)
    }

    row('主动 top-1', before.metrics.manualTop1, after.metrics.manualTop1, pct)
    row('主动 top-5', before.metrics.manualTop5, after.metrics.manualTop5, pct)
    row('自动到场　', before.metrics.autoHit, after.metrics.autoHit, pct)
    row('噪音召回　', before.metrics.noiseRecall, after.metrics.noiseRecall, pct)
    row('平均篇幅　', before.metrics.autoAvgChars, after.metrics.autoAvgChars, v => `${Math.round(v)} 字`)
    if (before.metrics.sectionAccuracy !== null && after.metrics.sectionAccuracy !== null) {
      row('段落准确　', before.metrics.sectionAccuracy, after.metrics.sectionAccuracy, pct)
    }

    lines.push('')
    lines.push('读法：该来的更多（前三行涨）、不该来的没变多（噪音不涨）、篇幅没失控，才算改好了。')
    return lines.join('\n')
  }

  /** 老报告没有这一节，当成「不知道」而不是「没变」 */
  static describeParamChanges(before: BenchReport, after: BenchReport): string[] {
    const a = before.recallParams
    const b = after.recallParams
    if (!a || !b) return ['其中一次没有记录门槛，无法判断']

    const changes: string[] = []
    if (a.autoSimilarity !== b.autoSimilarity) {
      changes.push(`自动到场相似度 ${a.autoSimilarity} → ${b.autoSimilarity}`)
    }
    if (a.autoLimit !== b.autoLimit) changes.push(`条数 ${a.autoLimit} → ${b.autoLimit}`)
    if (a.minRrfScore !== b.minRrfScore) {
      changes.push(`分数下限 ${a.minRrfScore} → ${b.minRrfScore}`)
    }
    if (a.manualTopN !== b.manualTopN) {
      changes.push(`主动检索看前 ${a.manualTopN} → ${b.manualTopN} 名`)
    }
    return changes
  }
}
