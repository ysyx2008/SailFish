/**
 * 日历技能类型定义
 */

/**
 * 日历事件
 */
export interface CalendarEvent {
  /** 事件唯一标识 */
  uid: string
  /** 事件标题 */
  title: string
  /** 开始时间 */
  start: Date
  /** 结束时间 */
  end: Date
  /** 是否全天事件 */
  allDay?: boolean
  /** 地点 */
  location?: string
  /** 描述 */
  description?: string
  /** 提醒（分钟） */
  reminder?: number
  /** 重复规则 */
  recurrence?: string
  /** 状态 */
  status?: 'confirmed' | 'tentative' | 'cancelled'
  /** 原始数据（用于更新） */
  etag?: string
  /** 事件 URL（CalDAV） */
  url?: string
}

/**
 * 日历信息
 */
export interface Calendar {
  /** 日历唯一标识 */
  id: string
  /** 日历显示名称 */
  name: string
  /** 日历描述 */
  description?: string
  /** 日历颜色 */
  color?: string
  /** 是否只读 */
  readonly?: boolean
  /** 日历 URL（CalDAV） */
  url?: string
}

/**
 * 日历账户配置（从渲染进程传入）
 */
export interface CalendarAccountConfig {
  /** 账户 ID */
  id: string
  /** 账户显示名称 */
  name: string
  /** 日历服务商 */
  provider: 'google' | 'icloud' | 'outlook' | 'wecom' | 'caldav'
  /** CalDAV 服务器地址 */
  serverUrl?: string
  /** 用户名/邮箱 */
  username: string
}

/**
 * 预置的 CalDAV 服务器配置
 */
export interface CalDAVServerConfig {
  /** 服务器地址 */
  serverUrl: string
  /** 是否需要特殊处理 */
  specialHandling?: 'google' | 'icloud' | 'wecom'
}

/**
 * 待办事项（VTODO）
 */
export interface CalendarTodo {
  /** 待办唯一标识 */
  uid: string
  /** 待办标题 */
  title: string
  /** 截止日期 */
  due?: Date
  /** 开始日期 */
  start?: Date
  /** 完成日期 */
  completed?: Date
  /** 优先级（1-9，1 最高，9 最低，0 表示未设置） */
  priority?: number
  /** 状态 */
  status?: 'needs-action' | 'in-process' | 'completed' | 'cancelled'
  /** 完成百分比（0-100） */
  percentComplete?: number
  /** 描述 */
  description?: string
  /** 分类标签 */
  categories?: string[]
  /** 原始数据（用于更新） */
  etag?: string
  /** 事件 URL（CalDAV） */
  url?: string
}

/**
 * 创建待办事项参数
 */
export interface CreateTodoParams {
  /** 日历 ID */
  calendarId: string
  /** 待办标题 */
  title: string
  /** 截止日期（ISO 8601 格式） */
  due?: string
  /** 优先级（1=最高, 5=中, 9=最低） */
  priority?: number
  /** 描述 */
  description?: string
  /** 分类标签 */
  categories?: string[]
}

/**
 * 更新待办事项参数
 */
export interface UpdateTodoParams {
  /** 日历 ID */
  calendarId: string
  /** 待办 ID */
  todoId: string
  /** 新标题 */
  title?: string
  /** 新截止日期 */
  due?: string
  /** 新优先级 */
  priority?: number
  /** 新状态 */
  status?: 'needs-action' | 'in-process' | 'completed' | 'cancelled'
  /** 完成百分比 */
  percentComplete?: number
  /** 新描述 */
  description?: string
  /** 新分类标签 */
  categories?: string[]
}

/**
 * 创建事件参数
 */
export interface CreateEventParams {
  /** 日历 ID */
  calendarId: string
  /** 事件标题 */
  title: string
  /** 开始时间（ISO 8601 格式） */
  start: string
  /** 结束时间（ISO 8601 格式，可选，默认开始时间 + 1 小时） */
  end?: string
  /** 是否全天事件 */
  allDay?: boolean
  /** 地点 */
  location?: string
  /** 描述 */
  description?: string
  /** 提前提醒分钟数 */
  reminderMinutes?: number
  /** 重复规则 */
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly'
}

/**
 * 更新事件参数
 */
export interface UpdateEventParams {
  /** 日历 ID */
  calendarId: string
  /** 事件 ID */
  eventId: string
  /** 新标题 */
  title?: string
  /** 新开始时间 */
  start?: string
  /** 新结束时间 */
  end?: string
  /** 新地点 */
  location?: string
  /** 新描述 */
  description?: string
}

/**
 * 删除事件参数
 */
export interface DeleteEventParams {
  /** 日历 ID */
  calendarId: string
  /** 事件 ID 列表 */
  eventIds: string[]
}
