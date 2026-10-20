import { describe, expect, it } from 'vitest'
import { describeSecretField } from './secret-field'

const KEY = 'sk-abcdefghijklmnop1234'
// KEY 共 23 位：头 3 + 中间 16 个圆点 + 尾 4
const MASKED = 'sk-••••••••••••••••1234'

const base = { value: '', focused: false, revealed: false }

describe('describeSecretField', () => {
  describe('填了密钥', () => {
    it('平时：只读，里面是遮盖后的文本，明文不进输入框', () => {
      const v = describeSecretField({ ...base, value: KEY })
      expect(v).toMatchObject({ inputType: 'text', shown: MASKED, readonly: true })
      expect(v.shown).not.toContain('abcdefghijklmnop')
    })

    it('聚焦（要改）：换成真实内容，一个字符一个圆点，可编辑', () => {
      expect(describeSecretField({ ...base, value: KEY, focused: true })).toMatchObject({
        inputType: 'password',
        shown: KEY,
        readonly: false,
      })
    })

    it('点了眼睛：明文，可编辑', () => {
      expect(describeSecretField({ ...base, value: KEY, revealed: true })).toMatchObject({
        inputType: 'text',
        shown: KEY,
        readonly: false,
      })
    })

    it('点开眼睛时不管有没有聚焦，都是明文', () => {
      const v = describeSecretField({ ...base, value: KEY, revealed: true, focused: true })
      expect(v).toMatchObject({ inputType: 'text', shown: KEY })
    })

    it('太短的密钥平时一位都不露，全是圆点，长度和原来一样', () => {
      expect(describeSecretField({ ...base, value: 'short' }).shown).toBe('•••••')
    })
  })

  describe('没填密钥', () => {
    it('也没有沿用：空框，可直接填，占位用传进来的文字', () => {
      expect(describeSecretField({ ...base, placeholder: 'API Key' })).toEqual({
        inputType: 'password',
        shown: '',
        readonly: false,
        placeholder: 'API Key',
        showsReused: false,
      })
    })

    it('沿用着别处的密钥：框是空的，占位里是遮盖后的那一把，和自己填的一样', () => {
      const filled = describeSecretField({ ...base, value: KEY })
      const reused = describeSecretField({ ...base, reusedValue: KEY, placeholder: 'API Key' })
      expect(reused.shown).toBe('')
      expect(reused.readonly).toBe(false)
      expect(reused.showsReused).toBe(true)
      expect(reused.placeholder).toBe(filled.shown)
    })

    it('沿用时点了眼睛：占位里是那一把的全文', () => {
      const v = describeSecretField({ ...base, reusedValue: KEY, revealed: true })
      expect(v).toMatchObject({ inputType: 'text', placeholder: KEY, shown: '' })
    })

    it('沿用时遮住，占位里不出现明文', () => {
      const v = describeSecretField({ ...base, reusedValue: KEY })
      expect(v.placeholder).not.toContain('abcdefghijklmnop')
    })

    it('只填了空白，等于没填：框是空的，沿用的那一把照常显示', () => {
      const v = describeSecretField({ ...base, value: '   ', reusedValue: KEY, placeholder: 'API Key' })
      expect(v).toMatchObject({ shown: '', showsReused: true, placeholder: MASKED })
    })

    it('用户自己填了，就不再显示沿用的那一把', () => {
      const v = describeSecretField({ ...base, value: 'my-own-key-abcdefgh9999', reusedValue: KEY })
      expect(v.showsReused).toBe(false)
      expect(v.shown).toBe('my-••••••••••••••••9999')
    })
  })
})
