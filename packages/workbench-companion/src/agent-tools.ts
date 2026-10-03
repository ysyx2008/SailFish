/**
 * 联络工作台贡献给 Agent 的专属工具（仅 __companion__ 注册，见 sailfish.getAvailableTools）。
 *
 * 信任模型（转述制）：confirm 只把用户的明确决定传达给任务 Agent，工具描述里
 * 写死「绝不自行批准」；create 的 full_auto 仅接受用户显式声明。
 */

export const MANAGE_TASKS = 'manage_tasks'

export const COMPANION_WORKBENCH_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: MANAGE_TASKS,
      description: `【任务管理】查看和管理任务 Agent（查看列表/近况、创建、停止、传达确认决定）。

action 说明：
- list：列出当前所有任务的摘要（标题、状态、待确认详情、task_id）。
- inspect：查看单个任务的最近步骤摘要。需要 task_id。
- create：创建新任务（无终端助手形态）。需要 title（一句话任务标题）和 brief（任务简报：目标、要求、必要上下文，将作为任务收到的指令）。
  brief 是任务 Agent 唯一可见的上下文——写清要做什么、做到什么程度算完成；**不要在 brief 里引用 manage_tasks 或联络线里的对话**（任务侧没有这个工具，也看不到你的对话），任务管理由你负责。
  用户还在这条对话里。确认和复命会由系统自动回到这条线。
  未设置 full_auto 时，危险操作先由独立评审员对照这场任务里交代的话决定放不放，看不准再问用户。
  full_auto=true 表示全自动执行（危险操作也不再逐条确认）——**仅当用户明确说"全自动/不用问我/直接跑"时才可设置**。
- confirm：把用户对危险操作的批准/拒绝传达给正在等待确认的任务。需要 task_id 和 tool_call_id（从确认通知或 list 输出中获取），approve=true 批准 / false 拒绝。
  **只传达用户的明确决定，绝不自行批准。**
- stop：停止执行中的任务（不删除会话）。需要 task_id。仅在用户明确要求停止时使用。

典型流程：用户要求做事 → create 创建任务 → 任务完成或需要确认时系统会通知 → 用户表态后用 confirm 传达。`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'inspect', 'create', 'confirm', 'stop'],
            description: '要执行的操作'
          },
          task_id: {
            type: 'string',
            description: '目标任务 ID（inspect/confirm/stop 必填，从 list 输出获取）'
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
