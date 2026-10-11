/**
 * 交给 IPC 之前把数据变成纯数据。
 * Vue 的响应式对象（ref / reactive 里取出来的）是代理，Electron 的结构化克隆不认，
 * 会直接抛「An object could not be cloned」，这一句根本到不了后端。
 */
export function toIpcPlain<T>(value: T): T {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value)) as T
}
