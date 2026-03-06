// 支持的语言列表
export const supportedLanguages = ['zh', 'en'] as const;
export type SupportedLanguage = typeof supportedLanguages[number];

// 默认语言
export const defaultLanguage: SupportedLanguage = 'en';

// 语言显示名称
export const languageNames: Record<SupportedLanguage, string> = {
  zh: '中文',
  en: 'English',
};

export const translations = {
  zh: {
    nav: {
      features: '功能特性',
      download: '下载',
      stats: '统计',
      changelog: '更新日志',
      skills: '技能市场',
      guide: '指南',
      github: 'GitHub',
      cta: '立即下载',
    },
    hero: {
      versionLabel: '最新版本',
      titleHighlight: 'AI 驱动',
      titleSuffix: '的智能助手',
      subtitle: '说出你的需求，AI 自主规划执行。',
      subtitleLine2: '通过桌面端、飞书、钉钉、企业微信、Slack、Telegram 或 Web 随时与 Agent 对话，让 AI 帮你搞定一切。',
      downloadBtn: '立即下载',
      viewSourceBtn: '查看源码',
      apiNotice: '本软件不内置大模型，需自行配置 API',
      platforms: {
        macOS: 'macOS',
        Windows: 'Windows',
        Linux: 'Linux',
      },
      screenshot: {
        production: '🖥️ 生产服务器',
        test: '📦 测试环境',
        dev: '🔧 开发机',
        aiAssistant: 'AI 助手',
        aiMessage: '磁盘使用率 45%，状态良好。建议定期清理日志文件以释放空间。',
      },
    },
    features: {
      title: '强大功能，智能高效',
      subtitle: '不只是终端，更是你的 AI Agent —— 能执行命令、管理文件、收发邮件、浏览网页，无所不能',
      items: [
        {
          title: 'AI Agent 自主执行',
          description: '描述你的需求，Agent 自动拆解任务、规划步骤、调用工具并逐步执行。支持多种大模型，内置风险评估与人工确认机制，安全可控。',
          highlights: ['自主规划与执行', '多模型支持', '风险评估与确认'],
        },
        {
          title: '多通道接入',
          description: '不止于桌面端——通过飞书、钉钉、企业微信、Slack、Telegram 机器人或 Web 远程页面随时与 Agent 对话，在手机上也能远程管理服务器、执行任务。',
          highlights: ['飞书 / 钉钉 / 企业微信', 'Slack / Telegram', 'Web 远程访问'],
        },
        {
          title: '丰富的 Agent 技能',
          description: '开箱即用的技能扩展：浏览器自动化、邮件收发、日程管理、Excel/Word 样式主题处理，让 AI 的能力远不止命令行。觉醒模式下 AI 主动监控、推送通知。',
          highlights: ['觉醒模式 & 传感器', '邮件 / 日程管理', 'Excel / Word 处理'],
        },
        {
          title: '本地知识库',
          description: '导入文档构建离线 RAG 系统，自动记忆主机配置与历史操作。所有数据本地存储，完全离线运行。',
          highlights: ['离线 Embedding', '主机画像记忆', '文档问答'],
        },
        {
          title: 'MCP 生态扩展',
          description: '支持 Model Context Protocol 标准，一键接入数据库、API、文件系统等外部工具，无限扩展 Agent 能力边界。',
          highlights: ['stdio / SSE 传输', '预设模板', '可视化管理'],
        },
        {
          title: '终端与服务器管理',
          description: '内置专业终端和 SSH 客户端，支持 SFTP 可视化文件管理、批量服务器操作、Xshell 会话导入，满足运维刚需。',
          highlights: ['SSH / SFTP', '批量操作', '企业级安全'],
        },
      ],
    },
    useCases: {
      title: '适用场景',
      subtitle: '无论你是 AI 从业者、运维工程师还是普通用户，旗鱼都能成为你的得力助手',
      items: [
        {
          role: 'AI 从业者',
          icon: 'ai',
          description: 'GPU 服务器管理与模型训练的最佳搭档',
          scenarios: [
            'GPU 状态监控与资源管理',
            '模型训练任务部署与调试',
            'CUDA / PyTorch 环境配置',
            '训练日志分析与错误排查',
          ],
        },
        {
          role: '运维工程师',
          icon: 'server',
          description: '高效管理多台服务器，AI 协助故障排查',
          scenarios: [
            '批量服务器巡检与状态监控',
            '日志分析与异常定位',
            '自动化运维脚本生成',
            '磁盘、内存、CPU 问题诊断',
          ],
        },
        {
          role: '开发人员',
          icon: 'code',
          description: '提升开发效率，让 AI 成为你的编程助手',
          scenarios: [
            'Git 操作与代码部署',
            '开发环境配置与调试',
            'Docker 容器管理',
            'API 调试与测试',
          ],
        },
        {
          role: '数据库管理员',
          icon: 'database',
          description: '数据库运维更轻松，AI 助力性能优化',
          scenarios: [
            '数据库备份与恢复',
            'SQL 性能分析与优化',
            '主从同步状态检查',
            '慢查询定位与处理',
          ],
        },
        {
          role: '安全工程师',
          icon: 'shield',
          description: '安全审计与漏洞排查的得力助手',
          scenarios: [
            '系统安全基线检查',
            '入侵痕迹分析',
            '权限与访问审计',
            '安全日志分析',
          ],
        },
        {
          role: 'Linux 学习者',
          icon: 'book',
          description: '边学边练，AI 实时解答命令疑问',
          scenarios: [
            '命令语法学习与解释',
            '系统管理基础练习',
            'Shell 脚本编写指导',
            '配置文件理解与修改',
          ],
        },
      ],
    },
    download: {
      title: '立即下载',
      subtitle: '免费使用，开源共建。选择适合你系统的版本开始体验',
      platforms: {
        macOS: {
          name: 'macOS',
          description: '支持 macOS 10.15+',
          variants: {
            appleSilicon: 'Apple Silicon',
            intel: 'Intel',
          },
        },
        Windows: {
          name: 'Windows',
          description: '支持 Win 10/11, Server 2016+',
          variants: {
            installer64: '64 位安装包',
          },
        },
        Linux: {
          name: 'Linux',
          description: '支持主流 Linux 发行版',
          variants: {
            appImage: 'AppImage',
            deb: 'deb 包',
          },
        },
      },
      systemRequirements: '系统要求：',
      moreVersions: '更多版本请访问',
      githubReleases: 'GitHub Releases',
      source: {
        label: '下载源',
        aliyun: '阿里云（国内推荐）',
        github: 'GitHub',
        switchTo: '切换到',
      },
    },
    footer: {
      licenseTitle: '开源授权',
      openSource: {
        badge: '开源许可',
        title: 'AGPL v3.0',
        description: '以下场景免费使用：',
        items: [
          '个人使用，完全免费',
          '教育机构',
          '医疗及医疗研究机构',
          '非盈利组织',
          '企业内部使用 ≤ 1000套',
        ],
        note: '需遵守 AGPL v3.0 全部条款，修改需开源',
      },
      commercial: {
        badge: '商业授权',
        title: '商业授权',
        description: '以下场景需要商业授权：',
        items: [
          '作为产品/服务的一部分提供',
          '不希望开源修改的代码',
          '修改本软件的 Logo 或名称',
          '删除或修改"支持作者"功能',
          '企业内部使用超过 1000 套',
        ],
        contact: '联系获取商业授权 →',
      },
      links: {
        github: 'GitHub',
        issues: '问题反馈',
        license: '许可证',
      },
      copyright: '保留所有权利.',
    },
    changelog: {
      title: '更新日志',
      subtitle: '记录旗鱼的每一次进化',
    },
    guide: {
      title: '使用指南',
      subtitle: '了解旗鱼的核心功能，快速上手',
      nav: '指南',
      toc: '目录',
      visionRouting: {
        title: '混合多模态：让纯文本模型也能看图',
        intro: '许多强大的推理模型（如 DeepSeek R1）不支持图片输入，而视觉模型（如 GPT-4o）在复杂推理上可能不如专业文本模型。旗鱼的「关联模型」功能让你两全其美——平时用最强的文本模型思考，遇到图片时自动切换到视觉模型处理。',
        howItWorks: '工作原理',
        howItWorksDesc: '当你发送包含图片的消息时，旗鱼会自动检测并执行以下路由逻辑：',
        flowSteps: [
          '你发送了一张图片或截图',
          '旗鱼检测到消息中包含图片',
          '检查当前主模型是否支持视觉',
          '如果不支持 → 自动切换到关联的视觉模型处理本次请求',
          '视觉模型处理完毕后，后续纯文本对话继续使用主模型',
        ],
        setup: '配置方法',
        setupSteps: [
          '打开 设置 → AI 模型配置',
          '为你的主力文本模型（如 DeepSeek R1）设置「模型类型」为 通用',
          '在「关联视觉模型」下拉框中，选择一个支持图片的模型（如 GPT-4o、Claude Sonnet）',
          '确保「自动视觉模型切换」开关已开启（设置 → 通用）',
        ],
        example: '典型使用场景',
        exampleDesc: '你的主力模型是 DeepSeek R1（强推理，不支持图片），关联视觉模型为 GPT-4o：',
        exampleScenarios: [
          { input: '发送纯文本：「分析这段代码的性能问题」', result: '→ DeepSeek R1 处理（推理能力强）' },
          { input: '发送截图：「这个报错怎么解决？」', result: '→ 自动切换 GPT-4o 处理（能看图）' },
          { input: '后续追问：「还有其他优化建议吗？」', result: '→ 回到 DeepSeek R1（纯文本）' },
        ],
        tips: '使用建议',
        tipsList: [
          '主模型选推理能力最强的（如 DeepSeek R1、o1），关联模型选视觉能力好的（如 GPT-4o、Claude Sonnet）',
          '如果主模型本身支持视觉（如 GPT-4o），无需配置关联模型，会直接使用',
          '模型选择器中标有「视觉」标签的模型支持图片输入',
          '切换是按次请求进行的，不会影响对话连贯性',
        ],
      },
    },
    skillMarket: {
      title: '技能市场',
      subtitle: '社区共建的 AI Agent 技能库，一键安装即可扩展 Agent 能力',
      featured: '精选推荐',
      allSkills: '全部技能',
      categories: {
        all: '全部',
      },
      skillCount: '个技能',
      version: '版本',
      author: '作者',
      install: '安装方法',
      installStep1: '打开旗鱼，进入 设置 → 技能管理 → 技能市场',
      installStep2: '浏览并找到想要的技能，点击安装',
      installStep3: '或使用 CLI 命令安装',
      viewContent: '查看技能内容',
      installBtn: '安装此技能',
      installRequiresApp: '需先安装旗鱼应用',
      tryExamples: '试用示例',
      runInSailfish: '在旗鱼中运行',
      requiresApp: '需先安装旗鱼',
      contribute: '贡献技能',
      contributeDesc: '有好的技能想分享给社区？欢迎提交 PR 到我们的 GitHub 仓库！',
      contributeBtn: '提交技能 →',
      empty: '暂无技能',
    },
    common: {
      brandName: '旗鱼',
    },
  },
  en: {
    nav: {
      features: 'Features',
      download: 'Download',
      stats: 'Stats',
      changelog: 'Changelog',
      skills: 'Skills',
      guide: 'Guide',
      github: 'GitHub',
      cta: 'Download Now',
    },
    hero: {
      versionLabel: 'Latest Version',
      titleHighlight: 'AI-Powered',
      titleSuffix: ' Smart Assistant',
      subtitle: 'Describe what you need, AI plans and executes autonomously.',
      subtitleLine2: 'Chat with your Agent via desktop app, Feishu, DingTalk, WeCom, Slack, Telegram, or Web — let AI handle the rest.',
      downloadBtn: 'Download Now',
      viewSourceBtn: 'View Source',
      apiNotice: 'This software does not include built-in LLM. You need to configure your own API.',
      platforms: {
        macOS: 'macOS',
        Windows: 'Windows',
        Linux: 'Linux',
      },
      screenshot: {
        production: '🖥️ Production Server',
        test: '📦 Test Environment',
        dev: '🔧 Dev Machine',
        aiAssistant: 'AI Assistant',
        aiMessage: 'Disk usage is 45%, status is good. Recommend regular log cleanup to free up space.',
      },
    },
    features: {
      title: 'Powerful Features, Smart & Efficient',
      subtitle: 'More than a terminal — your AI Agent that executes commands, manages files, sends emails, browses the web, and beyond',
      items: [
        {
          title: 'Autonomous AI Agent',
          description: 'Describe your goal, and the Agent breaks it into steps, plans the execution, invokes tools, and completes tasks autonomously. Multi-model support with built-in risk assessment and human-in-the-loop confirmation.',
          highlights: ['Autonomous Planning', 'Multi-model Support', 'Risk Assessment & Confirmation'],
        },
        {
          title: 'Multi-Channel Access',
          description: 'Beyond the desktop — chat with your Agent via Feishu, DingTalk, WeCom, Slack, and Telegram bots, or through the Web remote interface. Manage servers and run tasks from your phone, anytime.',
          highlights: ['Feishu / DingTalk / WeCom', 'Slack / Telegram', 'Web Remote Access'],
        },
        {
          title: 'Rich Agent Skills',
          description: 'Out-of-the-box skill extensions: browser automation, email management, calendar scheduling, Excel/Word style themes — AI capabilities far beyond the command line. In Awaken mode, AI proactively monitors and pushes notifications.',
          highlights: ['Awaken Mode & Sensors', 'Email / Calendar', 'Excel / Word Processing'],
        },
        {
          title: 'Local Knowledge Base',
          description: 'Import documents to build an offline RAG system. Automatically remembers host configurations and operation history. All data stored locally, fully offline.',
          highlights: ['Offline Embedding', 'Host Profile Memory', 'Document Q&A'],
        },
        {
          title: 'MCP Ecosystem',
          description: 'Supports the Model Context Protocol standard. Connect databases, APIs, file systems, and other external tools with one click to infinitely extend Agent capabilities.',
          highlights: ['stdio / SSE Transport', 'Preset Templates', 'Visual Management'],
        },
        {
          title: 'Terminal & Server Management',
          description: 'Built-in professional terminal and SSH client with visual SFTP file management, batch server operations, and Xshell session import for ops needs.',
          highlights: ['SSH / SFTP', 'Batch Operations', 'Enterprise Security'],
        },
      ],
    },
    useCases: {
      title: 'Use Cases',
      subtitle: 'Whether you\'re an AI practitioner, ops engineer, or everyday user, SailFish is your capable assistant',
      items: [
        {
          role: 'AI Practitioner',
          icon: 'ai',
          description: 'Your best companion for GPU server management and model training',
          scenarios: [
            'GPU status monitoring & resource management',
            'Model training deployment & debugging',
            'CUDA / PyTorch environment setup',
            'Training log analysis & troubleshooting',
          ],
        },
        {
          role: 'Ops Engineer',
          icon: 'server',
          description: 'Efficiently manage multiple servers with AI-assisted troubleshooting',
          scenarios: [
            'Batch server inspection & monitoring',
            'Log analysis & anomaly detection',
            'Automated ops script generation',
            'Disk, memory, CPU diagnostics',
          ],
        },
        {
          role: 'Developer',
          icon: 'code',
          description: 'Boost development efficiency with AI as your coding assistant',
          scenarios: [
            'Git operations & code deployment',
            'Dev environment setup & debugging',
            'Docker container management',
            'API debugging & testing',
          ],
        },
        {
          role: 'DBA',
          icon: 'database',
          description: 'Database maintenance made easier with AI-powered optimization',
          scenarios: [
            'Database backup & recovery',
            'SQL performance analysis',
            'Replication status checks',
            'Slow query identification',
          ],
        },
        {
          role: 'Security Engineer',
          icon: 'shield',
          description: 'Your reliable assistant for security audits and vulnerability scanning',
          scenarios: [
            'System security baseline checks',
            'Intrusion trace analysis',
            'Permission & access auditing',
            'Security log analysis',
          ],
        },
        {
          role: 'Linux Learner',
          icon: 'book',
          description: 'Learn by doing with real-time AI explanations',
          scenarios: [
            'Command syntax learning',
            'System administration basics',
            'Shell script writing guidance',
            'Config file understanding',
          ],
        },
      ],
    },
    download: {
      title: 'Download Now',
      subtitle: 'Free to use, open source. Choose the version that fits your system and start experiencing',
      platforms: {
        macOS: {
          name: 'macOS',
          description: 'Supports macOS 10.15+',
          variants: {
            appleSilicon: 'Apple Silicon',
            intel: 'Intel',
          },
        },
        Windows: {
          name: 'Windows',
          description: 'Supports Win 10/11, Server 2016+',
          variants: {
            installer64: '64-bit Installer',
          },
        },
        Linux: {
          name: 'Linux',
          description: 'Supports major Linux distributions',
          variants: {
            appImage: 'AppImage',
            deb: 'deb Package',
          },
        },
      },
      systemRequirements: 'System Requirements:',
      moreVersions: 'For more versions, visit',
      githubReleases: 'GitHub Releases',
      source: {
        label: 'Download Source',
        aliyun: 'Aliyun China',
        github: 'GitHub',
        switchTo: 'Switch to',
      },
    },
    footer: {
      licenseTitle: 'Open Source License',
      openSource: {
        badge: 'Open Source License',
        title: 'AGPL v3.0',
        description: 'Free to use in the following scenarios:',
        items: [
          'Personal use, completely free',
          'Non-profit organizations / Educational institutions',
          'Medical and medical research institutions',
          'Non-profit organizations',
          'Enterprise internal use ≤ 1000 units',
        ],
        note: 'Must comply with all AGPL v3.0 terms. Modifications must be open source.',
      },
      commercial: {
        badge: 'Commercial License',
        title: 'Commercial License',
        description: 'Commercial license required for the following scenarios:',
        items: [
          'Providing as part of a product/service',
          'Do not want to open source modified code',
          'Modify the software\'s Logo or name',
          'Remove or modify the "Support Author" feature',
          'Enterprise internal use exceeding 1000 units',
        ],
        contact: 'Contact for Commercial License →',
      },
      links: {
        github: 'GitHub',
        issues: 'Issues',
        license: 'License',
      },
      copyright: 'All rights reserved.',
    },
    changelog: {
      title: 'Changelog',
      subtitle: 'Track every evolution of SailFish',
    },
    guide: {
      title: 'Guide',
      subtitle: 'Learn the core features of SailFish and get started quickly',
      nav: 'Guide',
      toc: 'Contents',
      visionRouting: {
        title: 'Hybrid Multimodal: Give Your Text Model Eyes',
        intro: 'Many powerful reasoning models (e.g. DeepSeek R1) don\'t support image input, while vision models (e.g. GPT-4o) may not match specialized text models in complex reasoning. SailFish\'s "Linked Model" feature gives you the best of both worlds — use your strongest text model for thinking, and automatically switch to a vision model when images are involved.',
        howItWorks: 'How It Works',
        howItWorksDesc: 'When you send a message containing images, SailFish automatically detects and executes the following routing logic:',
        flowSteps: [
          'You send an image or screenshot',
          'SailFish detects images in the message',
          'Checks if the current main model supports vision',
          'If not → automatically switches to the linked vision model for this request',
          'After processing, subsequent text-only conversations continue with the main model',
        ],
        setup: 'Setup',
        setupSteps: [
          'Open Settings → AI Model Configuration',
          'Set your primary text model (e.g. DeepSeek R1) "Model Type" to General',
          'In the "Linked Vision Model" dropdown, select a vision-capable model (e.g. GPT-4o, Claude Sonnet)',
          'Make sure "Auto Vision Model Switch" is enabled (Settings → General)',
        ],
        example: 'Typical Use Case',
        exampleDesc: 'Your main model is DeepSeek R1 (strong reasoning, no image support), linked vision model is GPT-4o:',
        exampleScenarios: [
          { input: 'Send text: "Analyze the performance issues in this code"', result: '→ DeepSeek R1 handles it (strong reasoning)' },
          { input: 'Send screenshot: "How do I fix this error?"', result: '→ Auto-switches to GPT-4o (can see images)' },
          { input: 'Follow-up: "Any other optimization suggestions?"', result: '→ Back to DeepSeek R1 (text only)' },
        ],
        tips: 'Tips',
        tipsList: [
          'Choose the strongest reasoning model as primary (e.g. DeepSeek R1, o1), and a good vision model as linked (e.g. GPT-4o, Claude Sonnet)',
          'If your primary model already supports vision (e.g. GPT-4o), no linked model is needed',
          'Models labeled with "Vision" tag in the selector support image input',
          'Switching happens per-request and doesn\'t affect conversation continuity',
        ],
      },
    },
    skillMarket: {
      title: 'Skill Market',
      subtitle: 'Community-built AI Agent skills — install with one click to extend your Agent\'s capabilities',
      featured: 'Featured',
      allSkills: 'All Skills',
      categories: {
        all: 'All',
      },
      skillCount: ' skills',
      version: 'Version',
      author: 'Author',
      install: 'Installation',
      installStep1: 'Open SailFish, go to Settings → Skill Management → Skill Market',
      installStep2: 'Browse and find the skill you want, click Install',
      installStep3: 'Or install via CLI command',
      viewContent: 'View Skill Content',
      installBtn: 'Install Skill',
      installRequiresApp: 'Requires SailFish app',
      tryExamples: 'Try Examples',
      runInSailfish: 'Run in SailFish',
      requiresApp: 'Requires SailFish app',
      contribute: 'Contribute Skills',
      contributeDesc: 'Have a great skill to share with the community? Submit a PR to our GitHub repository!',
      contributeBtn: 'Submit a Skill →',
      empty: 'No skills available',
    },
    common: {
      brandName: 'SailFish',
    },
  },
} as const;

export type Lang = SupportedLanguage;
export type Translations = typeof translations[SupportedLanguage];
