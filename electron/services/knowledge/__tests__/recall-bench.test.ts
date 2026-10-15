/**
 * 召回基线的纯逻辑单测：指标计算、问题集筛选与校验、模型输出解析。
 *
 * 指标口径是这套工具的全部价值所在，算错了比没有更糟——所以这里锁死口径，
 * 尤其是「平均篇幅要把没命中的轮次也算进去」「段落准确只统计找对文件的」。
 */
import { describe, it, expect } from 'vitest'
import { RecallBench } from '../bench/recall-bench'
import { QuestionSetStore } from '../bench/question-set'
import { QuestionGenerator } from '../bench/question-generator'
import type { BenchCaseResult, BenchNoiseResult, BenchQuestionSet } from '../bench/types'

function caseResult(partial: Partial<BenchCaseResult>): BenchCaseResult {
  return {
    caseId: 'q',
    question: '问题',
    expectDocId: 'doc',
    manualRank: null,
    autoHit: false,
    autoChars: 0,
    autoSuppressed: false,
    sectionHit: null,
    ...partial
  }
}

describe('RecallBench.computeMetrics', () => {
  it('命中率按位次算：排第一进 top-1，进前五算 top-5', () => {
    const m = RecallBench.computeMetrics(
      [
        caseResult({ manualRank: 1 }),
        caseResult({ manualRank: 3 }),
        caseResult({ manualRank: null }),
        caseResult({ manualRank: 1 })
      ],
      []
    )
    expect(m.manualTop1).toBeCloseTo(0.5)
    expect(m.manualTop5).toBeCloseTo(0.75)
  })

  it('平均篇幅把没命中的轮次也算进去——它代表真实预算占用', () => {
    const m = RecallBench.computeMetrics(
      [
        caseResult({ autoHit: true, autoChars: 400 }),
        caseResult({ autoHit: false, autoChars: 0 })
      ],
      []
    )
    expect(m.autoHit).toBeCloseTo(0.5)
    expect(m.autoAvgChars).toBe(200)
  })

  it('段落准确只统计「找对文件且标注了期望段落」的那些', () => {
    const m = RecallBench.computeMetrics(
      [
        caseResult({ manualRank: 1, sectionHit: true }),
        caseResult({ manualRank: 2, sectionHit: false }),
        // 没标期望段落 —— 不该进分母
        caseResult({ manualRank: 1, sectionHit: null }),
        // 文件都没找对 —— 也不该进分母
        caseResult({ manualRank: null, sectionHit: false })
      ],
      []
    )
    expect(m.sectionAccuracy).toBeCloseTo(0.5)
  })

  it('没有标注期望段落时，段落准确给 null 而不是 0——没量过不等于零分', () => {
    const m = RecallBench.computeMetrics([caseResult({ manualRank: 1 })], [])
    expect(m.sectionAccuracy).toBeNull()
  })

  it('噪音率按发生召回的无关问题比例算', () => {
    const noise: BenchNoiseResult[] = [
      { question: '天气', recalled: false, chars: 0 },
      { question: '周报', recalled: true, chars: 120 },
      { question: '翻译', recalled: false, chars: 0 },
      { question: '订会议室', recalled: false, chars: 0 }
    ]
    const m = RecallBench.computeMetrics([caseResult({})], noise)
    expect(m.noiseRecall).toBeCloseTo(0.25)
  })

  it('空集不除零', () => {
    const m = RecallBench.computeMetrics([], [])
    expect(m.manualTop1).toBe(0)
    expect(m.autoAvgChars).toBe(0)
    expect(m.noiseRecall).toBe(0)
    expect(m.sectionAccuracy).toBeNull()
  })
})

describe('QuestionSetStore.selectCases', () => {
  const set: BenchQuestionSet = {
    name: 's',
    createdAt: '',
    corpus: [{ id: 'doc', file: 'a.md' }],
    cases: [
      { id: '1', question: 'a', expectDocId: 'doc', status: 'approved' },
      { id: '2', question: 'b', expectDocId: 'doc', status: 'candidate' },
      { id: '3', question: 'c', expectDocId: 'doc', status: 'rejected' }
    ],
    noiseQuestions: []
  }

  it('默认只跑已采纳的', () => {
    expect(QuestionSetStore.selectCases(set).map(c => c.id)).toEqual(['1'])
  })

  it('放开候选时连候选一起跑，但否决的永远不跑', () => {
    expect(QuestionSetStore.selectCases(set, true).map(c => c.id)).toEqual(['1', '2'])
  })
})

describe('QuestionSetStore.normalize', () => {
  it('缺状态的问题按候选处理——没人勾选过就不该默认进基线', () => {
    const set = QuestionSetStore.normalize(
      {
        corpus: [{ id: 'doc', file: 'a.md' }],
        cases: [{ question: '问题', expectDocId: 'doc' }]
      },
      'test.json'
    )
    expect(set.cases[0].status).toBe('candidate')
    expect(set.cases[0].id).toBe('q1')
    expect(set.noiseQuestions).toEqual([])
  })

  it('问题指向不存在的语料要当场报错，别等跑到一半', () => {
    expect(() =>
      QuestionSetStore.normalize(
        {
          corpus: [{ id: 'doc', file: 'a.md' }],
          cases: [{ question: '问题', expectDocId: '不存在的语料' }]
        },
        'test.json'
      )
    ).toThrow(/未知语料/)
  })

  it('没有语料的问题集直接拒绝', () => {
    expect(() => QuestionSetStore.normalize({ cases: [] }, 'test.json')).toThrow(/没有语料/)
  })
})

describe('QuestionGenerator.parseJsonArray', () => {
  it('解析正常数组', () => {
    expect(QuestionGenerator.parseJsonArray<{ question: string }>('[{"question":"a"}]')).toEqual([
      { question: 'a' }
    ])
  })

  it('包在代码块里也能解析', () => {
    const reply = '好的：\n```json\n[{"question":"a"},{"question":"b"}]\n```'
    expect(QuestionGenerator.parseJsonArray(reply)).toHaveLength(2)
  })

  it('数组被输出长度掐断时，把已完整的那几项捞出来', () => {
    const truncated = '[\n {"question":"第一条","expectText":"第一节"},\n {"question":"第二条","expectT'
    const items = QuestionGenerator.parseJsonArray<{ question: string }>(truncated)
    expect(items).toHaveLength(1)
    expect(items[0].question).toBe('第一条')
  })

  it('字符串数组被掐断时同样能捞', () => {
    const truncated = '[\n "帮我写周报",\n "明天天气怎'
    expect(QuestionGenerator.parseJsonArray<string>(truncated)).toEqual(['帮我写周报'])
  })

  it('一项都捞不出来时报错，并说明可能是被截断', () => {
    expect(() => QuestionGenerator.parseJsonArray('[{"question":')).toThrow(/截断/)
  })

  it('完全没有数组时报错', () => {
    expect(() => QuestionGenerator.parseJsonArray('我不太明白你的意思')).toThrow(/JSON 数组/)
  })

  it('带转义引号的项不会被当成结束', () => {
    const reply = '[{"question":"他说\\"要备份\\"吗","expectText":"第一节"}]'
    const items = QuestionGenerator.parseJsonArray<{ question: string }>(reply)
    expect(items[0].question).toBe('他说"要备份"吗')
  })
})

describe('QuestionGenerator.entryId', () => {
  it('中文文件名保留可读性', () => {
    expect(QuestionGenerator.entryId('/a/b/信息技术管理办法.pdf', 0)).toBe('信息技术管理办法-1')
  })

  it('特殊分隔符被剔除，序号保证不重名', () => {
    expect(QuestionGenerator.entryId('/a/2018┊证监会┊办法.pdf', 1)).toBe('2018证监会办法-2')
  })

  it('全是特殊字符时退回序号', () => {
    expect(QuestionGenerator.entryId('/a/┊┊.pdf', 2)).toBe('doc-3')
  })
})
