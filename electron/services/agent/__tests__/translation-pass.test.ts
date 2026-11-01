import { expect, it, vi } from 'vitest'
import { createTranslator, setConfigService, t } from '../i18n'
import { renderBoard } from '../tools/organization-text'

it('一次批量排版只读一次语言，不跨批次缓存，切换语言立即生效', () => {
  let language = 'zh-CN'
  const getLanguage = vi.fn(() => language)
  setConfigService({ getLanguage } as never)
  const translate = createTranslator()
  for (let i = 0; i < 1000; i++) expect(translate('dispatch.status_completed')).toBe('已完成')
  expect(getLanguage).toHaveBeenCalledTimes(1)
  language = 'en-US'
  expect(t('dispatch.status_completed')).toBe('done')
  expect(createTranslator()('dispatch.status_completed')).toBe('done')
  expect(getLanguage).toHaveBeenCalledTimes(3)
})

it('百个小组的看板也只读一次语言，保留全部小组及验收结果', () => {
  const getLanguage = vi.fn(() => 'zh-CN')
  setConfigService({ getLanguage } as never)
  const board = renderBoard([{ owner: '负责人', depth: 1, rows: [], teams: Array.from({ length: 100 }, (_, i) => ({ name: `小组${i}`, review: 'pass', reviewers: ['核对员'] })) }], { live: 0, total: 100 })
  expect(board).toContain('小组99')
  expect(board).toContain('核对员')
  expect(getLanguage).toHaveBeenCalledTimes(1)
})
