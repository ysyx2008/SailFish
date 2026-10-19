import { Send } from 'lucide-vue-next'
import type { Component } from 'vue'
import { isAssignedBy, type AssignedBy } from '@shared/types'

/**
 * 「谁派的」在界面上怎么说：侧栏行首的小图标和对话顶栏里那一行字共用这一份，
 * 图标与文案各只此一处。新增一种派出方时，类型会逼着在这里补一项。
 */
export interface AssignedByPresentation {
  icon: Component
  /** 图标旁的说明（短） */
  hintKey: string
  /** 对话顶栏正中那一行字 */
  hintLineKey: string
}

export const ASSIGNED_BY_PRESENTATION: Record<AssignedBy, AssignedByPresentation> = {
  // 纸飞机取「派出去」：联络入口的聊天气泡放进对话列表里看不出是被派出来的
  companion: {
    icon: Send,
    hintKey: 'welcome.conversations.assignedByCompanion',
    hintLineKey: 'ai.assignedByHint.companion',
  },
}

/** 记录里没有出身、或是不认识的取值，一律当作没有——宁可不标，也不标错 */
export function resolveAssignedByPresentation(value: unknown): AssignedByPresentation | undefined {
  return isAssignedBy(value) ? ASSIGNED_BY_PRESENTATION[value] : undefined
}
