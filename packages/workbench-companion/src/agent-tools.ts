/**
 * 联络工作台贡献给 Agent 的专属工具（仅 __companion__ 注册，见 sailfish.getAvailableTools）。
 *
 * 信任模型（转述制）：confirm 只把用户的决定传达给任务 Agent；
 * create 的 full_auto 只在用户明确声明时使用。
 */

export const MANAGE_TASKS = 'manage_tasks'

export const COMPANION_WORKBENCH_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: MANAGE_TASKS,
      description: `管理这台电脑上所有的任务，不限联络自己创建的。

- list：任务摘要（标题、状态、待确认详情、task_id），结束不久的任务也在里面。
- inspect：某个任务最近的步骤摘要。需要 task_id。
- create：新开一场无终端的助手任务。需要 title（一句话标题）和 brief（目标、要求、必要上下文）。任务只看得到 brief，看不到这条对话，也没有这个工具。确认和做完的结果会回到这条线。没设 full_auto 时，要用户确认的操作先由独立评审员对照任务里交代过的话判断，看不准才问用户；full_auto=true 时不再询问用户，只在用户明确这样说过时使用。
- instruct：往已有任务里再交代一句。需要 task_id 和 message。任务在跑时当场送进；已经停了或只在历史里时，仍是原来那场接着做。message 只有那场任务看得到。远程终端的窗口已经关掉时送不进去。
- confirm：把用户对待确认操作的批准或拒绝传到任务。需要 task_id、tool_call_id（确认通知和 list 里都有）、approve。批不批由用户决定。
- stop：停止正在执行的任务，会话保留。需要 task_id。`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'inspect', 'create', 'instruct', 'confirm', 'stop'],
            description: '要执行的操作'
          },
          task_id: {
            type: 'string',
            description: '目标任务 ID（inspect/instruct/confirm/stop 必填，list 里有）'
          },
          tool_call_id: {
            type: 'string',
            description: '待确认的工具调用 ID（confirm 必填）'
          },
          approve: {
            type: 'boolean',
            description: 'confirm 专用：true=用户批准，false=用户拒绝'
          },
          title: {
            type: 'string',
            description: 'create 专用：一句话任务标题'
          },
          brief: {
            type: 'string',
            description: 'create 专用：任务简报（目标、要求、必要上下文）'
          },
          full_auto: {
            type: 'boolean',
            description: 'create 专用：全自动执行（仅用户显式声明时才为 true）'
          },
          message: {
            type: 'string',
            description: 'instruct 专用：再交代的这一句（只给这场任务看）'
          }
        },
        required: ['action']
      }
    },
    _meta: {
      streamDisplay: { titleKey: 'taskmgr.step', progressFields: ['brief'] }
    }
  }
]
