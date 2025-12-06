# Embedding 模型

此目录存放知识库功能使用的 Embedding 模型。

## 轻量模型（随软件打包）

`all-MiniLM-L6-v2` 模型需要从 HuggingFace 下载并放置在此目录。

### 下载方式

1. 访问 https://huggingface.co/Xenova/all-MiniLM-L6-v2
2. 下载以下文件到 `all-MiniLM-L6-v2` 目录：
   - `config.json`
   - `tokenizer.json`
   - `tokenizer_config.json`
   - `onnx/model_quantized.onnx`

### 目录结构

```
all-MiniLM-L6-v2/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_quantized.onnx
```

## 其他模型

标准模型和高精模型由用户按需下载，存储在用户数据目录中。

