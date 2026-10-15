/**
 * 召回基线：执行与指标
 *
 * 量两口：
 *  - 主动检索口 —— Agent 自己调搜索时看到的结果
 *  - 自动到场口 —— 每轮对话自动注入上下文的那条路，门槛高得多
 *
 * 指标成对给。只看命中率，最省事的改法就是把门槛调低，命中率一定涨，
 * 代价是无关内容挤进每一轮对话；所以噪音率和篇幅占用必须同时在场。
 */

import { AUTO_RECALL_LIMIT, AUTO_RECALL_SIMILARITY, MIN_RRF_SCORE } from '../index'
import type { KnowledgeService } from '../index'
import type { DocumentParserService } from '../../document-parser.service'
import type { SearchResult } from '../types'
import { BenchCorpus } from './corpus'
import { QuestionSetStore } from './question-set'
import type {
  BenchCaseResult,
  BenchMetrics,
  BenchNoiseResult,
  BenchQuestionSet,
  BenchReport,
  RunBenchOptions
} from './types'

export class RecallBench {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly parser: DocumentParserService
  ) {}

  async run(set: BenchQuestionSet, options: RunBenchOptions): Promise<BenchReport> {
    const cases = QuestionSetStore.selectCases(set, options.includeCandidates)
    if (cases.length === 0) {
      throw new Error('没有可跑的问题：问题集里全是未采纳的候选或已否决项（要连候选一起跑请加 --include-candidates）')
    }

    const corpus = new BenchCorpus(this.knowledge, this.parser)

    try {
      await corpus.ensure(
        set.corpus,
        entry => QuestionSetStore.resolveCorpusFile(entry, options.baseDir),
        (done, total, label) => options.onProgress?.(done, total, `入库 ${label}`)
      )

      const caseResults: BenchCaseResult[] = []
      for (const [i, c] of cases.entries()) {
        const expectedDocId = corpus.docIdOf(c.expectDocId)
        if (!expectedDocId) {
          throw new Error(`问题 ${c.id} 指向的语料没有入库：${c.expectDocId}`)
        }
        caseResults.push(await this.runCase(c, expectedDocId))
        options.onProgress?.(i + 1, cases.length, `提问 ${c.question.slice(0, 20)}`)
      }

      const noise: BenchNoiseResult[] = []
      for (const question of set.noiseQuestions) {
        const context = await this.knowledge.buildContext(question, {})
        noise.push({ question, recalled: context.length > 0, chars: context.length })
      }

      const settings = this.knowledge.getSettings()
      return {
        name: set.name,
        runAt: new Date().toISOString(),
        embedding: { mode: settings.embeddingMode, model: settings.localModel },
        corpusCount: set.corpus.length,
        caseCount: caseResults.length,
        metrics: RecallBench.computeMetrics(caseResults, noise),
        cases: caseResults,
        noise
      }
    } finally {
      if (!options.keepCorpus) {
        await corpus.cleanup()
      }
    }
  }

  private async runCase(
    c: BenchQuestionSet['cases'][number],
    expectedDocId: string
  ): Promise<BenchCaseResult> {
    // 主动检索口：不设相似度门槛，看期望文档排第几
    const manual = await this.knowledge.search(c.question, { limit: AUTO_RECALL_LIMIT })
    const manualIndex = manual.findIndex(r => r.docId === expectedDocId)

    // 自动到场口：复刻线上实参，再按分数下限过一遍
    const autoCandidates = await this.knowledge.search(c.question, {
      limit: AUTO_RECALL_LIMIT,
      similarity: AUTO_RECALL_SIMILARITY
    })
    const survived = autoCandidates.filter(r => r.score >= MIN_RRF_SCORE)
    const expectedSurvived = survived.some(r => r.docId === expectedDocId)
    const expectedInCandidates = autoCandidates.some(r => r.docId === expectedDocId)

    // 真实注入的那段文本，用来量篇幅占用
    const context = await this.knowledge.buildContext(c.question, {})

    return {
      caseId: c.id,
      question: c.question,
      expectDocId: c.expectDocId,
      manualRank: manualIndex >= 0 ? manualIndex + 1 : null,
      autoHit: expectedSurvived && context.length > 0,
      autoChars: context.length,
      autoSuppressed: expectedInCandidates && !expectedSurvived,
      sectionHit: c.expectText
        ? RecallBench.hitsSection(manual, expectedDocId, c.expectText)
        : null
    }
  }

  /** 找对了文件，命中的片段里是否也有期望的那一条 */
  private static hitsSection(
    results: SearchResult[],
    expectedDocId: string,
    expectText: string
  ): boolean {
    const needle = expectText.replace(/\s+/g, '')
    return results
      .filter(r => r.docId === expectedDocId)
      .some(r => r.content.replace(/\s+/g, '').includes(needle))
  }

  static computeMetrics(cases: BenchCaseResult[], noise: BenchNoiseResult[]): BenchMetrics {
    const ratio = (n: number, total: number) => (total === 0 ? 0 : n / total)
    const sectionScored = cases.filter(c => c.sectionHit !== null && c.manualRank !== null)

    return {
      manualTop1: ratio(cases.filter(c => c.manualRank === 1).length, cases.length),
      manualTop5: ratio(cases.filter(c => c.manualRank !== null).length, cases.length),
      autoHit: ratio(cases.filter(c => c.autoHit).length, cases.length),
      autoAvgChars:
        cases.length === 0
          ? 0
          : Math.round(cases.reduce((sum, c) => sum + c.autoChars, 0) / cases.length),
      noiseRecall: ratio(noise.filter(n => n.recalled).length, noise.length),
      sectionAccuracy:
        sectionScored.length === 0
          ? null
          : ratio(sectionScored.filter(c => c.sectionHit).length, sectionScored.length)
    }
  }
}
