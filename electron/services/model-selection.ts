/** 一场对话及其成员共享手动选择；实例内的自动降级仍可保持局部。 */
export class ModelSelection {
  private controller = new AbortController()
  private revision = 0
  private selected?: string

  get version(): number { return this.revision }
  get profileId(): string | undefined { return this.selected }
  get signal(): AbortSignal { return this.controller.signal }

  select(profileId: string): void {
    if (profileId === this.selected) return
    const previous = this.controller
    this.selected = profileId
    this.revision++
    this.controller = new AbortController()
    previous.abort()
  }
}
