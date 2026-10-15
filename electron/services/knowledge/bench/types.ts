/**
 * 召回基线：类型定义
 *
 * 基线只量不改——这里的任何东西都不参与产品运行期的召回路径。
 */

/** 语料条目。id 是问题集里指代「期望命中哪份文档」的稳定句柄 */
export interface BenchCorpusEntry {
  id: string
  /** 文件路径；相对路径按问题集文件所在目录解析 */
  file: string
}

/** AI 出的是候选，采纳与否由人定 */
export type BenchCaseStatus = 'candidate' | 'approved' | 'rejected'

export interface BenchCase {
  id: string
  question: string
  /** 期望命中的语料 id */
  expectDocId: string
  /** 期望命中的段落定位词（条款号或小节标题），用于区分「找对文件」与「找对段落」 */
  expectText?: string
  status: BenchCaseStatus
}

export interface BenchQuestionSet {
  name: string
  createdAt: string
  corpus: BenchCorpusEntry[]
  cases: BenchCase[]
  /** 与语料明确无关的问题，期望零召回 */
  noiseQuestions: string[]
}

export interface BenchCaseResult {
  caseId: string
  question: string
  expectDocId: string
  /** 主动检索口：期望文档在结果中的位次（1 起），未命中为 null */
  manualRank: number | null
  /** 自动到场口：期望文档是否会被注入对话 */
  autoHit: boolean
  /** 本轮真实注入的字符数 */
  autoChars: number
  /** expectText 是否出现在命中片段里；未标注期望段落时为 null */
  sectionHit: boolean | null
}

export interface BenchNoiseResult {
  question: string
  recalled: boolean
  chars: number
}

export interface BenchMetrics {
  /** 主动检索命中率：期望文档排第一 / 进前五 */
  manualTop1: number
  manualTop5: number
  /** 自动到场命中率 */
  autoHit: number
  /** 自动到场平均注入字符数（含未命中的轮次，代表真实预算占用） */
  autoAvgChars: number
  /** 噪音问题里发生召回的比例，越低越好 */
  noiseRecall: number
  /** 找对文件的那些里，段落也对的比例；没有标注期望段落时为 null */
  sectionAccuracy: number | null
}

/** 跑这次基线时线上召回用的门槛。改门槛前后对照全靠它，必须随报告存档 */
export interface BenchRecallParams {
  autoLimit: number
  autoSimilarity: number
  minRrfScore: number
  /** 主动检索口看前几名 */
  manualTopN: number
}

export interface BenchReport {
  name: string
  runAt: string
  /** 换嵌入模型后分数不可比，必须随报告存档 */
  embedding: { mode: string; model: string }
  recallParams: BenchRecallParams
  corpusCount: number
  /** 参与评测的问题数（不含被否决与未采纳的） */
  caseCount: number
  metrics: BenchMetrics
  cases: BenchCaseResult[]
  noise: BenchNoiseResult[]
}

export interface RunBenchOptions {
  /** 问题集文件所在目录，用于解析相对路径的语料 */
  baseDir: string
  /** 连未采纳的候选一起跑 */
  includeCandidates?: boolean
  /** 跑完保留入库的语料（默认清理，只清本次自己加的） */
  keepCorpus?: boolean
  onProgress?: (done: number, total: number, label: string) => void
}
