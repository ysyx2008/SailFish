/**
 * 一个伙计的远程范围：能连哪几台已存主机、能原样跑哪些命令。
 * 派出时由代码生成，跟着伙计走；伙计自己改不了。补单经用户批准后才追加命令。
 */

/** 单子上的一台主机，展示用的那几项 */
export interface GrantedHost {
  /** 已存会话的 id */
  id: string
  name: string
  /** user@host:port */
  address: string
  /** 所在分组名 */
  group?: string
}

export class RemoteGrant {
  private readonly hostById: ReadonlyMap<string, GrantedHost>
  private readonly commandList: string[]

  constructor(hosts: readonly GrantedHost[], commands: readonly string[]) {
    this.hostById = new Map(hosts.map(h => [h.id, h]))
    this.commandList = []
    this.addCommands(commands)
  }

  get hosts(): readonly GrantedHost[] {
    return [...this.hostById.values()]
  }

  get commands(): readonly string[] {
    return this.commandList
  }

  hasHosts(): boolean {
    return this.hostById.size > 0
  }

  findHost(id: string): GrantedHost | undefined {
    return this.hostById.get(id)
  }

  /** 命令原文去掉首尾空白后与单上某条完全相同 */
  permitsCommand(command: string): boolean {
    return this.commandList.includes(command.trim())
  }

  /** 已有的不重复加。返回真正新增的条数 */
  addCommands(commands: readonly string[]): number {
    let added = 0
    for (const raw of commands) {
      const command = raw.trim()
      if (!command || this.commandList.includes(command)) continue
      this.commandList.push(command)
      added++
    }
    return added
  }
}
