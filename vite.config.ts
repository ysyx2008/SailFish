import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'

// 复制 jieba-wasm 的 WASM 文件到 dist-electron
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

// Steam 构建标识：用全局常量注入，dev/build 均生效（不依赖 import.meta.env 在 dev 下的注入）
const isSteamBuild = process.env.VITE_STEAM_BUILD === 'true'
if (isSteamBuild) {
  console.log('[vite] Steam build: __STEAM_BUILD__=true')
}
export default defineConfig({
  define: {
    __STEAM_BUILD__: isSteamBuild
  },
  plugins: [
    vue(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          define: {
            __STEAM_BUILD__: isSteamBuild
          },
          resolve: {
            alias: {
              '@shared': resolve(__dirname, 'shared')
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
                '@xenova/transformers',
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
                'bufferutil',
                'utf-8-validate'
              ]
            }
          },
          // esbuild 选项：charset: 'utf8' 保留中文等 UTF-8 字符，不转成 \xXX
          esbuild: {
            charset: 'utf8'
          },
          plugins: [copyJiebaWasm(), copySpeechWorker()]
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
              '@shared': resolve(__dirname, 'shared')
            }
          },
          build: {
            outDir: 'dist-electron'
          },
          esbuild: {
            charset: 'utf8'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
      '@shared': resolve(__dirname, 'shared')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'file-manager': resolve(__dirname, 'file-manager.html'),
        'ai-debug': resolve(__dirname, 'ai-debug.html')
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
    exclude: ['@xenova/transformers']  // 让 transformers.js 在 worker 中正确加载
  }
})

