import { describe, it, expect } from 'vitest'
import { mergeMemoryPatch, parseMemoryBlocks } from '../memory-patch'

const personal = `# 用户知识文档

## 用户身份
- 姓名：于申
- 常驻合肥

## 交流偏好
- 简洁直接
`

const host = `## 本地主机知识文档

### 硬件配置
- CPU: M4 Max

### 网络
- 网关 172.29.12.254
`

describe('mergeMemoryPatch', () => {
  it('同标题整段替换，别的段原样保留', () => {
    const merged = mergeMemoryPatch(personal, '## 交流偏好\n他希望回复简短，只讲重点。\n')
    expect(merged).toContain('他希望回复简短，只讲重点。')
    expect(merged).not.toContain('简洁直接')
    expect(merged).toContain('- 姓名：于申')
    expect(merged!.startsWith('# 用户知识文档')).toBe(true)
  })

  it('新标题接在末尾，用文档自己的那级标题', () => {
    const merged = mergeMemoryPatch(host, '## 软件环境\n- Node 22\n')
    expect(merged).toContain('### 软件环境\n- Node 22')
    expect(merged!.indexOf('### 软件环境')).toBeGreaterThan(merged!.indexOf('### 网络'))
  })

  it('标题下只写删除标记 = 删掉那段', () => {
    const merged = mergeMemoryPatch(host, '### 网络\n（删除）\n')
    expect(merged).not.toContain('网络')
    expect(merged).not.toContain('172.29.12.254')
    expect(merged).toContain('### 硬件配置')
  })

  it('只有标题、正文空着：多半没写完，不删', () => {
    const merged = mergeMemoryPatch(host, '### 网络\n')
    expect(merged).toContain('172.29.12.254')
  })

  it('删除标记对不存在的段：什么也不加', () => {
    const merged = mergeMemoryPatch(host, '### 不存在\n（删除）\n')
    expect(merged).not.toContain('不存在')
  })

  it('一次交多段：替换、新增、删除各自生效', () => {
    const merged = mergeMemoryPatch(personal, [
      '## 用户身份',
      '于申在国元证券金融科技部任经理助理，常驻合肥。',
      '',
      '## 家庭',
      '有两个女儿。',
      '',
      '## 交流偏好',
      '（删除）',
    ].join('\n'))
    expect(merged).toContain('于申在国元证券金融科技部任经理助理')
    expect(merged).not.toContain('- 姓名：于申')
    expect(merged).toContain('## 家庭\n有两个女儿。')
    expect(merged).not.toContain('交流偏好')
  })

  it('段内的下级标题跟着整段走', () => {
    const doc = '## A\n### a1\nx\n## B\ny\n'
    const merged = mergeMemoryPatch(doc, '## A\nz\n')
    expect(merged).toBe('## A\nz\n\n## B\ny\n')
  })

  it('代码块里的井号行不当标题', () => {
    const doc = '## 脚本\n```bash\n# 注释\necho hi\n```\n## 其它\nq\n'
    const merged = mergeMemoryPatch(doc, '## 其它\nw\n')
    expect(merged).toContain('# 注释')
    expect(merged).toContain('## 其它\nw')
  })

  it('空文档：交来的就是整份', () => {
    expect(mergeMemoryPatch('', '## 偏好\n简洁\n')).toBe('## 偏好\n简洁\n')
  })

  it('非空文档却没有标题：无法落脚，返回 null', () => {
    expect(mergeMemoryPatch(personal, '他喜欢简洁')).toBeNull()
  })

  it('标题空白差异不影响匹配', () => {
    const merged = mergeMemoryPatch(personal, '##   交流偏好  \n新的\n')
    expect(merged).toContain('## 交流偏好\n新的')
    expect(merged!.match(/交流偏好/g)).toHaveLength(1)
  })
})

describe('parseMemoryBlocks', () => {
  it('取出各份改动', () => {
    const blocks = parseMemoryBlocks('<memory id="personal">\n## 偏好\n简洁\n</memory>\n<memory id="root@prod">\n## 服务\nnginx\n</memory>')
    expect([...blocks.keys()]).toEqual(['personal', 'root@prod'])
    expect(blocks.get('root@prod')).toContain('nginx')
  })

  it('被截断、没收尾的那份不算', () => {
    const blocks = parseMemoryBlocks('<memory id="personal">\n## 偏好\n简洁\n</memory>\n<memory id="local">\n## 硬件\nCPU')
    expect([...blocks.keys()]).toEqual(['personal'])
  })

  it('单引号、不带引号的 id 也认', () => {
    const blocks = parseMemoryBlocks("<memory id='personal'>\n## a\nb\n</memory><memory id=local>\n## c\nd\n</memory>")
    expect([...blocks.keys()]).toEqual(['personal', 'local'])
  })

  it('NO_CHANGE 没有任何块', () => {
    expect(parseMemoryBlocks('NO_CHANGE').size).toBe(0)
  })
})
