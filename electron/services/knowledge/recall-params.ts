/**
 * 自动到场（每轮对话按用户消息检索并注入上下文）的召回实参。
 *
 * 单独成文件是为了让召回基线能引用这几个数而不必拉起整个知识库服务——
 * 基线量的必须就是线上这几个数，不另抄一份。
 */

/** 混合检索融合后的分数下限，低于它视为相关性不足 */
export const MIN_RRF_SCORE = 0.02

/** 每轮自动注入的片段条数上限 */
export const AUTO_RECALL_LIMIT = 5

/** 自动注入要求的向量相似度门槛，比 Agent 主动检索严得多 */
export const AUTO_RECALL_SIMILARITY = 0.6
