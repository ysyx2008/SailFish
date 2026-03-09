import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type SshSession, type SessionGroup } from '../stores/config'

export type GroupedSessions = Record<string, { group: SessionGroup | null; sessions: SshSession[] }>

export function useSessionList(searchText: Ref<string>) {
  const { t } = useI18n()
  const configStore = useConfigStore()

  const filteredSessions = computed(() => {
    const text = searchText.value.toLowerCase()
    if (!text) return configStore.sshSessions
    return configStore.sshSessions.filter(
      s =>
        s.name.toLowerCase().includes(text) ||
        s.host.toLowerCase().includes(text) ||
        s.username.toLowerCase().includes(text)
    )
  })

  const sortSessions = (sessions: SshSession[]): SshSession[] => {
    const sortBy = configStore.sessionSortBy
    const sorted = [...sessions]

    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        break
      case 'name-desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'))
        break
      case 'lastUsed':
        sorted.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
        break
      case 'custom':
      default:
        sorted.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
        break
    }

    return sorted
  }

  const sortedGroups = computed(() => {
    const defaultGroupName = t('session.defaultGroup')
    const defaultGroupOrder = configStore.defaultGroupSortOrder

    const groups = [...configStore.sessionGroups].sort((a, b) =>
      (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
    )

    return { groups, defaultGroupName, defaultGroupOrder }
  })

  const groupedSessions = computed<GroupedSessions>(() => {
    const groups: GroupedSessions = {}
    const { groups: sortedGroupList, defaultGroupName, defaultGroupOrder } = sortedGroups.value

    sortedGroupList.forEach(group => {
      groups[group.name] = { group, sessions: [] }
    })

    if (!groups[defaultGroupName]) {
      groups[defaultGroupName] = { group: null, sessions: [] }
    }

    filteredSessions.value.forEach(session => {
      let groupName = defaultGroupName
      let groupEntity: SessionGroup | null = null

      if (session.groupId) {
        const found = configStore.sessionGroups.find(g => g.id === session.groupId)
        if (found) {
          groupName = found.name
          groupEntity = found
        }
      } else if (session.group) {
        groupName = session.group
        groupEntity = configStore.sessionGroups.find(g => g.name === session.group) || null
      }

      if (!groups[groupName]) {
        groups[groupName] = { group: groupEntity, sessions: [] }
      }
      groups[groupName].sessions.push(session)
    })

    for (const groupName of Object.keys(groups)) {
      groups[groupName].sessions = sortSessions(groups[groupName].sessions)
    }

    type SortItem = { name: string; order: number }
    const sortItems: SortItem[] = []

    sortedGroupList.forEach(group => {
      if (groups[group.name]) {
        sortItems.push({ name: group.name, order: group.sortOrder ?? Infinity })
      }
    })

    sortItems.push({ name: defaultGroupName, order: defaultGroupOrder === -1 ? Infinity : defaultGroupOrder })

    Object.keys(groups).forEach(groupName => {
      if (!sortItems.find(item => item.name === groupName)) {
        sortItems.push({ name: groupName, order: Infinity })
      }
    })

    sortItems.sort((a, b) => a.order - b.order)

    const orderedGroups: GroupedSessions = {}
    sortItems.forEach(item => {
      if (groups[item.name]) {
        orderedGroups[item.name] = groups[item.name]
      }
    })

    return orderedGroups
  })

  return {
    filteredSessions,
    groupedSessions,
  }
}
