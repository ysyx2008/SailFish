import { onScopeDispose, shallowRef, watch } from 'vue'
import type { OrganizationView } from '@shared/types'

/** 显示用轻量不可变快照：合并密集更新，切换目标立即生效；详情不经过这里。 */
export function useTeamSnapshot(source: () => OrganizationView | undefined, scope: () => string | null) {
  const snapshot = shallowRef<OrganizationView>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: OrganizationView | undefined
  let currentScope: string | null | undefined
  const copy = (view: OrganizationView | undefined): OrganizationView | undefined => view && ({ ...view,
    members: view.members.map(member => ({ ...member, activity: member.activity && { ...member.activity } })),
    teams: view.teams.map(team => ({ ...team, reviewers: team.reviewers && [...team.reviewers] })),
  })
  // 深度订阅也接住原地修改；通知只标脏，复制留到合并窗口末端，避免每次通知分配千人副本。
  watch([source, scope], ([view, nextScope]) => {
    pending = view
    if (currentScope !== nextScope || !snapshot.value || !view) {
      clearTimeout(timer)
      timer = undefined
      currentScope = nextScope
      snapshot.value = copy(pending)
    } else if (!timer) {
      timer = setTimeout(() => { timer = undefined; snapshot.value = copy(pending) }, 100)
    }
  }, { immediate: true, deep: true })
  onScopeDispose(() => clearTimeout(timer))
  return snapshot
}
