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
      description: `打开本机项目目录，开始这场编程。之后本机文件工具（read_file / edit_file / write_text_file 等）的相对路径、exec 的默认工作目录都以项目根为准；终端窗格里的命令（execute_command）不受影响。

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
要跑 grep / find 时用它，不要自己跑命令。`,
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
  {
    type: 'function',
    function: {
      name: 'code_multi_edit',
      description: `在同一个本地文件里一次做多处查找替换。按顺序应用：后一处看到的是前面几处改完之后的内容。
全部对得上才写入；任何一处找不到或匹配多处，整次不改，并说明是第几处。
每处的 old_text 规则同 edit_file：先 read_file，从输出里精确复制，要在文件里唯一（或给这一处设 replace_all）。
新文件用 write_text_file。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地文件路径（绝对路径，或相对项目根）' },
          edits: {
            type: 'array',
            description: '按顺序应用的修改',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', description: '要替换的原文，须与文件内容完全一致' },
                new_text: { type: 'string', description: '替换后的文本' },
                replace_all: { type: 'boolean', description: '替换这段原文的所有出现（默认 false）' },
              },
              required: ['old_text', 'new_text'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    _meta: {
      phase: 'writing_file',
      idempotencyKey: ['path'],
      streamDisplay: { titleKey: 'coding.tool_multi_edit', titleField: 'path' },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_rewind',
      description: `把项目退回之前的检查点。打开项目时、之后每轮开始时都会自动给项目留一个检查点（存在旗鱼自己的数据目录，不碰项目的 git）。
- action=list：列出最近的检查点，新的在前，标出是不是这场对话留的、之后改了几个文件
- action=restore：退回。给 checkpoint 就退到那一个；不给就退到最近一个和现在内容不一样的轮次检查点（通常就是「上一轮开始前」；已经被退回撤掉的不算，所以连撤几次会一步步往前退）
退回会把改过、删掉的文件改回去，把后来新建的删掉（用命令改的也算）；项目忽略的文件和嵌套仓库不动。退回前先把当前状态也留一个检查点，退错了可以再 restore 它。
只在用户要求撤销时用；要撤销哪一轮拿不准时先 list。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'restore'], description: 'list 看检查点；restore 退回' },
          checkpoint: { type: 'string', description: 'restore 时要退到的检查点编号（list 里的那串）；不给就退到上一轮开始前' },
        },
        required: ['action'],
      },
    },
    _meta: {
      allowedForSubAgent: false,
      parallelizable: false,
      streamDisplay: { titleKey: 'coding.tool_rewind', titleField: 'action' },
    },
  },
]

export const codingSkillContent = `# 编程

你拿起了编程工具。按这个节奏干活：

1. **先打开项目**：\`code_open_project\` 指定项目根目录。之后本机文件工具的相对路径、exec 的默认目录都落在项目根（终端窗格里的命令除外）。打开时返回的开发约定要遵守；子目录里另有 AGENTS.md 之类的说明时，进那个目录干活前先读。
2. **找**：按内容用 \`code_search\`，按文件名 / 模式用 \`code_find_files\`。不要自己跑 grep、find、ls -R。
3. **读**：\`read_file\`，大文件分段读。改哪里就先读哪里，别凭记忆改。
4. **改**：改一处用 \`edit_file\`；同一个文件要改好几处，用 \`code_multi_edit\` 一次改完；新文件用 \`write_text_file\`。只改任务需要的地方，不顺手重排、重命名、改格式。改完如果结果里提示「可能多了语法错误」，先读那几行确认，是真错就立刻修。
5. **验**：跑打开项目时列出的检查 / 测试命令。有 exec 就用 exec，默认就在项目根；只能在终端窗格里跑（execute_command）时，窗格的目录不会跟着项目变，先 cd 到项目根。看退出码判断成败。没跑过不要说「改好了」；跑不了就说明为什么。

## 撤回

每轮开始前会自动给项目留检查点。用户说「刚才那轮撤掉 / 改回去」时用 \`code_rewind\`，不要自己用 git checkout 或手工改回。退回后告诉用户退到了哪个时候、动了哪些文件。

## git

查看、提交都直接跑 git 命令（exec 或终端窗格）。
- 可以查看状态和差异、提交自己的改动、新建分支。
- 推送、强推、丢弃改动（checkout -- / restore / reset --hard / clean）、删分支、改写历史之前，先问用户。
- 工作区里原本就有、不是你改的未提交改动：不要提交、不要清理、不要覆盖。
- 不改 git 配置，不跳过钩子。

## 汇报

说清改了哪些文件、为什么这么改、跑了什么验证、结果如何；还有没做完或拿不准的，直说。
`
