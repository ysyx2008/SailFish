import { describe, expect, it } from 'vitest'
import { formatMcpServerDetail } from './executor'
import type { McpServerConfig } from '@shared/types'

function server(partial: Partial<McpServerConfig> & Pick<McpServerConfig, 'transport'>): McpServerConfig {
  return {
    id: 'srv',
    name: '示例',
    enabled: true,
    ...partial,
  }
}

describe('formatMcpServerDetail', () => {
  it('只报告环境变量的项数，不写出内容', () => {
    const text = formatMcpServerDetail(server({
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'secret-value', OTHER: 'also-secret' },
    }), 0)

    expect(text).toContain('env: _(已配置 2 项)_')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('also-secret')
    expect(text).not.toContain('API_TOKEN')
  })

  it('没有环境变量时不提 env', () => {
    const text = formatMcpServerDetail(server({
      transport: 'stdio',
      command: 'npx',
    }), 0)

    expect(text).not.toContain('env:')
  })

  it('请求头仍只报告项数', () => {
    const text = formatMcpServerDetail(server({
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret-header' },
    }), 0)

    expect(text).toContain('headers: _(已配置 1 项)_')
    expect(text).not.toContain('secret-header')
    expect(text).not.toContain('Authorization')
  })
})
