---
title: "Download & Install"
description: "Download and install SailFish on macOS, Windows, or Linux"
---

# Download & Install

SailFish supports macOS, Windows, and Linux. Installation is straightforward and similar to other desktop apps.

## System Requirements

| Platform | Minimum Requirement |
|----------|---------------------|
| macOS | 10.15 (Catalina) or later; supports Intel and Apple Silicon |
| Windows | Windows 10 / 11, Server 2016 or later |
| Linux | Mainstream 64-bit distributions (Ubuntu 20.04+, Debian 11+, Fedora 36+, etc.) |

## Download

You can download the latest version from either of these sources:

- **Alibaba Cloud (recommended in China)**: Fast download, no VPN needed
- **GitHub Releases**: Recommended for users outside China

> Visit the download section at the bottom of [sfterm.com](https://www.sfterm.com), or go directly to [GitHub Releases](https://github.com/ysyx2008/SailFish/releases).

### macOS

- **Apple Silicon (M1/M2/M3/M4)**: Download `SailFish-x.x.x-arm64.dmg`
- **Intel**: Download `SailFish-x.x.x-x64.dmg`

> Not sure which chip your Mac has? Click the Apple menu → "About This Mac" and check the "Chip" field. Apple M1/M2/M3/M4 means Apple Silicon; Intel means Intel.

### Windows

- Download `SailFish-x.x.x-x64-setup.exe` (64-bit installer)

### Linux

- **AppImage** (universal): Download `SailFish-x.x.x-x86_64.AppImage`
- **deb package** (Debian/Ubuntu): Download `SailFish-x.x.x-amd64.deb`

## Installation Steps

### macOS Installation

1. Double-click the downloaded `.dmg` file
2. In the window that opens, drag the SailFish icon to the Applications folder
3. Open Launchpad or find SailFish in Applications and double-click to launch

**First launch note**: macOS may show "无法验证开发者" (developer cannot be verified). This is normal. To fix:

1. Open **System Settings** → **Privacy & Security**
2. Find the SailFish message at the bottom and click **"Open Anyway"**
3. Or run in Terminal: `xattr -cr /Applications/SailFish.app`

### Windows Installation

1. Double-click the downloaded `.exe` installer
2. If SmartScreen appears, click **"More info"** → **"Run anyway"**
3. Complete the installation wizard (default path is recommended)
4. After installation, find the SailFish icon in the Start menu or on the desktop and double-click to launch

### Linux Installation

**AppImage (recommended):**

```bash
# Grant execute permission
chmod +x SailFish-*.AppImage

# Run
./SailFish-*.AppImage
```

**deb package:**

```bash
sudo dpkg -i SailFish-*-amd64.deb
```

## Launch and First Run

After installation and launch, you will see the main interface. AI is not yet functional because the AI service API has not been configured.

No worries — the next article will walk you through configuration step by step.

## Auto Update

SailFish has built-in auto update. When a new version is available, the app will prompt you to download. You can also manually check for updates in **Settings**.

## Troubleshooting

- **macOS says app is "damaged"**: Run `xattr -cr /Applications/SailFish.app` in Terminal
- **Windows antivirus blocks it**: Add SailFish to the allowlist; this is a false positive
- **Linux won't start**: Ensure the system has `libgtk-3-0`, `libnotify4`, `libnss3`, and similar dependencies installed

If you still have issues, report them at [GitHub Issues](https://github.com/ysyx2008/SailFish/issues), or ask for help in the QQ community group.

## Next Step

After installation, proceed to [configure the AI service](/docs/getting-started/first-setup) so SailFish can "think."
