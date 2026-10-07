/**
 * 插件运行时同步器
 *
 * 职责：把 PluginRegistry 的当前快照装配（或撤销）到各外部服务：
 * - AiService provider / Gateway route：服务本身是整体替换语义，直接全量同步，
 *   空快照同样同步（否则禁用最后一个插件时旧快照无法清空）；
 * - TTS provider：与内置 provider 共用同一个池，必须按插件 owner 增量同步，
 *   且内置 id 一律不注册、不删除；
 * - IM channel adapter：按插件 owner 增量装配/撤销（跟踪粒度为 channel），装配即
 *   registerAdapter + start()（3s 预算，失败回滚并重试），撤销即停止连接；
 *   注册被拒（platform 冲突）或装配失败的 channel 在后续同步中自动重试。
 *
 * registry 不直接依赖这些服务（依赖方向是 main.ts 负责装配），因此由 main.ts
 * 注入真实实现，契约测试注入假实现。
 */

import type { IMAdapter } from '../im/types'
import type { PluginRegistry } from './registry'
import type { ChannelRegistration, HttpRouteEntry, ProviderRegistration, TtsProviderRegistration } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('PluginRuntimeSync')

/** 单个清理动作（adapter stop 等）的等待预算：插件挂起时不能阻塞禁用/卸载/退出 */
const CLEANUP_BUDGET_MS = 3000

/** 外部服务的装配/撤销接口，由 main.ts 用真实服务实现 */
export interface PluginRuntimeSyncDeps {
  /** AiService.setPluginProviders：整体替换 */
  setPluginProviders(providers: ProviderRegistration[]): void
  /** GatewayService.registerPluginRoutes：整体替换（Gateway 需要惰性拉起时可能异步） */
  registerPluginRoutes(routes: HttpRouteEntry[]): Promise<void> | void
  /** TTS provider 注册/撤销（与内置同池，模块动态加载，可能异步） */
  registerTtsProvider(provider: TtsProviderRegistration): Promise<void> | void
  removeTtsProvider(id: string): Promise<void> | void
  /** 内置 TTS provider id 保护 */
  isBuiltinTtsProvider(id: string): Promise<boolean> | boolean
  /** IM adapter 装配：返回 false 表示注册被拒（如 platform 已被占用），不得纳入跟踪 */
  registerImAdapter(adapter: IMAdapter): boolean
  /** IM adapter 撤销（含 stop） */
  unregisterImAdapter(adapter: IMAdapter): Promise<void> | void
  /** 读取 channel 配置（pluginsEntries 里对应 channel 的 config） */
  getChannelConfig(channelId: string): Record<string, unknown>
}

export class PluginRuntimeSync {
  private readonly deps: PluginRuntimeSyncDeps
  /** 已注册的插件 TTS provider id -> 归属插件 id */
  private ttsOwners = new Map<string, string>()
  /**
   * 已注册的插件 IM adapter：pluginId -> (channelId -> adapter 实例)。
   * 只记录完成 registerAdapter + start() 的 channel：被 platform 冲突拒绝、创建失败
   * 或 start 失败/超时（已回滚注册）的 channel 不入表，后续每次同步自动重试，
   * 冲突解除（platform 被释放）后自动接管。
   */
  private pluginAdapters = new Map<string, Map<string, IMAdapter>>()
  /** 串行化链：快速连续 enable/disable/install 时不允许两个 sync 交错应用快照 */
  private syncChain: Promise<void> = Promise.resolve()

  constructor(deps: PluginRuntimeSyncDeps) {
    this.deps = deps
  }

  /**
   * 将 registry 当前快照同步到外部服务。enable/disable/install/unload 后都必须调用。
   * 幂等：状态未变化时不会产生重复注册。
   * 并发调用按排队顺序串行执行，避免陈旧快照覆盖新状态。
   * 各段独立容错（providers/routes/tts/im 互不影响），失败段合并记录一条日志，
   * 并以失败段名列表返回给调用方（空数组 = 全部成功）。
   */
  sync(registry: PluginRegistry, context?: string): Promise<string[]> {
    const entry = this.syncChain.then(
      () => this.doSync(registry, context),
      () => this.doSync(registry, context)
    )
    this.syncChain = entry.then(
      () => undefined,
      () => undefined
    )
    return entry
  }

  /**
   * 停止并撤销所有已装配的插件 IM adapter（退出收尾用）。
   * 与 sync 同链串行，避免退出时与装配交错。
   */
  dispose(): Promise<void> {
    const entry = this.syncChain.then(() => this.doDispose(), () => this.doDispose())
    this.syncChain = entry.catch(() => {})
    return entry
  }

  private async doSync(registry: PluginRegistry, context?: string): Promise<string[]> {
    const failures: string[] = []

    try {
      this.deps.setPluginProviders(registry.getAllProviders())
    } catch (err) {
      log.error('Failed to sync plugin providers:', err)
      failures.push('providers')
    }

    try {
      await this.deps.registerPluginRoutes(registry.getAllHttpRoutes())
    } catch (err) {
      log.error('Failed to sync plugin routes:', err)
      failures.push('routes')
    }

    try {
      await this.syncTtsProviders(registry)
    } catch (err) {
      log.error('Failed to sync plugin TTS providers:', err)
      failures.push('tts-providers')
    }

    try {
      const imItemFailures = await this.syncImAdapters(registry)
      failures.push(...imItemFailures)
    } catch (err) {
      log.error('Failed to sync plugin IM adapters:', err)
      failures.push('im-adapters')
    }

    if (failures.length > 0) {
      log.error(
        `插件运行时同步部分失败${context ? ` [${context}]` : ''}: ${failures.join(', ')}（注册物可能未完全撤销/装配）`
      )
    }
    return failures
  }

  private async doDispose(): Promise<void> {
    for (const [pluginId, tracked] of this.pluginAdapters) {
      for (const adapter of tracked.values()) {
        try {
          // 退出路径的每 adapter 预算：插件实现的 stop 挂起也不能阻塞应用退出
          await this.withCleanupBudget(
            Promise.resolve(this.deps.unregisterImAdapter(adapter)),
            `unregister IM adapter "${adapter.platform}" of plugin "${pluginId}"`
          )
        } catch (err) {
          log.error(`Failed to unregister IM adapter of plugin "${pluginId}":`, err)
        }
      }
    }
    this.pluginAdapters.clear()
  }

  /**
   * TTS：按 owner 增量同步。
   * - 内置 id 被插件占用时跳过注册（不覆盖内置 provider，也避免撤销时误删内置）；
   * - 多个启用插件注册同一 id 时先到先得，后到者跳过并记录；
   * - owner 变化（原插件禁用/卸载，另一插件接管同一 id）时先删后注册。
   */
  private async syncTtsProviders(registry: PluginRegistry): Promise<void> {
    const desired = new Map<string, { pluginId: string; provider: TtsProviderRegistration }>()
    for (const { pluginId, provider } of registry.getEnabledTtsProvidersWithOwner()) {
      if (await this.deps.isBuiltinTtsProvider(provider.id)) {
        log.warn(`Plugin "${pluginId}" TTS provider "${provider.id}" conflicts with builtin id, skipped`)
        continue
      }
      if (desired.has(provider.id)) {
        log.warn(
          `Plugin TTS provider id "${provider.id}" already owned by plugin "${desired.get(provider.id)!.pluginId}", ` +
          `registration from plugin "${pluginId}" skipped`
        )
        continue
      }
      desired.set(provider.id, { pluginId, provider })
    }

    // 撤销不再启用（或 owner 已变）的注册
    for (const [id, owner] of this.ttsOwners) {
      const want = desired.get(id)
      if (!want || want.pluginId !== owner) {
        await this.deps.removeTtsProvider(id)
        this.ttsOwners.delete(id)
      }
    }

    // 装配新增（或 owner 变化后重新接管）的注册
    for (const [id, { pluginId, provider }] of desired) {
      if (this.ttsOwners.has(id)) continue
      await this.deps.registerTtsProvider(provider)
      this.ttsOwners.set(id, pluginId)
    }
  }

  /**
   * IM：按插件增量装配/撤销 channel adapter，跟踪粒度为 channelId。
   *
   * 装配语义：createAdapter -> registerAdapter -> **start()**（建立连接），
   * start 抛错或超时会回滚注册并不入跟踪表，下次同步自动重试——契约遵从的插件
   * （连接初始化在 start()、构造无副作用）由此获得完整的启动/停止生命周期。
   *
   * 失败上报（计入 doSync 的失败段列表）：
   * - 装配失败（createAdapter / registerAdapter 抛错、start 抛错或超时）计入；
   * - platform 冲突拒绝不计入（既定争用状态，已有专门错误日志且自动重试）；
   * - 撤销侧 stop 类失败（im 内部捕获或预算超时）仅记录日志不计入——逻辑撤销
   *   （移除注册、切断入站回调）此时已完成，属清理问题。
   *
   * 撤销带清理预算：插件 stop() 挂起不得阻塞禁用/卸载。
   */
  private async syncImAdapters(registry: PluginRegistry): Promise<string[]> {
    const desired = new Map<string, ChannelRegistration[]>()
    for (const { pluginId, channel } of registry.getEnabledChannelsWithOwner()) {
      let list = desired.get(pluginId)
      if (!list) {
        list = []
        desired.set(pluginId, list)
      }
      list.push(channel)
    }

    // 撤销：已装配但插件不再启用（或已卸载）
    for (const [pluginId, tracked] of Array.from(this.pluginAdapters.entries())) {
      if (desired.has(pluginId)) continue
      for (const adapter of tracked.values()) {
        try {
          await this.withCleanupBudget(
            Promise.resolve(this.deps.unregisterImAdapter(adapter)),
            `unregister IM adapter "${adapter.platform}" of plugin "${pluginId}"`
          )
        } catch (err) {
          log.error(`Failed to unregister IM adapter of plugin "${pluginId}":`, err)
        }
      }
      this.pluginAdapters.delete(pluginId)
    }

    // 装配：启用的 channel 中尚未成功装配的（首次装配或此前被拒/失败的重试）
    let assemblyFailed = false
    for (const [pluginId, channels] of desired) {
      let tracked = this.pluginAdapters.get(pluginId)
      if (!tracked) {
        tracked = new Map()
        this.pluginAdapters.set(pluginId, tracked)
      }
      for (const channel of channels) {
        if (tracked.has(channel.id)) continue
        try {
          const config = this.deps.getChannelConfig(channel.id)
          const adapter = channel.createAdapter(config)
          if (!this.deps.registerImAdapter(adapter)) {
            log.error(
              `IM channel "${channel.id}" of plugin "${pluginId}": platform "${adapter.platform}" rejected ` +
              `(already owned by another adapter), will retry on next sync`
            )
            continue
          }
          if (!(await this.startImAdapter(pluginId, channel.id, adapter))) {
            assemblyFailed = true
          } else {
            tracked.set(channel.id, adapter)
          }
        } catch (err) {
          log.error(`Failed to register IM channel "${channel.id}" of plugin "${pluginId}":`, err)
          assemblyFailed = true
        }
      }
    }
    return assemblyFailed ? ['im-adapters'] : []
  }

  /**
   * 启动 adapter（带清理预算）。失败或超时则回滚注册：既不能把未启动的 adapter 留在
   * im 池中（否则形成 sync 不跟踪的孤儿实例），也不入跟踪表（下次同步自动重试）。
   *
   * 超时只放弃等待、并不能取消插件自己的 start()：若 start 在预算之后晚到完成，
   * 监护逻辑会立即 stop 该实例——避免留下任何地方都不再持有引用的活动连接。
   * 返回是否启动成功。
   */
  private async startImAdapter(pluginId: string, channelId: string, adapter: IMAdapter): Promise<boolean> {
    // start() 可能是非 async 实现：同步抛错也必须进入统一回滚路径，不能逸出到 per-channel catch
    let startPromise: Promise<void>
    try {
      startPromise = Promise.resolve(adapter.start())
    } catch (err) {
      startPromise = Promise.reject(err)
    }
    let started = false
    startPromise.then(() => { started = true }, () => { /* 失败由下方统一处理 */ })

    try {
      await this.withCleanupBudget(startPromise.then(() => undefined), `start IM adapter "${adapter.platform}" of plugin "${pluginId}"`)
    } catch (err) {
      log.error(`IM channel "${channelId}" of plugin "${pluginId}": adapter "${adapter.platform}" start failed:`, err)
    }
    if (started) return true

    log.error(
      `IM channel "${channelId}" of plugin "${pluginId}": adapter "${adapter.platform}" did not start ` +
      `(failed or timed out), rolling back registration, will retry on next sync`
    )
    try {
      await this.withCleanupBudget(
        Promise.resolve(this.deps.unregisterImAdapter(adapter)),
        `rollback IM adapter "${adapter.platform}" of plugin "${pluginId}"`
      )
    } catch (err) {
      log.error(`Failed to rollback IM adapter registration of plugin "${pluginId}":`, err)
    }

    // 晚到完成监护：回滚后 start 仍可能完成并建立连接，落定时立即拆除该孤儿实例
    startPromise.then(
      () => {
        log.warn(
          `IM adapter "${adapter.platform}" of plugin "${pluginId}" start completed after budget, ` +
          `stopping the orphaned instance`
        )
        // 回调体内不允许异常逸出（否则形成 floating promise 的 unhandled rejection）
        try {
          Promise.resolve(adapter.stop()).catch(err => {
            log.error(`Failed to stop orphaned IM adapter "${adapter.platform}" of plugin "${pluginId}":`, err)
          })
        } catch (err) {
          log.error(`Failed to stop orphaned IM adapter "${adapter.platform}" of plugin "${pluginId}":`, err)
        }
      },
      () => { /* 晚到失败：实例从未变活跃，无需处理 */ }
    )
    return false
  }

  /** 单个清理动作的预算：超时放行（插件 stop 继续在后台进行），不阻塞禁用/卸载/退出 */
  private withCleanupBudget(task: Promise<unknown>, label: string, ms = CLEANUP_BUDGET_MS): Promise<unknown> {
    const taskPromise = Promise.resolve(task)
    // 超时放行后任务仍可能 late-reject，挂 no-op catch 防 unhandled rejection
    taskPromise.catch(() => { /* race 已由超时方胜出，迟到失败只留在日志语义里 */ })
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      taskPromise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          log.warn(`${label} timed out after ${ms}ms, continuing`)
          resolve(undefined)
        }, ms)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}
