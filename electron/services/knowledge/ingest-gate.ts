/**
 * 入库与后台清理之间的让路闸
 *
 * 知识库的写入路径（文档入库、主机记忆、对话索引）都是先写向量索引、再登记进
 * documents.json，中间那段窗口里新的 docId 看着跟孤儿一模一样。后台孤儿清理
 * 若在此刻动手删除并整理磁盘，会把用户刚存进去的东西一起清掉——文档列表里
 * 还在，搜索却永远搜不到。
 *
 * 规则：入库优先。清理在跑时来的入库等它结束；入库在跑时来的清理让路，并记下
 * 待办，等入库收尾时补做一次（否则「下次再清」就成了空头支票：清理只在启动时
 * 调度一次，被跳过就本进程内再无机会）。
 */
export class IngestGate {
  private activeIngests = 0
  private cleanupRunning: Promise<void> | null = null
  private cleanupDeferred = false

  /** @param reschedule 让路后补做清理的方式，由持有者提供（通常是再排一次后台任务） */
  constructor(private readonly reschedule: () => void) {}

  get ingesting(): boolean {
    return this.activeIngests > 0
  }

  get cleaning(): boolean {
    return this.cleanupRunning !== null
  }

  /** 圈住一次索引写入 */
  async ingest<T>(task: () => Promise<T>): Promise<T> {
    // 清理已经动手了就等它收尾，别和它的 compact 交错
    while (this.cleanupRunning) {
      await this.cleanupRunning
    }

    this.activeIngests++
    try {
      return await task()
    } finally {
      this.activeIngests--
      if (this.activeIngests === 0 && this.cleanupDeferred) {
        this.cleanupDeferred = false
        this.reschedule()
      }
    }
  }

  /**
   * 圈住一次后台清理。入库进行中则不开工，登记待办后返回。
   * @returns 是否真的跑了
   */
  async cleanup(task: () => Promise<void>): Promise<boolean> {
    if (this.activeIngests > 0) {
      this.cleanupDeferred = true
      return false
    }

    if (this.cleanupRunning) {
      await this.cleanupRunning
      return false
    }

    const running = task()
    this.cleanupRunning = running
    try {
      await running
    } finally {
      this.cleanupRunning = null
    }
    return true
  }

  /**
   * 清理动手前的最后一道门：首次扫描到真正删除之间隔着好几次 await，
   * 期间可能有写入插进来。
   * @returns 是否该让路（让路时已登记待办）
   */
  shouldYield(): boolean {
    if (this.activeIngests > 0) {
      this.cleanupDeferred = true
      return true
    }
    return false
  }

  /** 释放后重新初始化时清掉残留，免得把新一轮的清理一直挡在外面 */
  reset(): void {
    this.activeIngests = 0
    this.cleanupRunning = null
    this.cleanupDeferred = false
  }
}
