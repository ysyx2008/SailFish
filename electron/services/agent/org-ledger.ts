/**
 * 项目组织的账本：一场任务里，秘书和各位组长各有一份花名册，账本把它们串成一棵树。
 * 只在派出第一位组长时才有；没有组长的任务里没有账本，花名册照旧只看自己。
 *
 * 账本管三件全树共用的事：没做完的人数（保险丝）、名字不重复、按名字找到他在哪份花名册里。
 */
import type { SubAgentRoster } from './sub-agent-roster'

/** 秘书下面最多这么多层团：秘书派出的组长是第 1 层，他派出的组长是第 2 层，再往下第 3 层，到此为止 */
export const MAX_ORG_DEPTH = 3

/** 一位组长的座位：他在账本里的位置，开跑时据此建出自己的花名册 */
export interface LeadSeat {
  readonly ledger: OrgLedger
  readonly name: string
  /** 他名下的人在第几层团（秘书的花名册是第 0 层） */
  readonly depth: number
}

interface Node {
  owner?: string
  depth: number
}

export class OrgLedger {
  private readonly nodes = new Map<SubAgentRoster, Node>()
  private readonly listeners = new Set<() => void>()
  /** 订阅者回调里可能再通知（刷新步骤又触发进度），别递归转圈 */
  private notifying = false
  /** 已经退出账本的花名册名下的名字：他们的对话还在盘上，名字仍然占着 */
  private readonly retiredNames = new Set<string>()
  /** 退出账本之后还要认得的秘书那份花名册（组长比秘书收工得晚时，看板的最后一笔要找到它） */
  private rootRoster?: SubAgentRoster
  /** 每份花名册的主人向谁汇报：他所在的花名册退出以后，仍按退出前记着的算 */
  private readonly reportsToSeen = new Map<SubAgentRoster, string | undefined>()

  /** 组织里有人变了（任何一层）时通知；返回取消订阅 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  notify(): void {
    if (this.notifying) return
    this.notifying = true
    try {
      for (const listener of [...this.listeners]) {
        try { listener() } catch { /* 界面刷新失败不影响组织 */ }
      }
    } finally {
      this.notifying = false
    }
  }

  /** 同一位组长再次开跑时换了新的花名册，旧的先退出 */
  register(roster: SubAgentRoster, owner: string | undefined, depth: number): void {
    for (const [other, node] of this.nodes) {
      if (other !== roster && node.owner === owner && node.depth === depth) this.unregister(other)
    }
    this.nodes.set(roster, { owner, depth })
    if (depth === 0) this.rootRoster = roster
  }

  unregister(roster: SubAgentRoster): void {
    if (!this.nodes.delete(roster)) return
    for (const name of roster.memberNames()) this.retiredNames.add(name)
  }

  /** 全树没做完的人数 */
  liveCount(): number {
    let n = 0
    for (const roster of this.nodes.keys()) n += roster.liveCount()
    return n
  }

  /** 全树现在名册里的名字 */
  usedNames(): Set<string> {
    const names = new Set<string>()
    for (const roster of this.nodes.keys()) {
      for (const name of roster.memberNames()) names.add(name)
    }
    for (const name of this.retiredNames) names.add(name)
    return names
  }

  /** 这个名字所在的花名册 */
  rosterOf(name: string): SubAgentRoster | undefined {
    for (const roster of this.nodes.keys()) {
      if (roster.hasMember(name)) return roster
    }
    return undefined
  }

  /** 秘书的花名册（第 0 层）；秘书这一轮收工以后仍然认得它 */
  root(): SubAgentRoster | undefined {
    for (const [roster, node] of this.nodes) {
      if (node.depth === 0) return roster
    }
    return this.rootRoster
  }

  /**
   * 这份花名册往上数，秘书直接派的那位组长。点名秘书的话要记在他名下，
   * 秘书等消息时（wait_agents）才会被这一条叫醒。
   */
  ancestorUnderRoot(roster: SubAgentRoster): string | undefined {
    let current: SubAgentRoster = roster
    for (let hops = 0; hops <= MAX_ORG_DEPTH + 1; hops++) {
      const node = this.nodes.get(current)
      if (!node?.owner) return undefined
      const parent = this.rosterOf(node.owner)
      if (!parent) return undefined
      if (this.nodes.get(parent)?.depth === 0) return node.owner
      current = parent
    }
    return undefined
  }

  /** 每份花名册在树里的位置，按层数从上到下 */
  entries(): Array<{ roster: SubAgentRoster; owner?: string; depth: number; reportsTo?: string }> {
    return [...this.nodes.entries()]
      .map(([roster, node]) => ({ roster, owner: node.owner, depth: node.depth, reportsTo: this.reportsTo(roster) }))
      .sort((a, b) => a.depth - b.depth)
  }

  /** 这份花名册的主人向谁汇报：他自己所在花名册的主人；秘书直接派的写 undefined（向秘书） */
  reportsTo(roster: SubAgentRoster): string | undefined {
    const node = this.nodes.get(roster)
    if (!node?.owner) return undefined
    const holder = this.rosterOf(node.owner)
    if (holder) {
      const lead = this.nodes.get(holder)?.owner
      this.reportsToSeen.set(roster, lead)
      return lead
    }
    return this.reportsToSeen.get(roster)
  }

  rosters(): SubAgentRoster[] {
    return [...this.nodes.keys()]
  }
}
