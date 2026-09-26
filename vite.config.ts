import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import type { ChildProcess } from 'node:child_process'
import { BUNDLED_GRAMMARS, BUNDLED_WASM_DIR } from './electron/services/agent/skills/coding/grammars'

/**
 * OEM 可选配置：有 shared/oem.config.ts 则打包进覆盖配置，没有则用 oem-defaults。
 * 不强制生成该文件（开源主线不提交）。
 */
function optionalOemConfig(): Plugin {
  const runtimeFile = resolve(__dirname, 'shared/oem-runtime.ts')
  const overrideFile = resolve(__dirname, 'shared/oem.config.ts')

  return {
    name: 'optional-oem-config',
    enforce: 'pre',
    load(id) {
      const normalized = id.split('?')[0]
      if (resolve(normalized) !== runtimeFile) return null
      const from = existsSync(overrideFile) ? './oem.config' : './oem-defaults'
      if (existsSync(overrideFile)) {
        console.log('[optional-oem-config] using shared/oem.config.ts')
      }
      return `
export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'
export { oemConfig } from '${from}'
`
    },
  }
}

/** dev 主进程 rebuild 前给 Electron 最多 4s 优雅退出，避免 LanceDB 写入/compaction 被强杀 */
const DEV_GRACEFUL_SHUTDOWN_MS = 4000

async function restartElectronDev(
  startup: (argv?: string[], options?: import('node:child_process').SpawnOptions, customElectronPkg?: string) => Promise<void>
): Promise<void> {
  const proc = (process as NodeJS.Process & { electronApp?: ChildProcess }).electronApp
  if (proc && !proc.killed) {
    proc.send?.({ type: 'graceful-shutdown' })
    await Promise.race([
      new Promise<void>(resolve => {
        proc.once('exit', () => resolve())
      }),
      new Promise<void>(resolve => setTimeout(resolve, DEV_GRACEFUL_SHUTDOWN_MS)),
    ])
  }
  await startup()
}

// 复制 shell-ast WASM 到 dist-electron（与 jieba 同理；否则打包后找不到 .wasm → 审计 Fail-Closed）
function copyShellAstWasm() {
  return {
    name: 'copy-shell-ast-wasm',
    closeBundle() {
      const srcPath = resolve(__dirname, 'node_modules/@questi0nm4rk/shell-ast/dist/shell-ast.wasm')
      const destDir = resolve(__dirname, 'dist-electron')
      const destPath = resolve(destDir, 'shell-ast.wasm')
      if (existsSync(srcPath)) {
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
        copyFileSync(srcPath, destPath)
        console.log('[copy-shell-ast-wasm] Copied shell-ast.wasm to dist-electron')
      }
    },
  }
}

// 编程技能改后语法检查：tree-sitter 底座 + 用到的语法 wasm（整包三十多种，只带表里那几种）
function copyTreeSitterWasm() {
  return {
    name: 'copy-tree-sitter-wasm',
    closeBundle() {
      const destDir = resolve(__dirname, 'dist-electron', BUNDLED_WASM_DIR)
      const files: Array<[string, string]> = [
        [resolve(__dirname, 'node_modules/web-tree-sitter/tree-sitter.wasm'), 'tree-sitter.wasm'],
        ...BUNDLED_GRAMMARS.map((name): [string, string] => [
          resolve(__dirname, `node_modules/tree-sitter-wasms/out/tree-sitter-${name}.wasm`),
          `tree-sitter-${name}.wasm`,
        ]),
      ]
      mkdirSync(destDir, { recursive: true })
      for (const [src, name] of files) {
        if (!existsSync(src)) throw new Error(`[copy-tree-sitter-wasm] missing ${src}`)
        copyFileSync(src, resolve(destDir, name))
      }
      console.log(`[copy-tree-sitter-wasm] Copied ${files.length} wasm files to dist-electron/${BUNDLED_WASM_DIR}`)
    },
  }
}

// 复制 pwsh-extract.ps1 到 dist-electron（PowerShell AST 审计脚本）
function copyPwshExtractScript() {
  return {
    name: 'copy-pwsh-extract-ps1',
    closeBundle() {
      const srcPath = resolve(__dirname, 'electron/services/agent/command-audit/pwsh-extract.ps1')
      const destDir = resolve(__dirname, 'dist-electron/services/agent/command-audit')
      const destPath = resolve(destDir, 'pwsh-extract.ps1')
      if (existsSync(srcPath)) {
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
        copyFileSync(srcPath, destPath)
        console.log('[copy-pwsh-extract-ps1] Copied pwsh-extract.ps1 to dist-electron')
      }
    },
  }
}

function copyJiebaWasm() {
  return {
    name: 'copy-jieba-wasm',
    closeBundle() {
      const srcPath = resolve(__dirname, 'node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm_bg.wasm')
      const destDir = resolve(__dirname, 'dist-electron')
      const destPath = resolve(destDir, 'jieba_rs_wasm_bg.wasm')
      
      if (existsSync(srcPath)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcPath, destPath)
        console.log('[copy-jieba-wasm] Copied jieba_rs_wasm_bg.wasm to dist-electron')
      }

    }
  }
}

// 复制 speech-worker.js 到 dist-electron
function copySpeechWorker() {
  return {
    name: 'copy-speech-worker',
    closeBundle() {
      const srcPath = resolve(__dirname, 'electron/services/speech/speech-worker.js')
      const destDir = resolve(__dirname, 'dist-electron/services/speech')
      const destPath = resolve(destDir, 'speech-worker.js')
      
      if (existsSync(srcPath)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcPath, destPath)
        console.log('[copy-speech-worker] Copied speech-worker.js to dist-electron')
      }
    }
  }
}

// 复制 pdf-worker.js / pdfjs-config.js 到 dist-electron/services
function copyPdfWorker() {
  return {
    name: 'copy-pdf-worker',
    closeBundle() {
      const destDir = resolve(__dirname, 'dist-electron/services')
      const files = ['pdf-worker.js', 'pdfjs-config.mjs', 'pdf-text-extract.mjs']
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true })
      }
      for (const file of files) {
        const srcPath = resolve(__dirname, 'electron/services', file)
        const destPath = resolve(destDir, file)
        if (existsSync(srcPath)) {
          copyFileSync(srcPath, destPath)
        }
      }
      console.log('[copy-pdf-worker] Copied pdf-worker.js, pdfjs-config.mjs, pdf-text-extract.mjs to dist-electron')
    }
  }
}

// 复制 embedding-worker.js 到 dist-electron/services/knowledge
function copyEmbeddingWorker() {
  return {
    name: 'copy-embedding-worker',
    closeBundle() {
      const destDir = resolve(__dirname, 'dist-electron/services/knowledge')
      const files = ['embedding-worker.js', 'ort-native.js']
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true })
      }
      const copied: string[] = []
      for (const name of files) {
        const srcPath = resolve(__dirname, 'electron/services/knowledge', name)
        if (!existsSync(srcPath)) {
          throw new Error(`[copy-embedding-worker] 缺少 ${srcPath}`)
        }
        copyFileSync(srcPath, resolve(destDir, name))
        copied.push(name)
      }
      console.log(`[copy-embedding-worker] Copied ${copied.join(', ')} to dist-electron`)
    }
  }
}

// 复制 chart-maps GeoJSON 到 public/（前端 fetch）和 dist/chart-maps（生产构建）
function copyChartMaps() {
  return {
    name: 'copy-chart-maps',
    configureServer(server: ViteDevServer) {
      const src = resolve(__dirname, 'resources/chart-maps')
      const dest = resolve(__dirname, 'public/chart-maps')
      if (!existsSync(src)) return
      const { cpSync } = require('fs') as typeof import('fs')
      cpSync(src, dest, { recursive: true })
      server.watcher.add(src)
      server.watcher.on('change', (file: string) => {
        if (file.startsWith(src)) {
          cpSync(src, dest, { recursive: true })
        }
      })
    },
    closeBundle() {
      const src = resolve(__dirname, 'resources/chart-maps')
      const publicDest = resolve(__dirname, 'public/chart-maps')
      const distDest = resolve(__dirname, 'dist/chart-maps')
      if (!existsSync(src)) return
      const { cpSync } = require('fs') as typeof import('fs')
      cpSync(src, publicDest, { recursive: true })
      cpSync(src, distDest, { recursive: true })
      console.log('[copy-chart-maps] Copied chart-maps to public/ and dist/')
    }
  }
}

// 复制 lancedb-worker.js 到 dist-electron/services/knowledge
function copyLanceDBWorker() {
  return {
    name: 'copy-lancedb-worker',
    closeBundle() {
      const srcPath = resolve(__dirname, 'electron/services/knowledge/lancedb-worker.js')
      const destDir = resolve(__dirname, 'dist-electron/services/knowledge')
      const destPath = resolve(destDir, 'lancedb-worker.js')

      if (existsSync(srcPath)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcPath, destPath)
        console.log('[copy-lancedb-worker] Copied lancedb-worker.js to dist-electron')
      }
    }
  }
}

// Steam 构建标识：用全局常量注入，dev/build 均生效（不依赖 import.meta.env 在 dev 下的注入）
const isSteamBuild = process.env.VITE_STEAM_BUILD === 'true'
if (isSteamBuild) {
  console.log('[vite] Steam build: __STEAM_BUILD__=true')
}
export default defineConfig({
  server: {
    warmup: {
      clientFiles: [
        './src/components/AiPanel.vue',
        './src/composables/useAgentMode.ts',
        './src/composables/useMarkdown.ts',
      ]
    }
  },
  define: {
    __STEAM_BUILD__: isSteamBuild
  },
  plugins: [
    optionalOemConfig(),
    vue({
      template: {
        compilerOptions: {
          // Electron <webview>：产出物面板 HTML/URL 预览用，按原生自定义元素渲染
          isCustomElement: (tag) => tag === 'webview'
        }
      }
    }),
    copyChartMaps(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart({ startup }) {
          void restartElectronDev(startup)
        },
        vite: {
          define: {
            __STEAM_BUILD__: isSteamBuild
          },
          resolve: {
            alias: {
              '@shared/types': resolve(__dirname, 'packages/shared-types/src'),
              '@shared': resolve(__dirname, 'shared'),
              '@sailfish/workbench-assistant': resolve(__dirname, 'packages/workbench-assistant/src'),
            }
          },
          build: {
            outDir: 'dist-electron',
            emptyOutDir: true,  // 构建前清空输出目录，防止旧文件堆积
            minify: 'esbuild',
            rollupOptions: {
              external: [
                'node-pty', 
                'ssh2', 
                'electron-store',
                '@huggingface/transformers',
                '@lancedb/lancedb',
                'apache-arrow',
                'keytar',
                'imapflow',
                'nodemailer',
                'mailparser',
                'playwright-core',
                'onnxruntime-node',
                'sherpa-onnx-node',
                'dingtalk-stream',
                '@larksuiteoapi/node-sdk',
                // ws 的可选原生加速依赖。rollup 打包 ws 时会把 try { require('bufferutil') }
                // 转成 throw new Error('Could not resolve "bufferutil"')，破坏原本的 try/catch。
                // 标记为 external 后 rollup 保留原样 require()，运行时由 ws 自行处理缺失情况。
                '@napi-rs/canvas',
                '@firecrawl/pdf-inspector',
                // sharp 是 native 模块，内部用 dynamic require 加载平台对应的 .node prebuild
                // (sharp-darwin-arm64v8.node / sharp-linux-x64.node / ...)，rollup 静态分析无法
                // 处理这种 dynamic require，会报 "Could not dynamically require ..."。
                // 列入 external 让 sharp 在运行时由 Node 直接 require，平台 prebuild 由
                // sharp 自身加载逻辑处理。
                'sharp',
                /^pdfjs-dist/,
                'bufferutil',
                'utf-8-validate',
                // jsdom + Readability 体积大且含大量子依赖，rollup 会拆成 api-*.js 等 hash chunk。
                // dev 热更新时 main 与 chunk hash 不同步会导致 Cannot find module './api-XXXX.js'。
                // 标记 external 后首次调用时从 node_modules 加载，与 web_fetch 的 lazy 策略一致。
                'jsdom',
                '@mozilla/readability',
                // shell-ast 含独立 .wasm，bundle 后 import.meta.url 路径偏移会加载失败
                '@questi0nm4rk/shell-ast',
              ]
            }
          },
          // esbuild 选项：charset: 'utf8' 保留中文等 UTF-8 字符，不转成 \xXX
          esbuild: {
            charset: 'utf8'
          },
          plugins: [optionalOemConfig(), copyJiebaWasm(), copyShellAstWasm(), copyTreeSitterWasm(), copyPwshExtractScript(), copySpeechWorker(), copyPdfWorker(), copyEmbeddingWorker(), copyLanceDBWorker()]
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          resolve: {
            alias: {
              '@shared/types': resolve(__dirname, 'packages/shared-types/src'),
              '@shared': resolve(__dirname, 'shared'),
              '@sailfish/workbench-assistant': resolve(__dirname, 'packages/workbench-assistant/src'),
            }
          },
          build: {
            outDir: 'dist-electron'
          },
          esbuild: {
            charset: 'utf8'
          }
        }
      },
      {
        entry: 'electron/artifact-preview-guest-preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false
          },
          esbuild: {
            charset: 'utf8'
          }
        }
      },
      // 打包态无头 CLI（ELECTRON_RUN_AS_NODE=1 加载 dist-electron/cli.js）
      {
        entry: 'electron/cli/cli.ts',
        vite: {
          define: {
            __STEAM_BUILD__: isSteamBuild
          },
          resolve: {
            alias: {
              '@shared/types': resolve(__dirname, 'packages/shared-types/src'),
              '@shared': resolve(__dirname, 'shared'),
              '@sailfish/workbench-assistant': resolve(__dirname, 'packages/workbench-assistant/src'),
            }
          },
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            minify: 'esbuild',
            rollupOptions: {
              external: [
                'electron',
                'node-pty',
                'ssh2',
                'electron-store',
                '@huggingface/transformers',
                '@lancedb/lancedb',
                'apache-arrow',
                'keytar',
                'imapflow',
                'nodemailer',
                'mailparser',
                'playwright-core',
                'onnxruntime-node',
                'sherpa-onnx-node',
                'dingtalk-stream',
                '@larksuiteoapi/node-sdk',
                '@napi-rs/canvas',
                '@firecrawl/pdf-inspector',
                'sharp',
                /^pdfjs-dist/,
                'bufferutil',
                'utf-8-validate',
                'jsdom',
                '@mozilla/readability',
                '@questi0nm4rk/shell-ast',
              ]
            }
          },
          esbuild: {
            charset: 'utf8'
          },
          plugins: [optionalOemConfig()]
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
      '@shared/types': resolve(__dirname, 'packages/shared-types/src'),
      '@shared': resolve(__dirname, 'shared'),
      '@sailfish/shared-types': resolve(__dirname, 'packages/shared-types/src/index.ts'),
      '@sailfish/workbench-sdk': resolve(__dirname, 'packages/workbench-sdk/src'),
      '@sailfish/workbench-assistant': resolve(__dirname, 'packages/workbench-assistant/src'),
      '@sailfish/workbench-sample': resolve(__dirname, 'packages/workbench-sample/src'),
      '@sailfish/workbench-local': resolve(__dirname, 'packages/workbench-local/src'),
      '@sailfish/workbench-ssh': resolve(__dirname, 'packages/workbench-ssh/src'),
      '@sailfish/workbench-companion': resolve(__dirname, 'packages/workbench-companion/src'),
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'file-manager': resolve(__dirname, 'file-manager.html'),
        'ai-debug': resolve(__dirname, 'ai-debug.html'),
        'llm-bench': resolve(__dirname, 'llm-bench.html')
      }
    }
  },
  // 保留 UTF-8 字符，不转换成 \xXX 格式
  esbuild: {
    charset: 'utf8'
  },
  // Web Worker 配置
  worker: {
    format: 'es',
    plugins: () => []
  },
  // 优化依赖
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],  // 让 transformers.js 在 worker 中正确加载
    include: ['virtua']
  }
})

