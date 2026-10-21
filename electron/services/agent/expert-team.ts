/**
 * 一个专家团：团员、群消息、每人读到哪、这一段专家互相叫醒了几次。
 * 只管群里的事，谁在跑、怎么叫醒由花名册管。
 */

/** 组长（派出专家团的秘书）在群里的名字。专家不能叫这个名字。 */
export const TEAM_LEADER = '组长'

/** 专家互相叫醒每满这么多次，停下来等组长看一眼 */
export const WAKES_PER_CHECKPOINT = 30

export const MIN_TEAM_SIZE = 2
export const MAX_TEAM_SIZE = 15

export interface TeamMember {
  name: string
  role: string
  description: string
}

export interface TeamMessage {
  /** 从 1 开始，按先后 */
  seq: number
  from: string
  to: string[]
  text: string
  at: number
}

export interface TeamPostOutcome {
  message: TeamMessage
  /** 现在就叫醒的专家 */
  wakeNow: string[]
  /** 正在等组长，先记下、暂不叫醒的专家 */
  queued: string[]
  /** 被组长打断的，只记在群里 */
  skipped: string[]
  /** 点到了组长 */
  toLeader: boolean
  /** 这一条让叫醒次数满了这一段，从现在起等组长 */
  checkpointReached: boolean
}

export class ExpertTeam {
  readonly name: string
  private readonly members: TeamMember[]
  private readonly messages: TeamMessage[] = []
  /** 每人已经看过的最后一条 seq */
  private readonly readUpTo = new Map<string, number>()
  private wakesThisStretch = 0
  private waitingLeader = false
  /** 等组长期间被点到、还没叫醒的人，按被点到的先后 */
  private readonly pendingWakes: string[] = []

  constructor(name: string, members: TeamMember[]) {
    this.name = name
    this.members = members.map(m => ({ ...m }))
    for (const m of members) this.readUpTo.set(m.name, 0)
  }

  has(name: string): boolean {
    return this.members.some(m => m.name === name)
  }

  memberNames(): string[] {
    return this.members.map(m => m.name)
  }

  roster(): TeamMember[] {
    return this.members.map(m => ({ ...m }))
  }

  member(name: string): TeamMember | undefined {
    const m = this.members.find(x => x.name === name)
    return m ? { ...m } : undefined
  }

  /** 不是团员、也不是组长的名字 */
  unknownNames(names: string[]): string[] {
    return names.filter(n => n !== TEAM_LEADER && !this.has(n))
  }

  isWaitingLeader(): boolean {
    return this.waitingLeader
  }

  wakesSoFar(): number {
    return this.wakesThisStretch
  }

  queuedWakes(): string[] {
    return [...this.pendingWakes]
  }

  /**
   * 专家在群里说一句。点到的专家（不含自己）现在叫醒，或在等组长时先记下。
   * 每叫醒一位算一次；这一条让次数满了就从下一条起等组长，这一条照常叫醒。
   * asleep 里的人（被组长打断的）只记在群里，不叫醒、不计数、不排队。
   */
  post(from: string, to: string[], text: string, asleep: ReadonlySet<string> = new Set()): TeamPostOutcome {
    const targets = dedupe(to)
    const message = this.record(from, targets, text)
    const named = targets.filter(n => n !== from && this.has(n))
    const skipped = named.filter(n => asleep.has(n))
    const experts = named.filter(n => !asleep.has(n))
    const toLeader = targets.includes(TEAM_LEADER)

    if (this.waitingLeader) {
      for (const n of experts) {
        if (!this.pendingWakes.includes(n)) this.pendingWakes.push(n)
      }
      return { message, wakeNow: [], queued: experts, skipped, toLeader, checkpointReached: false }
    }

    this.wakesThisStretch += experts.length
    const checkpointReached = experts.length > 0 && this.wakesThisStretch >= WAKES_PER_CHECKPOINT
    if (checkpointReached) this.waitingLeader = true
    return { message, wakeNow: experts, queued: [], skipped, toLeader, checkpointReached }
  }

  /**
   * 组长对某位专家说话（再交代）。记进群里，不算叫醒次数；
   * 组长说话就是看过了：重新数，等组长期间被点到的人（除了这次说话的对象）交回去叫醒。
   */
  leaderSpoke(to: string, text: string): { message: TeamMessage; release: string[] } {
    const message = this.record(TEAM_LEADER, [to], text)
    this.wakesThisStretch = 0
    this.waitingLeader = false
    const release = this.pendingWakes.splice(0).filter(n => n !== to)
    return { message, release }
  }

  /** 这个人还没看过的群消息（不含他自己说的），取完就算看过 */
  takeUnread(name: string): TeamMessage[] {
    const seen = this.readUpTo.get(name) ?? 0
    const unread = this.messages.filter(m => m.seq > seen && m.from !== name)
    this.readUpTo.set(name, this.messages.length)
    return unread.map(copyMessage)
  }

  messageCount(): number {
    return this.messages.length
  }

  transcript(): TeamMessage[] {
    return this.messages.map(copyMessage)
  }

  recent(count: number): TeamMessage[] {
    return this.messages.slice(-count).map(copyMessage)
  }

  /** 名字前带上角色，给人和模型看 */
  label(name: string): string {
    const m = this.members.find(x => x.name === name)
    return m ? `${m.role}·${m.name}` : name
  }

  private record(from: string, to: string[], text: string): TeamMessage {
    const message: TeamMessage = { seq: this.messages.length + 1, from, to, text, at: Date.now() }
    this.messages.push(message)
    return message
  }
}

function dedupe(names: string[]): string[] {
  return [...new Set(names.map(n => n.trim()).filter(Boolean))]
}

function copyMessage(m: TeamMessage): TeamMessage {
  return { ...m, to: [...m.to] }
}
