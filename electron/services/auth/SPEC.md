/**
 * Auth / SSO 模块契约
 *
 * ## 用法文档
 * - OEM 操作手册：`docs/oem-sso-guide.md`
 *
 * ## 职责
 * - 提供应用级 OAuth2/OIDC 协议底座（授权码 + PKCE、token 交换、ID Token 解析）
 * - 登录窗（BrowserWindow + will-redirect）、会话落盘、refresh、按需 accessToken
 * - web_fetch 对 OEM `enterpriseApiHosts` 精确命中时自动注入 Bearer
 * - 受 `oem.config.features.sso` 门控；默认关闭，不挡开源产品使用
 *
 * ## 设计目标
 *
 * 登录之后，左下角那一张脸换成这个人（2026-10-15）。头像和名字用登录拿到的，没有头像就用名字的第一个字，名字下面是邮箱。点开的菜单仍是联系人、待办、设置这些，最底下可以退出。还没觉醒不再占这一行，留在点开的菜单里。没开登录，或还没登录，这里仍是应用名，或用户给秘书起的名字和头像。侧栏收起时，右上角用同一个人的名字，点一下退出。厂商不用改侧栏来换这张脸。
 *
 * ## 非职责
 * - 企业组织树 / RBAC / 计费控制面
 * - 邮箱、飞书等「服务授权」OAuth（见 skills/email/oauth、IM 适配器）
 *
 * ## 公开 API
 * - `getAuthService()` → `AuthService`
 * - `login` / `beginLogin` / `completeLogin` / `getPublicSession` / `getAccessToken` / `logout` / `restoreSession`
 * - `shouldInjectBearerForUrl` / `getGateMode` / `getEnterpriseApiHosts`
 * - 纯函数：`electron/services/auth/oidc-protocol.ts`
 * - 登录窗：`electron/services/auth/login-window.ts`
 *
 * ## 配置（oem.config.sso）
 * - `issuer` / `clientId` / `redirectUri` / `scopes?` / `clientSecret?`
 * - `gateMode?`: `hard` | `soft` | `none`（缺省 soft）
 * - `verifyIdToken?`: `claims` | `jwks`（缺省 claims）
 * - `enterpriseApiHosts?`: 精确 hostname[]；默认未配 / [] → **永不**自动注入 Bearer
 *
 * ## 安全约束
 * - refreshToken 只存主进程 + credential.service（`sso:app`），不下发渲染进程
 * - `auth:getSession` 返回 `AuthPublicSession`（无 token）
 * - accessToken 经 `auth:getAccessToken` 按需领取；临近过期自动 refresh
 * - Bearer 注入：空名单不注入；精确 host 匹配；已有 Authorization 不覆盖
 *
 * ## IPC（由 main 注册）
 * - `auth:getSession` / `auth:getAccessToken` / `auth:getGateMode`
 * - `auth:startLogin`（一条龙弹窗） / `auth:completeLogin` / `auth:logout`
 *
 * ## 岗包用法
 * - `import { useAuth } from '@sailfish/workbench-sdk/auth'`
 * - `const token = await getAccessToken()` 后自行带 Header 调企业 API
 */
