import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['electron/services/agent/**/*.ts'],
      exclude: ['**/*.test.ts', '**/types.ts', '**/i18n.ts']
    }
  },
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
  }
})
