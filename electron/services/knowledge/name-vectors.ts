/**
 * 目录名和文件名在向量库里的一行。
 * 和正文分开放，正文那张表的结构不动。
 */

export interface NameVectorRecord {
  id: string
  kind: 'file' | 'folder'
  text: string
  folder: string
  docId?: string
  vector: number[]
}

export interface NameVectorUpdate {
  id: string
  kind: 'file' | 'folder'
  text: string
  folder: string
  docId: string
}

export function fileNameKey(docId: string): string {
  return `file:${docId}`
}

export function folderNameKey(folder: string): string {
  return `folder:${folder}`
}
