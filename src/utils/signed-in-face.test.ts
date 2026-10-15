import { describe, expect, it } from 'vitest'
import { signedInFace } from './signed-in-face'

describe('signedInFace', () => {
  it('没有登录的人时不换脸', () => {
    expect(signedInFace(null)).toBeNull()
    expect(signedInFace({ sub: '  ' })).toBeNull()
  })

  it('用登录拿到的名字，邮箱放下面，头像只收网页地址', () => {
    expect(signedInFace({
      sub: 'u1',
      name: ' 张三 ',
      email: 'zhang@corp.example',
      picture: 'https://corp.example/a.png',
    })).toEqual({
      name: '张三',
      email: 'zhang@corp.example',
      picture: 'https://corp.example/a.png',
    })
  })

  it('没有名字时用邮箱，邮箱不再重复一行；没有头像用空，留给第一个字', () => {
    expect(signedInFace({
      sub: 'u2',
      email: 'li@corp.example',
      picture: 'javascript:alert(1)',
    })).toEqual({
      name: 'li@corp.example',
      email: '',
      picture: '',
    })
  })
})
