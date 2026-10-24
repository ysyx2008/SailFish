import * as fs from 'fs'
import * as path from 'path'
import { localDestinationInside } from '@shared/utils/local-destination'

const DOWNLOAD_CONCURRENCY = 10

export interface RemoteDownloadEntry {
  name: string
  type: string
}

export interface DownloadDirClient {
  list(remotePath: string): Promise<RemoteDownloadEntry[]>
  get(remotePath: string, localPath: string): Promise<unknown>
}

async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }))
}

async function walk(
  client: DownloadDirClient,
  remoteDir: string,
  localDir: string,
  skipped: string[],
): Promise<void> {
  fs.mkdirSync(localDir, { recursive: true })
  const listing = await client.list(remoteDir)
  const files: { src: string; dest: string }[] = []
  const dirs: { src: string; dest: string }[] = []

  for (const item of listing) {
    if (item.name === '.' || item.name === '..') continue
    const dest = localDestinationInside(localDir, item.name)
    if (!dest) {
      skipped.push(item.name)
      continue
    }
    const src = path.posix.join(remoteDir, item.name)
    if (item.type === 'd') dirs.push({ src, dest })
    else files.push({ src, dest })
  }

  await eachLimited(files, DOWNLOAD_CONCURRENCY, async (file) => {
    fs.mkdirSync(path.dirname(file.dest), { recursive: true })
    await client.get(file.src, file.dest)
  })
  for (const dir of dirs) {
    await walk(client, dir.src, dir.dest, skipped)
  }
}

/** 递归下载。返回会写到 localDir 外面、因此没下载的名字。`.` 和 `..` 不当成文件。 */
export async function downloadDirTree(
  client: DownloadDirClient,
  remoteDir: string,
  localDir: string,
): Promise<string[]> {
  const skipped: string[] = []
  await walk(client, remoteDir, path.resolve(localDir), skipped)
  return skipped
}
