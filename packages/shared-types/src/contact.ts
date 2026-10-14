/**
 * 本地联系人（contact 技能）共享类型
 * 存储：`{userData}/agent-workspace/CONTACTS.json`
 *
 * 只记「这是谁、怎么联系」。交往经过放 note，不拆成往来记录。
 */

export type ContactKind = 'person' | 'org'

export type ContactChannelKind = 'email' | 'phone' | 'im'

export interface ContactChannel {
  kind: ContactChannelKind
  value: string
  /** im 渠道名，如 wecom / dingtalk / feishu；不限定枚举 */
  platform?: string
  label?: string
}

export interface Contact {
  /** UUID，工具生成 */
  id: string
  name: string
  /** 别名、简称，如「沈总」 */
  aliases?: string[]
  /** 缺省 person */
  kind: ContactKind
  organization?: string
  role?: string
  channels?: ContactChannel[]
  /** 自由备注：关系、近况，不拆字段 */
  note?: string
  /** ISO 8601，工具填写，不可改 */
  createdAt: string
  /** 每次修改自动更新 */
  updatedAt: string
}

export interface ContactStoreData {
  version: 1
  contacts: Contact[]
  updatedAt: number
}

export interface ContactCreateInput {
  name: string
  aliases?: string[]
  kind?: ContactKind
  organization?: string
  role?: string
  note?: string
  channels?: ContactChannel[]
}

/** 字符串传空或 null 即清空；add/remove 系列在原有基础上增减 */
export interface ContactUpdatePatch {
  name?: string
  kind?: ContactKind
  organization?: string | null
  role?: string | null
  note?: string | null
  aliases?: string[] | null
  addAliases?: string[]
  channels?: ContactChannel[] | null
  addChannels?: ContactChannel[]
  removeChannels?: Array<{ kind: ContactChannelKind, value: string }>
}

/** 姓名或别名与已有联系人重合时不写入，带回重合的那些 */
export interface ContactCollision {
  type: 'collision'
  collisions: Contact[]
}

export interface ContactMissing {
  type: 'missing'
}

export type ContactAddResult = { type: 'created', contact: Contact } | ContactCollision

export type ContactUpdateResult = { type: 'updated', contact: Contact } | ContactMissing | ContactCollision

export type ContactDeleteResult = { type: 'deleted', contact: Contact } | ContactMissing

/** 把 source 并进 target：target 保留，source 删除 */
export type ContactMergeResult =
  | { type: 'merged', contact: Contact, removed: Contact }
  | ContactMissing
  | ContactCollision
  | { type: 'same' }
