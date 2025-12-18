import { ref, computed } from 'vue'

// 文件书签类型
export interface FileBookmark {
  id: string
  name: string
  path: string
  type: 'local' | 'remote'
  hostId?: string      // SSH 会话 ID（远程书签）
  hostName?: string    // 主机名称（显示用）
  createdAt: number
}

// 书签状态
const bookmarks = ref<FileBookmark[]>([])
const isLoading = ref(false)

// 生成唯一 ID
const generateId = () => {
  return `bookmark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export function useBookmarks() {
  // 加载所有书签
  const loadBookmarks = async () => {
    isLoading.value = true
    try {
      const result = await window.electronAPI.config.getFileBookmarks()
      bookmarks.value = result || []
    } catch (error) {
      console.error('加载书签失败:', error)
    } finally {
      isLoading.value = false
    }
  }

  // 添加书签
  const addBookmark = async (bookmark: Omit<FileBookmark, 'id' | 'createdAt'>) => {
    const newBookmark: FileBookmark = {
      ...bookmark,
      id: generateId(),
      createdAt: Date.now()
    }
    
    try {
      await window.electronAPI.config.addFileBookmark(newBookmark)
      bookmarks.value.push(newBookmark)
      return true
    } catch (error) {
      console.error('添加书签失败:', error)
      return false
    }
  }

  // 删除书签
  const deleteBookmark = async (id: string) => {
    try {
      await window.electronAPI.config.deleteFileBookmark(id)
      bookmarks.value = bookmarks.value.filter(b => b.id !== id)
      return true
    } catch (error) {
      console.error('删除书签失败:', error)
      return false
    }
  }

  // 更新书签
  const updateBookmark = async (bookmark: FileBookmark) => {
    try {
      await window.electronAPI.config.updateFileBookmark(bookmark)
      const index = bookmarks.value.findIndex(b => b.id === bookmark.id)
      if (index !== -1) {
        bookmarks.value[index] = bookmark
      }
      return true
    } catch (error) {
      console.error('更新书签失败:', error)
      return false
    }
  }

  // 检查路径是否已添加书签
  const isBookmarked = (path: string, type: 'local' | 'remote', hostId?: string) => {
    return bookmarks.value.some(b => {
      if (b.path !== path || b.type !== type) return false
      if (type === 'remote') {
        return b.hostId === hostId
      }
      return true
    })
  }

  // 获取指定路径的书签
  const getBookmarkByPath = (path: string, type: 'local' | 'remote', hostId?: string) => {
    return bookmarks.value.find(b => {
      if (b.path !== path || b.type !== type) return false
      if (type === 'remote') {
        return b.hostId === hostId
      }
      return true
    })
  }

  // 本地书签
  const localBookmarks = computed(() => {
    return bookmarks.value.filter(b => b.type === 'local')
  })

  // 远程书签
  const remoteBookmarks = computed(() => {
    return bookmarks.value.filter(b => b.type === 'remote')
  })

  // 获取指定主机的远程书签
  const getRemoteBookmarksByHost = (hostId: string) => {
    return bookmarks.value.filter(b => b.type === 'remote' && b.hostId === hostId)
  }

  return {
    bookmarks,
    localBookmarks,
    remoteBookmarks,
    isLoading,
    loadBookmarks,
    addBookmark,
    deleteBookmark,
    updateBookmark,
    isBookmarked,
    getBookmarkByPath,
    getRemoteBookmarksByHost
  }
}
