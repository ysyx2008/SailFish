import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { IMPlatform } from '../im/types'

const persistedState: { imLastContacts: Record<string, unknown> } = {
  imLastContacts: {}
}

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: (key: string) => {
      if (key === 'imLastContacts') return persistedState.imLastContacts
      return undefined
    },
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'imLastContacts') persistedState.imLastContacts = value
    },
    hasVisionCapability: () => false,
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

import {
  IMService,
  type IMLastContact,
  isImDeliveryToolFailure,
  formatImDeliveryToolFailure,
  IM_SKIP_PROCESS_NOTIFY_TOOLS,
  prepareImAgentMedia,
} from '../im/im.service'

type MockAdapter = {
  isConnected: ReturnType<typeof vi.fn>
  sendText: ReturnType<typeof vi.fn>
  sendMarkdown: ReturnType<typeof vi.fn>
  sendFile: ReturnType<typeof vi.fn>
}

function createContact(platform: IMPlatform, updatedAt: number): IMLastContact {
  return {
    platform,
    replyContext: { chatId: `${platform}-chat` },
    userId: 'user-1',
    userName: 'single-user',
    chatId: `${platform}-chat`,
    chatType: 'single',
    updatedAt
  }
}

function createAdapter(connected: boolean): MockAdapter {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined)
  }
}

describe('IM_SKIP_PROCESS_NOTIFY_TOOLS', () => {
  it('excludes self-delivering tools from process notifications', () => {
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('talk_to_user')).toBe(true)
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('ask_user')).toBe(true)
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('load_skill')).toBe(false)
  })
})

describe('IM delivery tool failure helpers', () => {
  it('detects send_file_to_chat failure by success flag', () => {
    expect(isImDeliveryToolFailure({
      toolName: 'send_file_to_chat',
      success: false,
      content: '❌ 文件发送失败',
    })).toBe(true)
  })

  it('ignores unrelated tool failures', () => {
    expect(isImDeliveryToolFailure({
      toolName: 'read_file',
      success: false,
      content: '❌',
    })).toBe(false)
  })

  it('formatImDeliveryToolFailure prefers step content', () => {
    expect(formatImDeliveryToolFailure({
      toolName: 'send_file_to_chat',
      content: '❌ 文件发送失败: errcode=-2',
      toolResult: 'ignored',
    })).toBe('❌ 文件发送失败: errcode=-2')
  })
})

describe('prepareImAgentMedia', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeTempFile(name: string, data: Buffer | string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-media-'))
    tmpDirs.push(dir)
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, data)
    return filePath
  }

  it('inlines vision images as data URLs and keeps file path metadata', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02])
    const localPath = writeTempFile('wechat_image.jpg', jpeg)

    const result = await prepareImAgentMedia([{
      type: 'image',
      localPath,
      fileName: 'wechat_image.jpg',
    }])

    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.previewImages).toEqual(result.images)
    expect(result.attachments).toEqual([{
      filename: 'wechat_image.jpg',
      filePath: localPath,
      fileSize: jpeg.length,
      fileType: 'jpg',
    }])
    expect(result.consumedPaths.has(localPath)).toBe(true)
    expect(result.documentContext).toBeUndefined()
  })

  it('parses text documents into documentContext', async () => {
    const localPath = writeTempFile('notes.txt', 'passive voice exercises')

    const result = await prepareImAgentMedia([{
      type: 'file',
      localPath,
      fileName: 'notes.txt',
    }])

    expect(result.images).toHaveLength(0)
    expect(result.documentContext).toContain('<sf_uploaded_docs>')
    expect(result.documentContext).toContain('passive voice exercises')
    expect(result.documentContext).toContain('notes.txt')
    expect(result.attachments).toEqual([{
      filename: 'notes.txt',
      filePath: localPath,
      fileSize: Buffer.byteLength('passive voice exercises'),
      fileType: 'txt',
      totalPages: undefined,
      previewPages: undefined,
    }])
    expect(result.consumedPaths.has(localPath)).toBe(true)
  })

  it('keeps non-parseable binary media as attachment chips', async () => {
    const localPath = writeTempFile('voice.silk', Buffer.from([0x01, 0x02, 0x03, 0x04]))

    const result = await prepareImAgentMedia([{
      type: 'audio',
      localPath,
      fileName: 'voice.silk',
    }])

    expect(result.images).toHaveLength(0)
    expect(result.documentContext).toBeUndefined()
    expect(result.attachments).toEqual([{
      filename: 'voice.silk',
      filePath: localPath,
      fileSize: 4,
      fileType: 'silk',
    }])
    expect(result.consumedPaths.size).toBe(0)
  })

  it('falls back to attachment chip when image file is missing', async () => {
    const missing = path.join(os.tmpdir(), `im-missing-${Date.now()}.png`)

    const result = await prepareImAgentMedia([{
      type: 'image',
      localPath: missing,
      fileName: 'gone.png',
    }])

    expect(result.images).toHaveLength(0)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe('gone.png')
    expect(result.consumedPaths.size).toBe(0)
  })

  it('parses new-format WPS writer attachments into documentContext', async () => {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
    )
    zip.file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
    )
    zip.file('word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>IM里的WPS正文</w:t></w:r></w:p></w:body></w:document>'
    )
    const localPath = writeTempFile('纪要.wps', await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await prepareImAgentMedia([{
      type: 'file',
      localPath,
      fileName: '纪要.wps',
    }])

    expect(result.documentContext).toContain('IM里的WPS正文')
    expect(result.documentContext).toContain('纪要.wps')
    expect(result.consumedPaths.has(localPath)).toBe(true)
  })

  it('parses new-format WPS spreadsheet attachments into documentContext', async () => {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('销售')
    sheet.addRow(['品名', '数量'])
    sheet.addRow(['苹果', 12])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-media-'))
    tmpDirs.push(dir)
    const localPath = path.join(dir, '销售.et')
    await workbook.xlsx.writeFile(localPath)

    const result = await prepareImAgentMedia([{
      type: 'file',
      localPath,
      fileName: '销售.et',
    }])

    expect(result.documentContext).toContain('苹果')
    expect(result.documentContext).toContain('销售.et')
    expect(result.consumedPaths.has(localPath)).toBe(true)
  })

  it('does not treat legacy WPS binary as readable document text', async () => {
    const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00])
    const localPath = writeTempFile('旧稿.wps', ole)

    const result = await prepareImAgentMedia([{
      type: 'file',
      localPath,
      fileName: '旧稿.wps',
    }])

    const documentContext = result.documentContext ?? ''
    expect(documentContext).not.toContain('\0')
    expect(documentContext).not.toMatch(/ÐÏ/)
    expect(result.documentContext ?? '').toMatch(/另存为 Word|WPS/)
  })
})

describe('IMService proactive notification routing', () => {
  beforeEach(() => {
    persistedState.imLastContacts = {}
    vi.clearAllMocks()
  })

  it('上次是钉钉但当前仅飞书在线时，应自动切换到飞书发送', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(false)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 5_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('feishu')
    expect(feishuAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(dingtalkAdapter.sendText).not.toHaveBeenCalled()
  })

  it('lastContact 平台在线时应优先该平台，不跨渠道跳转', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(true)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 1_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('dingtalk')
    expect(dingtalkAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(feishuAdapter.sendText).not.toHaveBeenCalled()
  })
})

describe('IMService sendFileToChannel / getChannelSendTargets', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    persistedState.imLastContacts = {}
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeTempFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-send-'))
    tmpDirs.push(dir)
    const filePath = path.join(dir, 'report.md')
    fs.writeFileSync(filePath, '# report')
    return filePath
  }

  it('文件不存在时直接报错，不触碰适配器', async () => {
    const service = new IMService() as any
    const adapter = createAdapter(true)
    service.dingtalkAdapter = adapter
    service.contactsByPlatform = { dingtalk: createContact('dingtalk', Date.now()) }

    const result = await service.sendFileToChannel('dingtalk', '/nonexistent/file.md')

    expect(result.success).toBe(false)
    expect(result.error).toBe('File not found')
    expect(adapter.sendFile).not.toHaveBeenCalled()
  })

  it('渠道未连接时报错', async () => {
    const service = new IMService() as any
    service.dingtalkAdapter = createAdapter(false)
    service.contactsByPlatform = { dingtalk: createContact('dingtalk', Date.now()) }

    const result = await service.sendFileToChannel('dingtalk', writeTempFile())

    expect(result.success).toBe(false)
    expect(result.error).toBe('Channel not connected')
  })

  it('渠道无会话上下文时报错', async () => {
    const service = new IMService() as any
    service.dingtalkAdapter = createAdapter(true)
    service.contactsByPlatform = {}

    const result = await service.sendFileToChannel('dingtalk', writeTempFile())

    expect(result.success).toBe(false)
    expect(result.error).toBe('No conversation on this channel yet')
  })

  it('成功时发到该渠道联系人的 replyContext，并刷新 lastContact', async () => {
    const service = new IMService() as any
    const adapter = createAdapter(true)
    service.dingtalkAdapter = adapter
    const contact = createContact('dingtalk', Date.now())
    service.contactsByPlatform = { dingtalk: contact }
    const filePath = writeTempFile()

    const result = await service.sendFileToChannel('dingtalk', filePath)

    expect(result.success).toBe(true)
    expect(adapter.sendFile).toHaveBeenCalledWith(contact.replyContext, filePath, undefined)
    expect(service.lastContact).toBe(contact)
  })

  it('投递失败时保留联系人（瞬时故障不清会话）', async () => {
    const service = new IMService() as any
    const adapter = createAdapter(true)
    adapter.sendFile.mockRejectedValue(new Error('network timeout'))
    service.dingtalkAdapter = adapter
    const contact = createContact('dingtalk', Date.now())
    service.contactsByPlatform = { dingtalk: contact }
    service.lastContact = contact

    const result = await service.sendFileToChannel('dingtalk', writeTempFile())

    expect(result.success).toBe(false)
    expect(result.error).toBe('network timeout')
    // 联系人保留：无法区分会话失效与瞬时错误，误删会让用户平白回到「无会话」
    expect(service.contactsByPlatform.dingtalk).toBe(contact)
    expect(service.lastContact).toBe(contact)
  })

  it('getChannelSendTargets 返回六渠道三态', () => {
    const service = new IMService() as any
    service.dingtalkAdapter = createAdapter(true)
    service.feishuAdapter = createAdapter(true)
    service.slackAdapter = createAdapter(false)
    service.contactsByPlatform = { dingtalk: createContact('dingtalk', Date.now()) }

    const targets = service.getChannelSendTargets() as Array<{
      platform: string
      connected: boolean
      hasContact: boolean
      contactName?: string
    }>

    expect(targets.map(t => t.platform)).toEqual(['dingtalk', 'feishu', 'slack', 'telegram', 'wecom', 'wechat'])
    const byPlatform = Object.fromEntries(targets.map(t => [t.platform, t]))
    expect(byPlatform.dingtalk).toMatchObject({ connected: true, hasContact: true, contactName: 'single-user' })
    expect(byPlatform.feishu).toMatchObject({ connected: true, hasContact: false })
    expect(byPlatform.slack).toMatchObject({ connected: false, hasContact: false })
    expect(byPlatform.wechat).toMatchObject({ connected: false, hasContact: false })
  })

  it('getChannelSendTargets 把可发/已连接渠道排在未连接之前', () => {
    const service = new IMService() as any
    // wecom 可直发（连接+会话）、telegram 已连接无会话，其余未连接
    service.wecomAdapter = createAdapter(true)
    service.telegramAdapter = createAdapter(true)
    service.contactsByPlatform = { wecom: createContact('wecom', Date.now()) }

    const targets = service.getChannelSendTargets() as Array<{ platform: string }>
    expect(targets.map(t => t.platform)).toEqual(['wecom', 'telegram', 'dingtalk', 'feishu', 'slack', 'wechat'])
  })

  it('userName 回退为 userId 时 contactName 不展示内部 ID', () => {
    const service = new IMService() as any
    service.wechatAdapter = createAdapter(true)
    // 微信协议无昵称字段，适配器把 userName 回退成 userId
    service.contactsByPlatform = {
      wechat: { ...createContact('wechat', Date.now()), userId: 'o9cq8xyz', userName: 'o9cq8xyz' }
    }

    const targets = service.getChannelSendTargets() as Array<{ platform: string; contactName?: string }>
    const wechat = targets.find(t => t.platform === 'wechat')
    expect(wechat?.contactName).toBeUndefined()
  })

  it('微信软失败后 hasContact 为 false，回到无会话', () => {
    const service = new IMService() as any
    service.wechatAdapter = createAdapter(true)
    const wechat = createContact('wechat', Date.now())
    const dingtalk = createContact('dingtalk', Date.now() - 1000)
    service.contactsByPlatform = { wechat, dingtalk }
    service.lastContact = wechat

    service.notifyWechatSoftSendFailure('user-1')

    const targets = service.getChannelSendTargets() as Array<{ platform: string; hasContact: boolean }>
    expect(targets.find(t => t.platform === 'wechat')?.hasContact).toBe(false)
    expect(service.contactsByPlatform.wechat).toBeUndefined()
    expect(service.lastContact).toBe(dingtalk)
  })

  it('联系人过期后 hasContact 为 false 且发送被拒绝', async () => {
    const service = new IMService() as any
    const adapter = createAdapter(true)
    service.dingtalkAdapter = adapter
    // CONTACT_TTL_MS 为 30 天，构造 31 天前的联系人
    service.contactsByPlatform = { dingtalk: createContact('dingtalk', Date.now() - 31 * 24 * 3600_000) }

    const targets = service.getChannelSendTargets() as Array<{ platform: string; hasContact: boolean }>
    expect(targets.find(t => t.platform === 'dingtalk')?.hasContact).toBe(false)

    const result = await service.sendFileToChannel('dingtalk', writeTempFile())
    expect(result.success).toBe(false)
    expect(result.error).toBe('No conversation on this channel yet')
    expect(adapter.sendFile).not.toHaveBeenCalled()
  })
})

describe('IMService 插件 adapter 注册事务性', () => {
  function makePluginAdapter(platform: string) {
    return {
      platform,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isConnected: () => false,
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined)
    }
  }

  it('回调绑定失败（冻结对象）：抛错且不占用 platform，同 platform 可立即再次注册', () => {
    const service = new IMService() as any
    const frozen = Object.freeze(makePluginAdapter('plug-frozen'))

    expect(() => service.registerAdapter(frozen)).toThrow()

    // 注册失败不留孤儿：platform 未被占用，正常 adapter 可立即注册
    const normal = makePluginAdapter('plug-frozen')
    expect(service.registerAdapter(normal)).toBe(true)
    expect(service.pluginAdapters.get('plug-frozen')).toBe(normal)
  })

  it('部分绑定失败（onConnectionChange 只读）：抛错、已绑定的 onMessage 被尽力解绑、platform 可重注册', () => {
    const service = new IMService() as any
    const partial = makePluginAdapter('plug-readonly') as any
    Object.defineProperty(partial, 'onConnectionChange', { get: () => undefined, configurable: false })

    expect(() => service.registerAdapter(partial)).toThrow()
    // onMessage 已成功绑定，失败分支尽力解绑
    expect(partial.onMessage).toBeNull()

    const normal = makePluginAdapter('plug-readonly')
    expect(service.registerAdapter(normal)).toBe(true)
  })

  it('unregisterAdapter：回调解绑抛错（注册后自我变异）不阻止 stop 与移除', async () => {
    const service = new IMService() as any
    const adapter = makePluginAdapter('plug-mutant') as any
    expect(service.registerAdapter(adapter)).toBe(true)

    // 注册成功后把 onMessage 换成只读属性，模拟自我变异的插件对象
    Object.defineProperty(adapter, 'onMessage', { get: () => undefined, configurable: false })

    await expect(service.unregisterAdapter(adapter)).resolves.toBeUndefined()
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(service.pluginAdapters.has('plug-mutant')).toBe(false)
  })
})
