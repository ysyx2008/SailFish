/**
 * 召回基线：把「记忆好不好」变成可对照的数字。
 *
 * 纯只读工具，不参与产品运行期的召回路径。设计取舍见 ../SPEC.md
 * 「记忆召回要有一条能对照的基线」。
 */

export { BenchCorpus } from './corpus'
export { QuestionGenerator } from './question-generator'
export { QuestionSetStore } from './question-set'
export { RecallBench } from './recall-bench'
export { BenchReportFormatter } from './report'
export type {
  BenchCase,
  BenchCaseResult,
  BenchCaseStatus,
  BenchCorpusEntry,
  BenchMetrics,
  BenchNoiseResult,
  BenchQuestionSet,
  BenchReport,
  RunBenchOptions
} from './types'
