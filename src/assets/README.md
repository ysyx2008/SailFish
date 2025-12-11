# Assets 资源目录

## 收款码图片 / Payment QR Codes

请将收款码图片放置在此目录：

| 文件名 | 用途 |
|-------|-----|
| `wechat-pay.png` | 微信收款码 |
| `alipay.png` | 支付宝收款码 |

### 建议尺寸

- 推荐尺寸：200x200 像素
- 格式：PNG（支持透明背景）


然后修改赞助链接
在 SettingsModal.vue 中，把这两个链接改成你自己的：

<!-- 找到这行，改成你的 GitHub Sponsors 页面 -->
<a href="https://github.com/sponsors/你的用户名" ...>

<!-- 找到这行，改成你的 PayPal.me 链接 -->
<a href="https://paypal.me/你的PayPal用户名" ...>