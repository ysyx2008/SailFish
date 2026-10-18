import { describe, expect, it } from 'vitest'
import { memoryTopics } from '../memory-topics'

describe('memoryTopics', () => {
  it('有二级标题时，一级总标题不算主题', () => {
    expect(memoryTopics('# 用户\n\n## 身份与职责\n运维\n\n## 偏好与约定\n简短')).toEqual(['身份与职责', '偏好与约定'])
  })

  it('只有一级标题时用一级', () => {
    expect(memoryTopics('# 磁盘\nnvme\n# 网络\n内网')).toEqual(['磁盘', '网络'])
  })

  it('代码块里的井号不是标题', () => {
    expect(memoryTopics('## 脚本\n```\n# 注释\n```\n## 端口\n8080')).toEqual(['脚本', '端口'])
  })

  it('没有标题返回空；最多取前几个', () => {
    expect(memoryTopics('随手记的一句话')).toEqual([])
    expect(memoryTopics('## a\n## b\n## c', 2)).toEqual(['a', 'b'])
  })

  it('标题末尾紧贴的井号是文字的一部分', () => {
    expect(memoryTopics('## C#\n## F#')).toEqual(['C#', 'F#'])
  })

  it('混着更深层级时，只取最浅的那一层', () => {
    expect(memoryTopics('# 总\n## 甲\n### 甲一\n### 甲二\n## 乙')).toEqual(['甲', '乙'])
  })
})
