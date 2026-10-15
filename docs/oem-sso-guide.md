# OEM SSO 使用指南

> 读者：要给企业版打开公司账号登录的同学  
> 产品心智见 [`oem-vision.md`](./oem-vision.md)；模块契约见 `electron/services/auth/SPEC.md`  
> 开源默认 **关闭**，不配、不开则整条链路 no-op。

---

## 一句话

在 `shared/oem.config.ts` 打开 `features.sso`，填好 IdP（Issuer / Client / 回调），用户即可用公司账号登录；岗包用 `useAuth().getAccessToken()` 调企业 API；Agent `web_fetch` 仅在你声明的企业域名上自动带 Bearer。

---

## 1. 开启与配置

编辑运行时配置 `shared/oem.config.ts`（由 `oem.config.template.ts` 复制而来，勿改模板冒充运行时）：

```ts
export const oemConfig = {
  // ...
  features: {
    // ...
    sso: true,  // 开源默认 false
  },
  sso: {
    issuer: 'https://login.corp.example',       // OIDC Issuer（会拉 /.well-known/openid-configuration）
    clientId: 'sailfish-desktop',
    // clientSecret: '...',                    // 公共客户端可省略，走 PKCE；机密客户端再填
    redirectUri: 'http://127.0.0.1:8765/sso/callback',  // 必须与 IdP 登记一致
    scopes: ['openid', 'profile', 'email'],
    gateMode: 'soft',                          // hard | soft | none；缺省 soft
    verifyIdToken: 'claims',                   // claims | jwks；缺省 claims
    enterpriseApiHosts: [                      // 精确 hostname；空 / 不配 = 永不自动注入
      'api.corp.example',
      'intranet.corp.example',
    ],
  },
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `issuer` | ✅ | OIDC Issuer |
| `clientId` | ✅ | IdP 应用 Client ID |
| `redirectUri` | ✅ | 授权回调；登录窗截获此 URL 上的 `code` |
| `clientSecret` | 否 | 机密客户端才需要 |
| `scopes` | 否 | 缺省 `openid profile email`（必须含 `openid` 才能拿 id_token） |
| `gateMode` | 否 | 见下表 |
| `verifyIdToken` | 否 | `claims`：验 iss/aud/exp；`jwks`：再验 RS256 签名 |
| `enterpriseApiHosts` | 否 | **精确** hostname 名单；默认不注入 Bearer |

### gateMode

| 值 | 行为 |
|---|---|
| `hard` | 未登录全屏挡主界面 |
| `soft`（默认） | 能进主界面；还没登录时右上角有「企业登录」 |
| `none` | 无内置登录 UI（OEM 自己接 `useAuth().login()`） |

### IdP 侧登记

1. 创建 OIDC / OAuth2 应用（授权码 + PKCE）  
2. 回调 URL = `redirectUri`（与配置逐字一致）  
3. 建议 scope：`openid` + `profile` + `email`；需要 refresh 时按 IdP 要求加 `offline_access` 等  

常见 IdP（Okta / Azure AD / Keycloak / 自建）按各自控制台填 Issuer 与 Client 即可；厂商私有扩展需另适配。

---

## 2. 用户怎么用

1. 打开应用（`features.sso=true` 且配置完整）  
2. **soft**：点右上角「企业登录」→ 弹窗到 IdP → 登录成功后，左下角换成这个人的头像和名字，邮箱在名字下面。点开左下角菜单，最底下可以退出。侧栏收起时，右上角是这个人的名字，点一下退出。  
3. **hard**：启动即全屏登录页，未登录进不了主界面  
4. 会话经 `credential.service` 加密落盘；重启会尝试用 refresh_token 恢复  

开源或 `sso: false`：无登录入口、无会话、无 Bearer 注入。

---

## 3. 岗包怎么取 token / 判断是否已登录

```ts
import { useAuth } from '@sailfish/workbench-sdk/auth'

const {
  isAuthenticated, // Ref<boolean>：是否已登录（看这个，不是单独的 check 函数）
  user,            // Ref<AuthUser | null>：当前用户
  getAccessToken,  // () => Promise<string | null>：按需拿短期 accessToken
  login,           // () => Promise<void>：弹窗登录
  logout,          // () => Promise<void>
  enabled,         // Ref<boolean>：OEM 是否开了 features.sso
} = useAuth()

// ① 先判断有没有登录（响应式布尔，用 .value）
if (!isAuthenticated.value) {
  await login()
  // 或：提示用户去右上角「企业登录」
}

// ② 已登录再拿 token 调企业 API
const token = await getAccessToken()
if (!token) {
  // 会话过期 / refresh 失败等
  await login()
  return
}
await fetch('https://api.corp.example/v1/orders', {
  headers: { Authorization: `Bearer ${token}` },
})
```

### API 速查

| 成员 | 类型 | 用途 |
|---|---|---|
| `isAuthenticated` | `Ref<boolean>` | **是否已登录**（有用户会话即 `true`） |
| `user` | `Ref<AuthUser \| null>` | 当前用户（`sub` / `name` / `email`） |
| `getAccessToken()` | `Promise<string \| null>` | 调 API 时再取短期 token；未登录或失效 → `null` |
| `login()` / `logout()` | `Promise<void>` | 登录 / 退出 |
| `enabled` | `Ref<boolean>` | SSO 功能是否开启 |

说明：

- 没有单独的 `checkLogin()` / `isLoggedIn()`——**用 `isAuthenticated.value` 即可**  
- `isAuthenticated` 表示「有会话」；真正调 API 前仍建议 `getAccessToken()`，因 token 可能已过期  
- App 启动时会 `init()` 恢复会话；岗包一般直接读 `isAuthenticated`。组件挂得极早时可先 `await init()`  
- 只能拿到**短期 accessToken**；**没有** refreshToken  
- 禁止 `import … from '@/stores/auth'`；禁止把 token 打进日志 / toast  

更完整的岗包规则见 [`oem-workbench-guide.md`](./oem-workbench-guide.md)。

---

## 4. Agent 自动带 Bearer（可选）

当 OEM 配置了 `enterpriseApiHosts`，且用户已登录时：

| 请求 | 是否自动加 `Authorization: Bearer …` |
|---|---|
| `web_fetch` → `https://api.corp.example/...`（名单内） | ✅ |
| `web_fetch` → 公网 / 名单外 | ❌ |
| 名单为空或不配 | ❌ 永不注入 |
| Jina Reader 路径 | ❌（避免 token 打到第三方） |

规则：

- **精确 hostname** 匹配（大小写不敏感），不做 `*.corp.com` 通配  
- 请求已有 `Authorization` 时不覆盖  
- 未登录 / SSO 关闭 → 不注入  

岗包前端自调 API 仍须自己 `getAccessToken()`；自动注入只覆盖**主进程** `web_fetch` 这类后端 HTTP。

---

## 5. 安全要点（必读）

1. `enterpriseApiHosts` 配错会把 token 打到错误域名——只列真正需要的 API host  
2. refreshToken 只在主进程加密存储，不下发渲染进程  
3. 开源默认关 + 空名单，避免误带企业凭据  
4. `verifyIdToken: 'jwks'` 需 IdP 提供 JWKS，且当前实现主要支持 RS256  

---

## 6. 联调检查清单

- [ ] `features.sso === true`，且 `issuer` / `clientId` / `redirectUri` 齐全  
- [ ] IdP 回调 URL 与 `redirectUri` 一致  
- [ ] soft：还没登录时右上角能登录；登录后左下角是这个人，菜单里能退出。hard：未登录挡全屏，登录后同样是左下角这个人  
- [ ] 重启后会话仍在（IdP 发了 refresh_token）  
- [ ] 岗包 `getAccessToken()` 非空，调企业 API 200  
- [ ] `enterpriseApiHosts` 命中时 Agent `web_fetch` 带 Bearer；改成公网 URL 不带  

失败时看主进程日志 scope `Auth` / `AuthLoginWindow`。

---

## 7. 不做的事

- 组织树 / RBAC / 计费控制面（后置）  
- 邮箱、飞书等「连外部服务」的 OAuth（与应用 SSO 分开）  
- 任意企业 SSO「零配置开箱」（仍要配 Issuer/Client/回调）  

---

## 相关文件

| 用途 | 路径 |
|---|---|
| 配置类型 | `shared/oem-types.ts` → `OemSsoConfig` |
| 配置模板注释 | `shared/oem.config.template.ts` |
| 服务实现 | `electron/services/auth/` |
| 岗包 API | `@sailfish/workbench-sdk/auth` |
| 产品决策 | [`oem-vision.md`](./oem-vision.md) |
