# 应用图标更换指南

## 文件说明

- `logo.png` - 源 Logo（更换此文件）

## Logo 要求

- PNG 格式，正方形，至少 1024×1024 像素

## 使用方法

```bash
npm run generate-icons
```

## 生成的文件

| 平台 | 文件 |
|------|------|
| macOS | `icon.icns` |
| Windows | `icon.ico` |
| Linux | `icon.png` |

## 注意事项

- Windows .ico 生成需要 ImageMagick：`brew install imagemagick`
- macOS .icns 只能在 macOS 上生成

