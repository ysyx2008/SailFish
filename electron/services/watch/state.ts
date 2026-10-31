/** 关切状态的 JSON 保存边界：校验失败不产生部分更新。 */
export class WatchState {
  static readonly MAX_CHARS = 65_536

  static validate(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('watch_state 必须是 JSON 对象')
    }
    const json = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
        || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new Error('watch_state 包含不能完整保存的 JSON 值')
      }
      return item
    })
    if (json.length > WatchState.MAX_CHARS) {
      throw new Error(`状态合并后共 ${json.length} 字符，超过 ${WatchState.MAX_CHARS} 字符上限；未保存，原状态保留。较大内容可存入文件，状态只保留文件路径。`)
    }
    return JSON.parse(json)
  }

  static merge(current: Record<string, unknown> | undefined, patch: unknown): Record<string, unknown> {
    return WatchState.validate({ ...current, ...WatchState.validate(patch) })
  }
}
