# 知识库服务模块

本目录包含 SFTerminal 的知识库服务实现，提供文档管理、向量搜索和主机记忆功能。

## 目录结构

```
knowledge/
├── index.ts           # 知识库服务主入口
├── embedding.ts       # 文本向量化（ONNX 模型）
├── vector-store.ts    # 向量存储和检索
├── chunking.ts        # 文档分块策略
├── reranker.ts        # 搜索结果重排序
├── mcp-adapter.ts     # MCP 协议适配器
├── host-memory.ts     # 主机记忆管理
├── settings.ts        # 设置管理
├── utils.ts           # 工具函数
└── README.md          # 本文档
```

## 核心功能

### 文档管理
- 添加/删除/更新文档
- 支持多种文档格式（TXT, MD, PDF, DOCX）
- 自动分块和向量化

### 语义搜索
- 基于向量相似度的语义搜索
- 支持重排序优化结果
- 按主机过滤

### 主机记忆
- 每个主机独立的记忆空间
- 智能去重和冲突解决
- 语义合并相似记忆

## 使用方式

```typescript
import { getKnowledgeService } from './knowledge'

const service = getKnowledgeService()

// 添加文档
await service.addDocument(file, 'hostId')

// 搜索
const results = await service.search('查询内容', { hostId: 'xxx' })

// 添加主机记忆
await service.addHostMemorySmart('hostId', '记忆内容')
```

## 依赖

- ONNX Runtime (向量化模型)
- 本地 JSON 存储

## 配置

通过 `settings.ts` 管理：
- 模型路径
- 分块大小
- 搜索参数
