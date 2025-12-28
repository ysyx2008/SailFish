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
      github: 'GitHub',
      cta: '立即下载',
    },
    hero: {
      versionLabel: '最新版本',
      titleHighlight: 'AI 驱动',
      titleSuffix: '的跨平台终端',
      subtitle: '让命令行操作更加高效、智能。',
      subtitleLine2: '遇到问题？让 AI 帮你分析。不知道命令？用自然语言描述即可。',
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
      subtitle: '将传统终端的强大与 AI 智能深度融合，重新定义命令行操作体验',
      items: [
        {
          title: '大模型对话',
          description: '自带 AI 助手面板，解释命令、分析日志、生成脚本。需自行配置 API Key',
          highlights: ['自带 API', '多模型支持', '上下文感知'],
        },
        {
          title: 'AI Agent 模式',
          description: '描述你想做的事，AI 自动规划并执行多步命令。支持 16 种 MBTI 性格，自定义回复风格。',
          highlights: ['自动化任务执行', '风险评估与确认', '命令自动修正'],
        },
        {
          title: '本地知识库',
          description: '导入文档构建离线 RAG 系统，自动记忆主机配置与历史操作，让 AI 更懂你的环境。',
          highlights: ['离线 Embedding', '主机画像记忆', '文档问答'],
        },
        {
          title: 'MCP 扩展',
          description: '支持 Model Context Protocol 标准，连接外部工具和资源，无限扩展 Agent 能力。',
          highlights: ['stdio / SSE 传输', '预设模板', '可视化管理'],
        },
        {
          title: 'SFTP 文件管理',
          description: '可视化文件浏览器，支持上传、下载、预览、编辑，文件管理如同本地操作一样简单。',
          highlights: ['拖拽上传', '实时进度', '文本预览'],
        },
        {
          title: '企业友好',
          description: '支持内网 AI API 和代理配置，所有数据本地存储，满足企业安全合规要求。',
          highlights: ['内网部署', '数据本地化', 'Xshell 导入'],
        },
      ],
    },
    useCases: {
      title: '适用场景',
      subtitle: '无论你是 AI 从业者、运维工程师还是学习者，旗鱼终端都能助你事半功倍',
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
    },
    footer: {
      licenseTitle: '开源授权',
      openSource: {
        badge: '开源许可',
        title: 'AGPL v3.0',
        description: '以下场景免费使用：',
        items: [
          '个人学习、研究、日常使用',
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
    common: {
      brandName: '旗鱼终端',
    },
  },
  en: {
    nav: {
      features: 'Features',
      download: 'Download',
      stats: 'Stats',
      github: 'GitHub',
      cta: 'Download Now',
    },
    hero: {
      versionLabel: 'Latest Version',
      titleHighlight: 'AI-Powered',
      titleSuffix: ' Cross-Platform Terminal',
      subtitle: 'Make command-line operations more efficient and intelligent.',
      subtitleLine2: 'Stuck on a problem? Let AI analyze it. Don\'t know the command? Just describe it in natural language.',
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
      subtitle: 'Seamlessly blend traditional terminal power with AI intelligence to redefine command-line experience',
      items: [
        {
          title: 'LLM Chat',
          description: 'Built-in AI assistant panel for command explanation, log analysis, and script generation. Requires your own API key.',
          highlights: ['Built-in API', 'Multi-model Support', 'Context Aware'],
        },
        {
          title: 'AI Agent Mode',
          description: 'Describe what you want to do, and AI will plan and execute multi-step commands. Supports 16 MBTI personalities with customizable response styles.',
          highlights: ['Automated Task Execution', 'Risk Assessment & Confirmation', 'Auto Command Correction'],
        },
        {
          title: 'Local Knowledge Base',
          description: 'Import documents to build an offline RAG system. Automatically remembers host configurations and operation history, making AI understand your environment better.',
          highlights: ['Offline Embedding', 'Host Profile Memory', 'Document Q&A'],
        },
        {
          title: 'MCP Extension',
          description: 'Supports Model Context Protocol standard, connecting external tools and resources to infinitely extend Agent capabilities.',
          highlights: ['stdio / SSE Transport', 'Preset Templates', 'Visual Management'],
        },
        {
          title: 'SFTP File Management',
          description: 'Visual file browser supporting upload, download, preview, and edit. File management as simple as local operations.',
          highlights: ['Drag & Drop Upload', 'Real-time Progress', 'Text Preview'],
        },
        {
          title: 'Enterprise Friendly',
          description: 'Supports intranet AI API and proxy configuration. All data stored locally, meeting enterprise security and compliance requirements.',
          highlights: ['Intranet Deployment', 'Data Localization', 'Xshell Import'],
        },
      ],
    },
    useCases: {
      title: 'Use Cases',
      subtitle: 'Whether you\'re an AI practitioner, ops engineer, or learner, SFTerm helps you work smarter',
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
    },
    footer: {
      licenseTitle: 'Open Source License',
      openSource: {
        badge: 'Open Source License',
        title: 'AGPL v3.0',
        description: 'Free to use in the following scenarios:',
        items: [
          'Personal learning, research, and daily use',
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
    common: {
      brandName: 'SFTerm',
    },
  },
} as const;

export type Lang = SupportedLanguage;
export type Translations = typeof translations[SupportedLanguage];
