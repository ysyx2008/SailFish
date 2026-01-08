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

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
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
                'playwright-core'
              ]
            }
          },
          // esbuild 选项：charset: 'utf8' 保留中文等 UTF-8 字符，不转成 \xXX
          esbuild: {
            charset: 'utf8'
          },
          plugins: [copyJiebaWasm()]
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
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
      '@electron': resolve(__dirname, 'electron')
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
  }
})

