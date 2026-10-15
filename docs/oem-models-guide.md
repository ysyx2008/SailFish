# OEM 自带模型

> 读者：希望员工装上就能用、不用再填模型地址的同学  
> 产品取舍见 [`oem-vision.md`](./oem-vision.md)「厂商自带模型」  
> 开源不写这项。不配、地址留空，就和现在一样，每人自己配。

---

## 一句话

在 `shared/oem.config.ts` 写上公司的模型清单地址。员工第一次打开、还没配过模型时，清单里的模型会放进去，第一条文本模型当作当前默认。钥匙不要写进安装包。

---

## 1. 配置

编辑运行时配置 `shared/oem.config.ts`（由 `oem.config.template.ts` 复制而来）：

```ts
export const oemConfig = {
  // ...
  models: {
    catalogUrl: 'https://llm.example.com/sailfish/models.json',
    auth: 'login',   // 'none' | 'login'；不写 = none
  },
}
```

| 字段 | 说明 |
|---|---|
| `catalogUrl` | 清单文档的地址。不写、写成空、或不是 http(s)，等于不自带模型 |
| `auth` | `none`：取清单和对话都不带登录凭证。`login`：两处都带这个人登录后的访问令牌 |

`login` 要先把公司账号登录打开（见 [`oem-sso-guide.md`](./oem-sso-guide.md)）。还没登录时，软件请他先登录，不把他送去手填地址和模型名。

网关如果本来就不验钥匙，用 `none`。不要把一把大家共用的钥匙写进安装包，包是可以拆开的。

---

## 2. 清单长什么样

这是公司自己放的一份小文档，放在模型网关旁边即可，不必放到公网。不要拿网关的 `/v1/models` 当这份清单：那份列表没有显示名，也分不出文本和视觉。

```json
{
  "models": [
    {
      "id": "chat",
      "name": "公司对话",
      "apiUrl": "https://llm.example.com/v1/chat/completions",
      "model": "corp-chat",
      "kind": "text",
      "vision": "see"
    },
    {
      "id": "see",
      "name": "公司视觉",
      "apiUrl": "https://llm.example.com/v1/chat/completions",
      "model": "corp-vision",
      "kind": "vision"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定编号，只用字母、数字、`.` `_` `-`。改编号会被当成另一条模型 |
| `name` | 是 | 界面上的名字 |
| `apiUrl` | 是 | 对话接口地址，http 或 https。和现在手填的是同一种 |
| `model` | 是 | 发给接口的模型名 |
| `kind` | 是 | `text` 纯文本，`vision` 自己能看图 |
| `vision` | 否 | 仅文本模型。对话里有图片时改用的那条视觉模型的 `id` |
| `contextLength` | 否 | 上下文长度 |
| `maxOutputTokens` | 否 | 单次输出上限 |
| `apiFormat` | 否 | `auto`（默认）、`openai`、`anthropic` |

接口只要会 OpenAI 或 Anthropic 那种对话就行，不必再做一种新协议。

---

## 3. 员工那边会怎样

- 公司的模型和个人自己加的同时都在，互不覆盖。
- 这个人还没有选中的模型时，第一条文本模型当作当前默认。他已经选了自己的，就保持他选的。
- 公司的模型不出现在设置里，也不能改、不能删。对话里可以直接选。
- 你改了清单里的名字、地址或文本/视觉，他下次打开会跟着变。清单里新加的会补上，拿掉的会消失。他自己加的那些不动。
- 第一次没取到、电脑上也没有上次的副本：告诉他清单还没取到，或要先登录。下次打开再试。已经有上次的副本时，这次失败仍用那份。
