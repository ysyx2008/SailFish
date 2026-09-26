/**
 * assistant 工作台贡献给 Agent 的内置工具（由 getAgentTools assistant 模式注册）
 */

export const LIST_WORKBENCH_ARTIFACTS = 'list_workbench_artifacts'
export const MANAGE_WORKBENCH_ARTIFACTS = 'manage_workbench_artifacts'

export const ASSISTANT_WORKBENCH_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: LIST_WORKBENCH_ARTIFACTS,
      description: `查询当前这场对话画布上文件类产出物的**实时状态**。

返回 panelVisible（文件是否在座位上展开）、artifacts（文件列表：title / renderer / filePath）、activeArtifactId。

调用时会先与磁盘同步（移除 filePath 已不存在的项），再返回快照。chart 不会出现在 artifacts 里。终端不在这份列表里。向用户描述「桌上现在有什么文件」前应优先调用本工具，勿凭推断作答。`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    _meta: {
      supportedModes: ['assistant'],
      parallelizable: true,
      allowedForSubAgent: false,
      streamDisplay: { titleKey: 'workbench.list_artifacts' }
    }
  },
  {
    type: 'function',
    function: {
      name: MANAGE_WORKBENCH_ARTIFACTS,
      description: `维护这场对话画布上的文件/网页：把已有本地文件或某个 URL 请到座位上预览，或从画布拿走。

正在看终端时调用 action=open，等于明确请这份文件入座（终端让座，还活着）。只是写出新文件、用户还在看终端时，不要用本工具抢座位。

用途：用户想重新打开某文件、把之前的结果再摊开、实时预览你启动的本地开发服务（dev server），或清理画布上的文件时。

action='open'（二选一）：
- path：打开本地文件到面板。支持 Markdown / HTML / Word（.docx、WPS 文字）/ Excel（.xlsx、WPS 表格）。PPT、PDF、图片等类型面板暂不支持预览，如需查看请提示用户用系统程序打开，或用 exec 调命令行工具处理。
- url：在面板的内置浏览器中实时预览该地址（仅 http/https）。典型场景：你启动 dev server 后让用户实时看到效果；用户可在地址栏继续导航。
action='close'：按 path 或 url 从面板移除对应产出物。

path 建议传绝对路径（相对路径按当前工作目录解析）。`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'close'],
            description: '打开到面板 或 从面板关闭'
          },
          path: {
            type: 'string',
            description: '本地文件绝对路径（相对路径按 cwd 解析）；与 url 二选一'
          },
          url: {
            type: 'string',
            description: 'http/https 地址，在内置浏览器中实时预览；与 path 二选一'
          },
          title: {
            type: 'string',
            description: '可选，面板 tab 显示标题，默认用文件名或 URL'
          }
        },
        required: ['action']
      }
    },
    _meta: {
      supportedModes: ['assistant'],
      allowedForSubAgent: false,
      streamDisplay: { titleKey: 'workbench.manage_artifacts' }
    }
  }
] as const
