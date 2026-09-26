/**
 * 编程技能 - 工具定义与说明书
 */
import type { ToolDefinitionWithMeta } from '../../tools'

const readOnlyMeta = {
  parallelizable: true,
  phase: 'idle' as const,
}

export const codingTools: ToolDefinitionWithMeta[] = [
  {
    type: 'function',
    function: {
      name: 'code_open_project',
      description: `打开本机项目目录，开始这场编程。之后本机文件工具（read_file / edit_file / write_text_file 等）的相对路径、exec 的默认工作目录都以项目根为准。

返回：目录骨架（已跳过忽略的文件）、git 分支与未提交改动、识别到的项目类型与可用命令、项目里写给 AI 的开发约定。
换项目时再调一次。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目根目录。绝对路径，或相对当前目录' },
        },
        required: ['path'],
      },
    },
    _meta: {
      streamDisplay: { titleKey: 'coding.tool_open_project', titleField: 'path' },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_search',
      description: `在项目里按内容搜（ripgrep）。跳过项目忽略的文件（依赖目录、构建产物），不进 .git。
- pattern 默认是正则；literal=true 按原文搜
- 全小写时不分大小写；含大写时区分。case_sensitive 可强制
- glob 按文件名筛（如 "*.ts"、"src/**/*.{vue,ts}"），type 按语言筛（如 ts、py、rust、go、java）
- output：content（默认，命中的行，可带上下文）/ files（只看哪些文件命中，最近改过的在前）/ count（每个文件命中数）
- 结果有上限，超了会说明
要跑 grep / find 时用它，不要用 exec。`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜的正则（literal=true 时为原文）' },
          literal: { type: 'boolean', description: '按原文搜，不当正则' },
          case_sensitive: { type: 'boolean', description: '强制区分（true）或不区分（false）大小写' },
          glob: { type: 'string', description: '只搜匹配的文件，如 "*.ts"、"src/**/*.vue"；前面加 ! 表示排除' },
          type: { type: 'string', description: '只搜某种语言的文件，如 ts、js、py、go、rust、java、cs、cpp' },
          path: { type: 'string', description: '只搜项目里的某个子目录或文件（相对项目根）' },
          output: { type: 'string', enum: ['content', 'files', 'count'], description: '默认 content' },
          context: { type: 'number', description: 'content 模式下每处命中前后各带几行（0-10）' },
          multiline: { type: 'boolean', description: '让正则可以跨行匹配（. 也匹配换行）' },
          max_results: { type: 'number', description: 'content 为最多几处命中（默认 100），files / count 为最多几个文件（默认 200）；上限 1000' },
        },
        required: ['pattern'],
      },
    },
    _meta: {
      ...readOnlyMeta,
      streamDisplay: { titleKey: 'coding.tool_search', titleField: 'pattern' },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_find_files',
      description: `在项目里按模式找文件，跳过项目忽略的文件，最近改过的排前面。
pattern 例："*.test.ts"（任意层级）、"src/**/*.vue"、"**/Dockerfile"。`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式；不含 / 时匹配任意层级的文件名' },
          path: { type: 'string', description: '只在某个子目录里找（相对项目根）' },
          max_results: { type: 'number', description: '最多返回几个（默认 100，上限 1000）' },
        },
        required: ['pattern'],
      },
    },
    _meta: {
      ...readOnlyMeta,
      streamDisplay: { titleKey: 'coding.tool_find_files', titleField: 'pattern' },
    },
  },
]

export const codingSkillContent = `# 编程

你拿起了编程工具。按这个节奏干活：

1. **先打开项目**：\`code_open_project\` 指定项目根目录。之后相对路径、exec 的默认目录都落在项目根。打开时返回的开发约定要遵守；子目录里另有 AGENTS.md 之类的说明时，进那个目录干活前先读。
2. **找**：按内容用 \`code_search\`，按文件名 / 模式用 \`code_find_files\`。不要用 exec 跑 grep、find、ls -R。
3. **读**：\`read_file\`，大文件分段读。改哪里就先读哪里，别凭记忆改。
4. **改**：改一处用 \`edit_file\`，新文件用 \`write_text_file\`。只改任务需要的地方，不顺手重排、重命名、改格式。
5. **验**：用 exec 跑打开项目时列出的检查 / 测试命令。没跑过不要说「改好了」；跑不了就说明为什么。

## git

检查、提交都用 exec 跑 git。
- 可以查看状态和差异、提交自己的改动、新建分支。
- 推送、强推、丢弃改动（checkout -- / restore / reset --hard / clean）、删分支、改写历史之前，先问用户。
- 工作区里原本就有、不是你改的未提交改动：不要提交、不要清理、不要覆盖。
- 不改 git 配置，不跳过钩子。

## 汇报

说清改了哪些文件、为什么这么改、跑了什么验证、结果如何；还有没做完或拿不准的，直说。
`
