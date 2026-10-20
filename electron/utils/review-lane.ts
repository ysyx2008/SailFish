/**
 * 验收实例：在工作树里以开发模式起的那一份，界面上要标出是哪一路。
 *
 * 由开发服务器（vite.config.ts）在工作树里启动 Electron 时经环境变量告知；
 * 打包后、或从主目录起的开发模式，恒为非验收实例。
 */
import { app } from 'electron'
import { REVIEW_LANE_ENV } from '@shared/review-lane'

export interface ReviewLane {
  /** 这一路的分支名 */
  readonly branch: string
}

const branch = app.isPackaged ? '' : (process.env[REVIEW_LANE_ENV]?.trim() ?? '')
const lane: ReviewLane | null = branch ? { branch } : null

/** 当前进程是验收实例时返回这一路的信息，否则为 null */
export function getReviewLane(): ReviewLane | null {
  return lane
}
