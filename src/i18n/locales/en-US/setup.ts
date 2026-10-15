// 首次设置向导
export default {

  // Setup Wizard
  setup: {
    welcome: {
      title: 'Welcome to SailFish',
      subtitle: 'AI-powered smart assistant for efficient work',
      intro: 'SailFish is a smart assistant integrating powerful AI capabilities to make your work more efficient. This wizard will help you complete the initial setup and get started quickly.',
      features: {
        aiChat: {
          title: 'AI Chat Assistant',
          desc: 'Chat with AI directly in the terminal, ask about command usage, troubleshoot issues, get help. Supports multiple LLMs including OpenAI, Qwen, DeepSeek, and local Ollama deployments.'
        },
        agent: {
          title: 'Agent Auto-Execution',
          desc: 'AI Agent can understand your natural language instructions and automatically execute complex operations tasks. Supports command execution, file operations, system monitoring, making AI your capable assistant.'
        },
        ssh: {
          title: 'SSH Session Management',
          desc: 'Unified management of multiple servers, supports grouping, jump hosts, quick connections. One-click import of Xshell session configurations for quick migration.'
        },
        knowledge: {
          title: 'Local Knowledge Base',
          desc: 'Upload documents to local knowledge base, AI automatically retrieves relevant content during conversations for more accurate answers. Supports PDF, Word, text formats, using lightweight vector model with no additional download required.'
        }
      },
      skipWizard: 'Skip Wizard'
    },
    aiConfig: {
      title: 'Configure AI Model',
      subtitle: 'Configure large language model to make terminal smarter',
      subtitleSimple: 'Choose an AI service and enter your API Key',
      intro: 'AI model is the core of AI features. You need to configure at least one model to use AI chat and Agent features.',
      hint: 'Supports OpenAI-compatible APIs, including vLLM, FastChat, Ollama and other private deployment solutions.',
      modelRecommendation: '',
      configuredModels: 'Configured Models',
      addNewModel: 'Add New Model',
      quickTemplates: 'Quick Templates:',
      fillRequired: 'Please fill in all required fields',
      saveFailed: 'Save failed',
      required: 'Please configure at least one AI model to continue',
      oemNeedLogin: 'Company models appear after you sign in. You can continue now; after signing in you do not need to enter an address or model name.',
      oemUnavailable: 'The company model list is not here yet. You can continue and it will be fetched again next time you open the app, or add your own below.',
      alreadyConfigured: 'Configured: {name}',
      configured: 'Configured',
      enterApiKey: 'Enter API Key',
      apiKeyRequired: 'Please enter API Key',
      localNoKey: 'Local service requires no API Key, just make sure Ollama is running',
      useThis: 'Use This Model',
      canChangeLater: 'You can add more models or modify settings later',
      customNamePlaceholder: 'e.g., Internal GPT',
      customUrlPlaceholder: 'e.g., http://192.168.1.100:8000/v1/chat/completions',
      customKeyPlaceholder: 'Leave empty if not required',
      customModelPlaceholder: 'e.g., gpt-5.6'
    },
    import: {
      title: 'Import SSH Hosts',
      subtitle: 'Quickly import existing SSH host configurations',
      shortDesc: 'Import host configs from Xshell',
      intro: 'If you previously used Xshell, you can import all session configurations with one click to quickly migrate to SailFish.',
      scanning: 'Scanning Xshell session directory...',
      scanNow: 'Scan Xshell Config',
      found: 'Found {count} sessions',
      import: 'Import',
      importing: 'Importing...',
      imported: 'Imported',
      importSuccess: 'Successfully imported {count} hosts',
      importFailed: 'Import failed',
      manualSelect: 'Select Directory',
      notFound: 'Xshell session directory not found',
      notFoundHint: 'You can manually select a directory to import, or add hosts later in settings'
    },
    knowledge: {
      title: 'Local Knowledge Base',
      subtitle: 'Enable local knowledge base for AI to better understand your documents and habits',
      shortDesc: 'AI learns your documents and habits',
      features: {
        title: 'Knowledge Base Features',
        item1: 'Upload documents to local knowledge base, supports PDF, Word, text and more',
        item2: 'Automatically record host operation memories, AI learns your usage habits and preferences',
        item3: 'AI automatically retrieves relevant content during conversations for more accurate answers',
        item4: 'Data encrypted storage to protect your sensitive information'
      },
      enableSwitch: 'Enable Knowledge Base',
      enableHint: 'When enabled, documents and host memories can be stored to make Agent smarter',
      passwordIntro: 'Knowledge base can store sensitive information like documents and host memories. Please set a password to encrypt this data.',
      passwordLabel: 'Set Password',
      passwordPlaceholder: 'Enter password (at least 4 characters)',
      confirmPasswordLabel: 'Confirm Password',
      confirmPasswordPlaceholder: 'Enter password again',
      passwordMinLength: 'Password must be at least 4 characters',
      passwordMismatch: 'Passwords do not match',
      saveFailed: 'Save failed'
    },
    mcp: {
      title: 'MCP Connectors',
      subtitle: 'Connect MCP connectors to extend AI capabilities',
      shortDesc: 'Extend AI capabilities (advanced)',
      intro: 'MCP (Model Context Protocol) is a protocol that allows AI to access external tools and resources.',
      hint: 'You can add MCP connectors in settings later, feel free to skip this step.',
      configuredServers: 'Configured MCP Connectors',
      noServers: 'No MCP connectors configured',
      noServersHint: 'Configure MCP connectors in settings',
      servers: 'connectors'
    },
    complete: {
      title: 'All Set!',
      subtitle: 'Start using SailFish',
      readyToUse: 'AI model configured, ready to start',
      aiReady: 'AI Features Ready',
      aiReadyDesc: 'Your AI model is configured. You can now start using AI chat and Agent features.',
      steamReady: 'Ready to Go',
      steamReadyDesc: 'The Steam version provides terminal, SSH, and file management. You can start using it right away.',
      optionalConfig: 'Optional Settings',
      optionalHint: 'These features can be configured later in settings, or set up now',
      summary: {
        aiConfigured: 'AI model configured',
        aiNotConfigured: 'AI model not configured',
        hostsImported: 'Imported {count} hosts',
        knowledgeEnabled: 'Knowledge base enabled',
        knowledgeNotEnabled: 'Knowledge base not enabled',
        mcpConfigured: 'MCP connectors configured',
        mcpNotConfigured: 'MCP connectors not configured'
      },
      tip: 'You can modify these settings anytime in Settings'
    },
    aiGuide: {
      title: 'AI Assistant',
      placeholder: 'Ask me anything...',
      thinking: 'Thinking...'
    }
  },
}
