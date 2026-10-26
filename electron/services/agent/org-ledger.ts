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

  /** 同一位组长再次开跑时换了新的花名册，旧的先退出 */
  register(roster: SubAgentRoster, owner: string | undefined, depth: number): void {
    for (const [other, node] of this.nodes) {
      if (other !== roster && node.owner === owner && node.depth === depth) this.nodes.delete(other)
    }
    this.nodes.set(roster, { owner, depth })
  }

  unregister(roster: SubAgentRoster): void {
    this.nodes.delete(roster)
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
      for (const name of roster.childNames()) names.add(name)
    }
    return names
  }

  /** 这个名字所在的花名册 */
  rosterOf(name: string): SubAgentRoster | undefined {
    for (const roster of this.nodes.keys()) {
      if (roster.hasChild(name)) return roster
    }
    return undefined
  }

  /** 秘书的花名册（第 0 层） */
  root(): SubAgentRoster | undefined {
    for (const [roster, node] of this.nodes) {
      if (node.depth === 0) return roster
    }
    return undefined
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
    return holder ? this.nodes.get(holder)?.owner : undefined
  }

  rosters(): SubAgentRoster[] {
    return [...this.nodes.keys()]
  }
}
