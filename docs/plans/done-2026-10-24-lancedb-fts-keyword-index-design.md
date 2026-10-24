# 关键词索引并入 LanceDB 全文索引（方案）

日期：2026-10-24 · **已完成（待用户验收后合入）** · 分支 `feat/lancedb-fts-keyword-index` · 设计目标见 `electron/services/knowledge/SPEC.md`「按字面找的词索引和向量放在一处」

## 做法

- `knowledge_vectors` 表加一列 `tokens`（结巴切好、空格分隔、小写、过滤规则同旧 `BM25Index.tokenize`），在 `tokens` 上建 LanceDB 全文索引（`whitespace` 分词，不转词干、不去停用词、不带位置）。打分是 LanceDB 自带的 BM25，k1=1.2、b=0.75，与旧实现分数一致（试验里 15 个查询前 20 条、分数小数点后三位全部一致）。
- 切词跑在 LanceDB worker（utilityProcess）里：写入时由 worker 对 `content` 切词填 `tokens`，查询时同一函数切词，一个真相源。主进程不再加载结巴。
- 共享引擎 `keyword-index.js`（CJS，纯 JS）：worker 与进程内模式（CLI）共用，免得两处各写一份。
- 原表原地升级：`addColumns` 只改元数据（毫秒）；旧版往带 `tokens` 的表里 `add` 不带该列的行也能成功（试验确认），所以换回旧版不会坏。
- 回填：`tokens IS NULL` 的行分批切词，用只带 `id`+`tokens` 的 `mergeInsert` 更新（同批 id 去重——真实库里有 1 个重复 id）。3.5 万行实测约 4 秒。可中断续传（下次仍按 `IS NULL` 找）；旧版在换回期间新写的行，下次启动同样补上。
- 全文索引：回填后若没有就建（3.5 万行约 1.4 秒）；之后新增的行在索引未覆盖前由 LanceDB 扫描补上（试验确认能搜到）；未覆盖行超过 5000 时做一次 `optimize` 并入索引；`compact`（本来就调 `optimize`）顺带并入。
- 过滤：LanceDB 0.22.3 的全文检索带 `where` 预过滤会返回空（试验确认的缺陷），所以 `hostId`（`''`/NULL 或等于）、`tags`（任一命中、逐个标签精确相等）在取回之后用 JS 筛，不够数就把取回量加倍重取（上限 10 万行），语义同旧实现。

## 主进程侧

- `VectorStorage` 新增 `keywordSearch(query, limit, {hostId, tags})`（worker 与进程内两路）和 `tokenize(query)`；`hybridSearch` 的关键词那一路改走它。
- `KnowledgeService`：去掉 `bm25Index`；`repairIndex` / `checkAndRebuildIndex` 只比向量表里的 docId 差集（不再有「向量有、词索引没有」）；写入处（添加文档、换版、主机记忆、对话索引）只写向量表；删除处少一次词索引删除。`rebuildStarted` 的 `reason` 只剩 `vector`。
- `bm25.ts`、`bm25-remove-batch.test.ts` 退役；`bm25-index.json` 不再写，旧版最后写入 7 天后自动删。

## 任务拆解

1. SPEC 设计目标 + 本方案（本提交）
2. `keyword-index.js` + 单元测试（真 LanceDB，临时目录）：切词与旧实现一致、回填、续传、检索与旧 BM25 一致、过滤、增量未索引行可搜到
3. worker 接入（写入填 tokens、initialize 里升级、`keywordSearch` 消息）
4. `storage.ts` 接入（进程内路径 + `keywordSearch` + `hybridSearch`）
5. `index.ts` 切换，退役 `bm25.ts`；单测 mock 更新；CLI 回归测试改断言
6. 打包：`jieba-wasm` 与 `keyword-index.js` 进 asarUnpack / vite 拷贝 / 解包依赖检查
7. 真实数据副本端到端：迁移、搜索前后对比、删除、入库、重启续传、旧版回读
8. 代码审查、文档（`project-architecture.mdc`、SPEC 文件表与约束）

## 风险

- 迁移会改用户真实 `knowledge_vectors` 表（加一列、改所有行的 `tokens`）。换回旧版不会读坏，但旧版词索引会因文件已被清掉而重建一次。合入前建议先备份知识库目录。
- 打包版 worker 必须能解析 `jieba-wasm`（`asarUnpack`），否则知识库起不来——用 `check-asar-unpack-deps` 守住。

## 实际验证（2026-10-24）

- 真实知识库副本（3.5 万行）：命令行进程内路径与桌面应用 worker 路径各走一遍升级，首次启动多花约 6 秒，之后重启 1 秒内；每行都有词、全文索引覆盖全部行；放入、按字面找到、删除（约 0.1 秒）、重启无残留。脚本：`scripts/cli-e2e/knowledge-keyword.mjs --real`、`scripts/ui-e2e/knowledge-keyword-worker.mjs`。
- 旧词索引与向量表早已对不上（旧版搜「jieba」找不到对话里明明有的内容）；并表后按字面找到的就是向量表里的全部内容。
