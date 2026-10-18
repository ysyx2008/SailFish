# 记忆栏目：把记忆和档案室的内容管理搬出设置

状态：**未完成**（2026-10-18 落盘，等用户确认后开工）

设计目标已写入 `electron/services/knowledge/SPEC.md`「记忆单独成一个栏目，设置里只留设置项」。本文只写怎么做。

## 现状

- 设置页「记忆与知识库」由 `src/components/Settings/KnowledgeSettings.vue` 一个文件承担：上半是管理区（记忆/知识库两个标签、目录树、文件列表、详情、右键菜单，约 600 行逻辑 + 样式），下半是几组设置项。
- 秘书菜单（`AppSidebar.vue`）里的联系人、待办是「秘书面板」：`SecretaryPanel` 联合类型 + `terminal` store 里的 `secretaryPanel` 状态，`App.vue` 按状态把 `ContactPanel` / `TodoPanel` 挂在主区。壳层前进后退按 `panel:<名字>` 通用记录，不用改。
- 简化版（Steam）不显示待办、关切、觉醒，设置页也只有五个标签，没有知识库页。

## 做法

### 新增/改动文件

| 文件 | 改什么 |
|---|---|
| `src/components/Memory/MemoryPanel.vue`（新） | 管理区原样搬来：标签、目录树、列表、详情、右键、全部处理函数和样式。自带标题栏和「记忆 / 知识库」标签；知识库未就绪时的提示也带过来 |
| `src/components/Settings/KnowledgeSettings.vue` | 去掉管理区，只留设置组。清空全库按钮要知道库里有没有文件，自己轻量取一次文件数 |
| `src/utils/agent-tab-ui-meta.ts` | `SecretaryPanel` 加 `'memory'` |
| `src/stores/terminal.ts` | 新增 `memoryActive`、`openMemory()`，与 `openContacts` 同一写法并导出 |
| `src/components/AppSidebar.vue` | 菜单里加「记忆」，放在待办后面、关切前面；`isSteamBuild` 时不显示；新增 `open-memory` 事件 |
| `src/App.vue` | 接 `open-memory`，主区挂 `MemoryPanel`，关闭走现有 `closeSecretaryPanel` |
| `src/components/Settings/SettingsModal.vue` | 去掉给 `.knowledge-page` 单开的 1120px 宽度（设置页回到统一宽度） |
| `src/i18n/locales/{zh-CN,en-US}/common.ts` 等 | `shell.memory`（记忆 / Memory）；面板标题；设置页说明改成只讲设置项 |
| 测试 | 管理区的用例从 `knowledge-settings.test.ts` 挪到新的 `memory-panel.test.ts`；设置页留设置项用例；`agent-tab-ui-meta.test.ts` 补 `memory` 面板打开时不算「正在看某条会话」 |
| `.cursor/rules/project-architecture.mdc` | 秘书菜单一句话补上「记忆」 |

### 不动

- 后台服务、IPC、预加载、存储格式、记忆/档案的任何规则。
- 想法本里想过的「面板之间互相跳转」不做。

## 任务拆解（两次提交，重构和新入口分开）

1. **抽出 MemoryPanel（行为不变）**
   - 把管理区搬进 `MemoryPanel.vue`，`KnowledgeSettings.vue` 里暂时仍嵌着它。
   - 验收：设置页看到的和现在完全一样；管理区的单测挪到新文件后全绿；`knowledge-settings` 里剩下的用例全绿。
2. **新增「记忆」入口，设置页只留设置项**
   - 加面板类型、store 状态、菜单项、主区挂载、翻译；设置页去掉管理区和 1120px 宽度。
   - 验收：菜单里点「记忆」占主区，关得掉，前进后退可回到；设置页只剩设置项，清空/重建仍可用；简化版没有该菜单项；`agent-tab-ui-meta` 新增用例；`bash electron/cli/test-cli.sh --no-ai`；让真窗口跑起来点一遍。
3. **收尾**：`project-architecture.mdc`、想法本挪到已完成并挂提交。

## 风险与注意

- 管理区状态较多（选中的文档、批量选择、右键菜单、命名输入框），整块搬，不拆；搬完只改 import 与 `<script>` 头部，减少抄错。
- 面板打开时设置页若同时开着，两边各自取数，互不共享；改了目录/文件后设置页里的「清空」可用状态以下次打开为准（设置页是模态，二者基本不会同时存在）。
- 面板名叫 `memory`，与 `companion`（联络）等落点名不冲突。

## 待确认

- 设置页那一页顶部，要不要留一句话指向「记忆」栏目（例如「内容管理在秘书菜单的记忆里」）。默认不留，页面只有设置项。
