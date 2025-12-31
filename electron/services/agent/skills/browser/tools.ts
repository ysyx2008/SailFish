/**
 * 浏览器技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const browserTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_launch',
      description: `启动浏览器，建立会话。浏览器窗口会显示在屏幕上，用户可以看到操作过程。

**注意**：
- 每个终端最多一个浏览器会话
- 5 分钟无操作会自动关闭
- 完成后请调用 browser_close 关闭

**登录状态管理**：
- 使用 profile 参数可恢复之前保存的登录状态
- 使用 profile 启动时，关闭浏览器会**自动保存**登录状态
- 例如：browser_launch { profile: "taobao" } 会恢复淘宝登录，关闭时自动保存最新状态`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '启动后立即访问的 URL（可选）'
          },
          headless: {
            type: 'boolean',
            description: '是否无头模式（默认 false，显示窗口）'
          },
          profile: {
            type: 'string',
            description: '登录配置名称。首次使用会创建新配置，关闭时自动保存登录状态；再次使用会恢复登录状态'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: `导航到指定网址。

**等待策略**：
- load：等待页面完全加载（默认）
- domcontentloaded：DOM 加载完成即可
- networkidle：网络空闲时`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标 URL'
          },
          wait_until: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: '等待策略（默认 load）'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: `对当前页面截图并保存。

**模式**：
- 默认：截取可视区域
- full_page: true：截取整个页面（包括滚动区域）
- selector：只截取指定元素`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '保存路径（可选，默认保存到临时目录）'
          },
          full_page: {
            type: 'boolean',
            description: '是否截取整页（默认 false）'
          },
          selector: {
            type: 'string',
            description: '只截取指定元素的 CSS 选择器（可选）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_content',
      description: `获取页面内容。

**格式**：
- text：纯文本（默认，适合阅读）
- html：HTML 源码
- markdown：转换为 Markdown

**限制**：默认最多返回 10000 字符`,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'html', 'markdown'],
            description: '输出格式（默认 text）'
          },
          selector: {
            type: 'string',
            description: '只获取指定元素的内容（CSS 选择器）'
          },
          max_length: {
            type: 'number',
            description: '最大字符数（默认 10000）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: `点击页面元素。

**选择器支持**：
- CSS 选择器：\`#id\`, \`.class\`, \`button\`
- 文本选择器：\`text=登录\`, \`text=提交\`
- 角色选择器：\`role=button[name="确定"]\`

**注意**：会自动等待元素可点击`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '元素选择器（CSS、文本或角色）'
          },
          wait_for_navigation: {
            type: 'boolean',
            description: '是否等待页面跳转（默认 false）'
          }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: `在输入框中输入文本。

**选择器支持**：
- CSS 选择器：\`input[name="username"]\`
- 文本选择器：\`text=用户名\`（会找到相关的输入框）
- 占位符：\`placeholder=请输入用户名\`

**注意**：默认会先清空输入框`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '输入框选择器'
          },
          text: {
            type: 'string',
            description: '要输入的文本'
          },
          clear_first: {
            type: 'boolean',
            description: '是否先清空（默认 true）'
          },
          press_enter: {
            type: 'boolean',
            description: '输入后是否按回车（默认 false）'
          }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: `滚动页面。

**方向**：
- down：向下滚动（默认）
- up：向上滚动
- top：滚动到顶部
- bottom：滚动到底部`,
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: '滚动方向（默认 down）'
          },
          distance: {
            type: 'number',
            description: '滚动距离（像素，默认 500）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: `等待元素出现或指定时间。

**用法**：
- 等待元素：指定 selector
- 等待时间：指定 delay（毫秒）`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '等待此元素出现'
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒，默认 30000）'
          },
          delay: {
            type: 'number',
            description: '直接等待指定毫秒数'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: `在页面中执行 JavaScript 代码。

**返回值**：脚本的返回值会被 JSON 序列化后返回

**示例**：
- 获取标题：\`document.title\`
- 获取元素数量：\`document.querySelectorAll('img').length\``,
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: '要执行的 JavaScript 代码'
          }
        },
        required: ['script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: `列出所有打开的标签页。

**返回**：每个标签页的索引、URL、标题，以及哪个是当前活动标签页`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_switch_tab',
      description: `切换到指定的标签页。

**使用场景**：当点击链接打开了新标签页后，可以用此工具切换回原标签页，或在多个标签页之间切换`,
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: '标签页索引（从 0 开始，使用 browser_list_tabs 查看）'
          }
        },
        required: ['index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_save_login',
      description: `保存当前浏览器的登录状态（cookies、localStorage 等）。

**使用场景**：登录网站后，保存登录状态，下次可以直接恢复，无需重新登录。

**示例**：保存为 "taobao" 配置，下次启动时使用 browser_launch { profile: "taobao" } 即可恢复登录状态`,
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: '配置名称（如 "taobao"、"github" 等）'
          }
        },
        required: ['profile']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_profiles',
      description: `列出所有已保存的登录配置。

**返回**：配置名称列表，可用于 browser_launch 的 profile 参数`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: `关闭浏览器会话。

**注意**：关闭后如需再次操作网页，需要重新调用 browser_launch`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }
]

