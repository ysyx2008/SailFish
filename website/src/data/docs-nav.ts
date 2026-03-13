export interface NavItem {
  slug: string;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function getDocsNav(lang: 'zh' | 'en'): NavGroup[] {
  if (lang === 'zh') {
    return [
      {
        label: '入门',
        items: [
          { slug: 'getting-started/what-is-sailfish', label: '什么是旗鱼' },
          { slug: 'getting-started/installation', label: '下载与安装' },
          { slug: 'getting-started/first-setup', label: '首次配置' },
          { slug: 'getting-started/interface-overview', label: '认识界面' },
          { slug: 'getting-started/first-conversation', label: '第一次对话' },
        ],
      },
      {
        label: '基础功能',
        items: [
          { slug: 'basics/ai-conversation', label: 'AI 对话' },
          { slug: 'basics/terminal', label: '终端基础' },
          { slug: 'basics/file-manager', label: '文件管理' },
          { slug: 'basics/agent-mode', label: 'Agent 模式' },
          { slug: 'basics/settings', label: '设置详解' },
        ],
      },
      {
        label: '服务器管理',
        items: [
          { slug: 'server/ssh-connection', label: 'SSH 连接' },
          { slug: 'server/sftp-transfer', label: 'SFTP 文件传输' },
          { slug: 'server/multi-server', label: '多服务器管理' },
        ],
      },
      {
        label: 'AI 进阶',
        items: [
          { slug: 'ai-advanced/model-config', label: '模型配置详解' },
          { slug: 'ai-advanced/knowledge-base', label: '知识库' },
          { slug: 'ai-advanced/mcp-extensions', label: 'MCP 扩展' },
          { slug: 'ai-advanced/skill-system', label: '技能系统' },
          { slug: 'ai-advanced/advanced-recipes', label: '进阶实战' },
        ],
      },
      {
        label: '觉醒模式',
        items: [
          { slug: 'awaken/awaken-intro', label: '觉醒模式入门' },
          { slug: 'awaken/watch-recipes', label: '常用关切配置' },
        ],
      },
      {
        label: '远程访问',
        items: [
          { slug: 'remote-access/overview', label: '远程访问概览' },
          { slug: 'remote-access/web-remote', label: 'Web 远程访问' },
          { slug: 'remote-access/feishu', label: '飞书集成' },
          { slug: 'remote-access/dingtalk', label: '钉钉集成' },
          { slug: 'remote-access/wecom', label: '企业微信集成' },
          { slug: 'remote-access/slack', label: 'Slack 集成' },
          { slug: 'remote-access/telegram', label: 'Telegram 集成' },
        ],
      },
      {
        label: '办公技能',
        items: [
          { slug: 'office/word', label: 'Word 文档生成' },
          { slug: 'office/email', label: '邮箱管理' },
          { slug: 'office/calendar', label: '日历与待办' },
        ],
      },
      {
        label: '故障排查',
        items: [
          { slug: 'troubleshooting/faq', label: '常见问题' },
          { slug: 'troubleshooting/common-issues', label: '故障排查指南' },
        ],
      },
    ];
  }

  return [
    {
      label: 'Getting Started',
      items: [
        { slug: 'getting-started/what-is-sailfish', label: 'What is SailFish' },
        { slug: 'getting-started/installation', label: 'Download & Install' },
        { slug: 'getting-started/first-setup', label: 'First Setup' },
        { slug: 'getting-started/interface-overview', label: 'Interface Overview' },
        { slug: 'getting-started/first-conversation', label: 'First Conversation' },
      ],
    },
    {
      label: 'Core Features',
      items: [
        { slug: 'basics/ai-conversation', label: 'AI Conversation' },
        { slug: 'basics/terminal', label: 'Terminal Basics' },
        { slug: 'basics/file-manager', label: 'File Manager' },
        { slug: 'basics/agent-mode', label: 'Agent Mode' },
        { slug: 'basics/settings', label: 'Settings' },
      ],
    },
    {
      label: 'Server Management',
      items: [
        { slug: 'server/ssh-connection', label: 'SSH Connection' },
        { slug: 'server/sftp-transfer', label: 'SFTP Transfer' },
        { slug: 'server/multi-server', label: 'Multi-Server' },
      ],
    },
    {
      label: 'AI Advanced',
      items: [
        { slug: 'ai-advanced/model-config', label: 'Model Configuration' },
        { slug: 'ai-advanced/knowledge-base', label: 'Knowledge Base' },
        { slug: 'ai-advanced/mcp-extensions', label: 'MCP Extensions' },
        { slug: 'ai-advanced/skill-system', label: 'Skill System' },
        { slug: 'ai-advanced/advanced-recipes', label: 'Advanced Recipes' },
      ],
    },
    {
      label: 'Awaken Mode',
      items: [
        { slug: 'awaken/awaken-intro', label: 'Awaken Mode Intro' },
        { slug: 'awaken/watch-recipes', label: 'Watch Recipes' },
      ],
    },
    {
      label: 'Remote Access',
      items: [
        { slug: 'remote-access/overview', label: 'Overview' },
        { slug: 'remote-access/web-remote', label: 'Web Remote' },
        { slug: 'remote-access/feishu', label: 'Feishu (Lark)' },
        { slug: 'remote-access/dingtalk', label: 'DingTalk' },
        { slug: 'remote-access/wecom', label: 'WeCom' },
        { slug: 'remote-access/slack', label: 'Slack' },
        { slug: 'remote-access/telegram', label: 'Telegram' },
      ],
    },
    {
      label: 'Office Skills',
      items: [
        { slug: 'office/word', label: 'Word Documents' },
        { slug: 'office/email', label: 'Email Management' },
        { slug: 'office/calendar', label: 'Calendar & Todos' },
      ],
    },
    {
      label: 'Troubleshooting',
      items: [
        { slug: 'troubleshooting/faq', label: 'FAQ' },
        { slug: 'troubleshooting/common-issues', label: 'Troubleshooting Guide' },
      ],
    },
  ];
}

/**
 * Flatten nav groups into a flat list of slugs for prev/next navigation
 */
export function getFlatNavSlugs(lang: 'zh' | 'en'): string[] {
  return getDocsNav(lang).flatMap(group => group.items.map(item => item.slug));
}
