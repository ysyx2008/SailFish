// 首次设置向导
export default {

  // 首次设置向导
  setup: {
    welcome: {
      title: '欢迎使用旗鱼',
      subtitle: 'AI 驱动的智能助手，让工作更高效',
      intro: '旗鱼是一款集成了强大 AI 能力的智能助手，能帮助您高效完成各类任务。通过简单的引导，我们将帮助您完成初始配置，快速开始使用。',
      features: {
        aiChat: {
          title: 'AI 对话助手',
          desc: '在终端中直接与 AI 对话，询问命令用法、排查问题、获取帮助。支持多种大模型，包括 OpenAI、通义千问、DeepSeek 等，也支持本地部署的 Ollama。'
        },
        agent: {
          title: '助手自动执行',
          desc: 'AI 助手可以理解您的自然语言指令，自动执行复杂的运维任务。支持命令执行、文件操作、系统监控等，让 AI 成为您的得力助手。'
        },
        ssh: {
          title: 'SSH 会话管理',
          desc: '统一管理多台服务器，支持分组、跳板机、快速连接。可以一键导入 Xshell 会话配置，快速迁移现有环境。'
        },
        knowledge: {
          title: '本地知识库',
          desc: '上传文档到本地知识库，AI 对话时自动检索相关内容，提供更精准的答案。支持 PDF、Word、文本等多种格式，使用轻量级向量模型，无需额外下载。'
        }
      },
      skipWizard: '跳过引导'
    },
    aiConfig: {
      title: '配置大模型',
      subtitle: '配置大语言模型，让终端更智能',
      subtitleSimple: '选择一个 AI 服务，填写 API Key 即可开始',
      intro: '大模型是 AI 功能的核心，您需要配置至少一个模型才能使用 AI 对话和助手功能。',
      hint: '支持 OpenAI 兼容接口，包括 vLLM、FastChat、Ollama 等私有化部署方案。',
      modelRecommendation: '',
      configuredModels: '已配置的模型',
      addNewModel: '添加新模型',
      quickTemplates: '快速模板：',
      fillRequired: '请填写完整的配置信息',
      saveFailed: '保存失败',
      required: '请先配置至少一个 AI 模型才能继续',
      oemNeedLogin: '公司的模型要登录之后才会放进来。可以先继续，登录后不用再填地址和模型名。',
      oemUnavailable: '还没取到公司的模型清单。可以先继续，稍后再打开就会再取一次；也可以在下面自己配一个。',
      alreadyConfigured: '已配置：{name}',
      configured: '已配置',
      enterApiKey: '请输入 API Key',
      apiKeyRequired: '请填写 API Key',
      localNoKey: '本地服务无需 API Key，确保 Ollama 已启动即可',
      useThis: '使用此模型',
      canChangeLater: '稍后可在设置中添加更多模型或修改配置',
      customNamePlaceholder: '如：内网 GPT',
      customUrlPlaceholder: '如：http://192.168.1.100:8000/v1/chat/completions',
      customKeyPlaceholder: '如无需验证可留空',
      customModelPlaceholder: '如：gpt-5.6'
    },
    import: {
      title: '导入 SSH 主机',
      subtitle: '快速导入已有的 SSH 主机配置',
      shortDesc: '从 Xshell 导入主机配置',
      intro: '如果您之前使用 Xshell，可以一键导入所有会话配置，快速迁移到旗鱼。',
      scanning: '正在扫描 Xshell 会话目录...',
      scanNow: '扫描 Xshell 配置',
      found: '找到 {count} 个会话',
      import: '一键导入',
      importing: '导入中...',
      imported: '已导入',
      importSuccess: '成功导入 {count} 个主机',
      importFailed: '导入失败',
      manualSelect: '手动选择目录',
      notFound: '未找到 Xshell 会话目录',
      notFoundHint: '您可以手动选择目录导入，或稍后在设置中添加主机'
    },
    knowledge: {
      title: '本地知识库',
      subtitle: '启用本地知识库，让 AI 更懂你的文档和操作习惯',
      shortDesc: '让 AI 更懂你的文档和操作习惯',
      features: {
        title: '知识库功能',
        item1: '上传文档到本地知识库，支持 PDF、Word、文本等多种格式',
        item2: '自动记录主机操作记忆，AI 能学习您的使用习惯和偏好',
        item3: 'AI 对话时自动检索相关内容，提供更精准的答案',
        item4: '数据加密存储，保护您的敏感信息安全'
      },
      enableSwitch: '启用知识库',
      enableHint: '开启后可存储文档和主机记忆，让助手更智能地协助您',
      passwordIntro: '知识库可存储文档和主机记忆等敏感信息，请设置密码以加密保护这些数据。',
      passwordLabel: '设置密码',
      passwordPlaceholder: '请输入密码（至少 4 位）',
      confirmPasswordLabel: '确认密码',
      confirmPasswordPlaceholder: '请再次输入密码',
      passwordMinLength: '密码长度至少为 4 位',
      passwordMismatch: '两次输入的密码不一致',
      saveFailed: '保存失败'
    },
    mcp: {
      title: 'MCP 连接器',
      subtitle: '连接 MCP 连接器，扩展 AI 能力',
      shortDesc: '扩展 AI 能力（高级用户）',
      intro: 'MCP (Model Context Protocol) 是一种协议，允许 AI 访问外部工具和资源。',
      hint: '您可以稍后在设置中添加 MCP 连接器，现在可以跳过此步骤。',
      configuredServers: '已配置的 MCP 连接器',
      noServers: '尚未配置 MCP 连接器',
      noServersHint: '可在设置中添加 MCP 连接器',
      servers: '个连接器'
    },
    complete: {
      title: '一切就绪！',
      subtitle: '开始使用旗鱼吧',
      readyToUse: 'AI 模型已配置完成，可以开始使用了',
      aiReady: 'AI 功能已就绪',
      aiReadyDesc: '您已配置好大模型，现在可以开始使用 AI 对话和助手功能了。',
      steamReady: '准备就绪',
      steamReadyDesc: 'Steam 版本提供终端、SSH 与文件管理功能，可直接开始使用。',
      optionalConfig: '可选配置',
      optionalHint: '以下功能可稍后在设置中配置，您也可以现在快速设置',
      summary: {
        aiConfigured: '大模型已配置',
        aiNotConfigured: '大模型未配置',
        hostsImported: '已导入 {count} 个主机',
        knowledgeEnabled: '知识库已启用',
        knowledgeNotEnabled: '知识库未启用',
        mcpConfigured: 'MCP 连接器已配置',
        mcpNotConfigured: 'MCP 连接器未配置'
      },
      tip: '您可以在设置中随时修改这些配置'
    },
    aiGuide: {
      title: 'AI 助手',
      placeholder: '有问题可以问我...',
      thinking: '思考中...'
    }
  },
}
