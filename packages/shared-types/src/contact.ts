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
