import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPageNodeImports, pageOemRuntimeSource } from '../../scripts/page-no-node'

const ROOT = path.resolve(__dirname, '../..')

describe('页面不能引用 Node', () => {
  it('现在的页面引用图里没有 Node', () => {
    expect(findPageNodeImports(ROOT)).toEqual([])
  })

  it('交给页面的 OEM 入口不探测磁盘', () => {
    const source = pageOemRuntimeSource(ROOT).source
    expect(source).not.toContain('require')
    expect(source).not.toContain('node:')
  })

  it('页面引用了会碰 Node 的 shared，要报出整条链', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="/main.ts"></script>',
      'main.ts': `import { inside } from './shared/uses-node'\n`,
      'shared/uses-node.ts': `import * as path from 'path'\nexport const inside = path.resolve\n`,
    })
    const found = findPageNodeImports(dir, ['page.html'])
    expect(found).toHaveLength(1)
    expect(found[0].entry).toBe('page.html')
    expect(found[0].specifier).toBe('path')
    expect(found[0].chain.map(file => path.relative(dir, file))).toEqual([
      'main.ts',
      path.join('shared', 'uses-node.ts'),
    ])
  })

  it('只重新导出类型时不把 Node 算进来', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `export { type Marker } from './shared/uses-node'\n`,
      'shared/uses-node.ts': `import * as path from 'path'\nexport type Marker = string\n`,
    })
    expect(findPageNodeImports(dir, ['page.html'])).toEqual([])
  })

  it('只引用类型时不把 Node 算进来', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `import type { Marker } from './shared/uses-node'\nexport const marker: Marker = 'ok'\n`,
      'shared/uses-node.ts': `import * as path from 'path'\nexport type Marker = string\nexport const resolved = path.resolve('.')\n`,
    })
    expect(findPageNodeImports(dir, ['page.html'])).toEqual([])
  })

  it('页面组件里的引用也算', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `import App from './App.vue'\n`,
      'App.vue': `<script setup lang="ts">\nimport { inside } from './uses-node'\n</script>\n`,
      'uses-node.ts': `import * as path from 'path'\nexport const inside = path.resolve\n`,
    })
    expect(findPageNodeImports(dir, ['page.html']).map(v => v.specifier)).toEqual(['path'])
  })

  it('动态 require 也算', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `const name = 'fs'\nrequire(name)\n`,
    })
    expect(findPageNodeImports(dir, ['page.html']).map(v => v.specifier)).toEqual(['动态 require'])
  })

  it('import type = require 不算引用', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `import type fs = require('node:fs')\nexport type Stats = fs.Stats\n`,
    })
    expect(findPageNodeImports(dir, ['page.html'])).toEqual([])
  })

  it('重新导出仍算引用', () => {
    const dir = fixture({
      'page.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `export { resolved } from './shared/bridge'\n`,
      'shared/bridge.ts': `export { resolved } from './uses-node'\n`,
      'shared/uses-node.ts': `import * as path from 'node:path'\nexport const resolved = path.resolve('.')\n`,
    })
    expect(findPageNodeImports(dir, ['page.html']).map(v => v.specifier)).toEqual(['node:path'])
  })
})

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-no-node-'))
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  return dir
}
