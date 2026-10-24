import * as path from 'path'

type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>

/**
 * 把远程条目的名字落到 localDir 里。结果在这个目录外面时返回 null。
 * 名字里的 `..`、绝对路径都会被 path 解析后再比，不是按字面找 `../`。
 */
export function localDestinationInside(
  localDir: string,
  entryName: string,
  pathApi: PathApi = path,
): string | null {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0')) return null
  const root = pathApi.resolve(localDir)
  const dest = pathApi.resolve(root, entryName)
  const rel = pathApi.relative(root, dest)
  if (rel === '' || rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) {
    return null
  }
  return dest
}
