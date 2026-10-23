/**
 * Word 技能模块
 * 提供会话式 Word 文档创建和编辑能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { wordTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WordSkill')

const wordSkill: Skill = {
  id: 'word',
  name: 'Word 文档处理',
  description: 'Word 文档创建和编辑，支持段落/标题/列表/表格/样式管理。',
  tools: wordTools,
  content: [
    '## Word 文档格式转换指引',
    '',
    '> **生成整篇 Word 强烈推荐用 `word_from_markdown`**（一次调用完成，效率远远高于逐段 `word_add`）。',
    '',
    '> **写中文材料前先按需加载关联技能**：',
    '> - 任何中文文本（公文、报告、合同、邮件、消息）→ `load_skill("chinese-writing")`（GB/T 15834 标点 + GB/T 15835 数字 + 中英文混排空格规则）',
    '> - 公文 / 通知 / 请示 / 报告 / 批复 / 函 / 纪要 / 证券公文 / 会议纪要 → `load_skill("chinese-document-official")`（GB/T 9704-2012 公文体例 + 启用 official/securities/meeting 样式预设）',
    '> - 企业管理办法 / 规章制度 / 内控规程等制度文件 → `load_skill("chinese-document-regulation")`（章/节/条/款/项编号体系 + 启用 regulation 样式预设）',
    '>',
    '> 本技能只覆盖 Word 工具用法（front matter / 图片嵌入 / 水平线避坑等）和通用样式（simple / formal / tech / academic）。中文写作规范、公文体例、制度体例分别由上述独立技能承载。',
    '',
    '### 用户只扔「格式规范」时（Agent 自动处理，勿让用户背工具名）',
    '用户通常只会说：「按附件格式写一份 Word」「照着这个版式生成 docx」——**不要**要求用户说 load_skill / word_create_style。',
    '',
    '**标准流程（同一轮对话内静默完成）**：',
    '1. 用户附了 .docx/.wps/.pdf/.txt 格式说明或排版样板 → 读取内容',
    '2. 若尚无匹配自定义样式：`word_create_style` 注册一次（样式名用简短英文或拼音，如 `user-format-党委议案`）',
    '   - 样板里已有 Normal/Title/Heading 等真实段落样式 → `from_template`',
    '   - 仅是文字版式说明（如「正文仿宋三号」）→ 整理为 `config`（可 `base: "official"`），**同一次调用带 config 保存**，不要只调 `from_description` 就结束',
    '3. 用 `word_from_markdown({ style: 刚注册的样式名, ... })` 生成正文；**禁止** `word_add` 逐段设字体',
    '4. 同一会话后续文档：先 `word_list_styles`，有则直接用，勿重复注册',
    '',
    '中文材料同时加载 `chinese-writing`；接近国标公文时加载 `chinese-document-official`。',
    '',
    '### 文档标题 vs 章节标题',
    'Word 中"文档标题"（Title 样式）和"一级标题"（Heading 1）是两种不同的样式。Markdown 没有文档标题的概念，因此用 YAML front matter 来指定：',
    '',
    '```',
    '---',
    'title: 关于加强安全生产工作的通知',
    '---',
    '',
    '正文内容...',
    '```',
    '',
    'front matter 中的 title 会渲染为 Word 的 Title 样式（公文格式中为小标宋体二号居中）。',
    'Markdown 的 # 仍然映射为 Heading 1，## 映射为 Heading 2，以此类推，不受影响。',
    '没有 front matter 时行为不变（向后兼容）。',
    '',
    '⚠️ **文档标题：只用 front matter，正文里不得出现 `title:` 字样**',
    '- ✅ 唯一正确写法：文档最开头 `---` 围栏 + `title: 标题全文` + `---`（见上例）；Word 正文只显示标题文字，不显示 `title:`',
    '- ❌ 正文段落写 `title: xxx` 或 `**title:** xxx`',
    '- ❌ 用 `#` / `##` 写标题（含 `## title: xxx`）——那是章节 Heading，不是公文 Title',
    '主送机关、落款用 HTML：`<p>公司党委：</p>`、`<p align="right">金融科技部</p>`、`<p align="right">二〇二六年五月二十一日</p>`。',
    '注意：除了 front matter 元数据区域外，正文中不要再出现孤立的 `---`（见下文"不要用 `---` 当章节分隔"）。',
    '',
    '### ⚠️ 图片嵌入：路径必须用 `<>` 包裹（最容易踩的坑）',
    '',
    '`word_from_markdown` 是**唯一**能嵌入图片的工具，用 `![alt](destination)` 语法。按 CommonMark 0.31 §6.3（Links 的 link destination 语法，§6.4 Images 沿用）：',
    '',
    '- **destination 含空格、`<`、`>` 或 ASCII 控制字符 → 必须用 `<...>` 包裹**，否则解析失败，整段 `![alt](path)` 会变成 Word 里的字面量文字，**看不到图片**。',
    '- 含 `(` `)` 也建议用 `<...>` 包裹（避免与图片语法的闭合括号歧义，如 macOS Finder 副本命名 `foo (1).png`）。',
    '- macOS 路径几乎必含 `Library/Application Support/...` 等带空格目录，所以**绝对路径一律包 `<>`** 是最稳的写法。',
    '',
    '**示例**：',
    '',
    '```',
    '✅ ![布局总览](</Users/me/Library/Application Support/SFTerm/charts/x.png>)',
    '✅ ![副本](<./report (1).png>)',
    '✅ ![描述](<path with space.png> "640x480")        ← title 槽用来传尺寸',
    '✅ ![布局总览](/var/charts/x.png)                    ← 路径无空格无特殊字符，可不包',
    '❌ ![布局总览](/Users/me/Library/Application Support/SFTerm/charts/x.png)  ← 裸路径含空格，整段当文字',
    '```',
    '',
    '**尺寸**（单位像素，默认 480×360 ≈ A4 半页宽）：`![desc|640x480](<path>)` 或 `![desc](<path> "640x480")`',
    '',
    '⚠️ **不要按图片源分辨率填尺寸**——很多 AI 看到 ImageMagick `-density 300` 转出来的 PNG 是 2400×1800 就习惯性写 `|2400x1800`，会撑爆 A4 版面。系统已自动按当前样式的页面正文宽度做硬上限（A4 默认 ≈ 601px、公文样式 ≈ 589px），超出会等比缩，但**最佳实践是直接不写尺寸**（用默认 480×360）或写一个合理值（≤ 600）。需要更精细控制时记得：**像素宽度 ≠ 图片源分辨率**，按"想让图片在 A4 上占多宽"换算（半页宽 ≈ 300px、3/4 页宽 ≈ 450px、近满宽 ≈ 580px）。',
    '',
    '**其他约束**：',
    '- 路径解析以 markdown 文件所在目录为基准；建议直接给绝对路径避免歧义',
    '- 支持 PNG / JPG / JPEG / GIF / BMP；**不支持 SVG**',
    '- ⚠️ **chart 技能产的图要嵌入 Word，请直接调 `generate_chart` 时传 `format: "png"`** 拿到 PNG 落盘——服务端用 sharp 转，中文字体走系统 PingFang SC / 微软雅黑，效果跟前端一致。**不要**先生成 SVG 再用 `convert / sips / rsvg-convert` 等系统命令转 PNG，那会丢中文字体',
    '- 仅 `word_from_markdown` 解析 `![](path)` 嵌图；`word_modify_paragraph` / `word_replace` / `word_add(text)` 拿到 `![](path)` 只会写成字面量。要往已存在文档加图请用 `word_from_markdown` **重写整篇 markdown**',
    '',
    '### 不要用 `---` 当章节分隔（重要）',
    'Markdown 的 `---` 会渲染成水平分割线。**公文、报告、合同等正式文档中不要用它做章节之间的视觉分隔**，否则会输出莫名其妙的横线。',
    '- 公文类样式（official / securities / regulation / meeting）已默认抑制 `---` 渲染，写了也不会出现，但仍建议彻底删掉避免混淆。',
    '- 章节切换请用 `#` / `##` 标题、空行、或公文编号（一、二、（一）（二）等），不要靠水平线。',
    '- 真正需要分页时使用专用的分页符工具（word_add 的 page_break 类型），而不是 `---`。',
    '',
    '不允许用行尾两个空格换行，会造成排版问题。',
  ].join('\n'),
  
  async init() {
    // docx 库会在执行时动态 import，这里不需要预加载
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的 Word 文档
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
registerSkill(wordSkill)

export { wordSkill }
