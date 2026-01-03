#!/usr/bin/env node

/**
 * 图标生成脚本
 * 
 * 从源 logo.png 生成所有平台所需的图标文件：
 * - macOS: icon.icns (通过 iconset)
 * - Windows: icon.ico
 * - Linux/通用: 各尺寸 PNG
 * 
 * 用法: node scripts/generate-icons.js [源图片路径]
 * 默认源图片: resources/logo.png
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function warn(message) {
  log(`⚠ ${message}`, 'yellow');
}

function error(message) {
  log(`✗ ${message}`, 'red');
}

function execSilent(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

function exec(command, silent = false) {
  if (!silent) {
    log(`  $ ${command}`, 'blue');
  }
  try {
    execSync(command, { stdio: silent ? 'pipe' : 'inherit' });
    return true;
  } catch (e) {
    return false;
  }
}

function getImageSize(imagePath) {
  const width = execSilent(`sips -g pixelWidth "${imagePath}" | tail -1 | awk '{print $2}'`);
  const height = execSilent(`sips -g pixelHeight "${imagePath}" | tail -1 | awk '{print $2}'`);
  return {
    width: parseInt(width, 10),
    height: parseInt(height, 10),
  };
}

function checkImageMagick() {
  return execSilent('which convert') !== null;
}

function checkPlatform() {
  return process.platform;
}

async function main() {
  log('\n========================================', 'cyan');
  log('     图标生成工具', 'cyan');
  log('========================================\n', 'cyan');

  const projectRoot = path.resolve(__dirname, '..');
  const resourcesDir = path.join(projectRoot, 'resources');
  const iconsetDir = path.join(resourcesDir, 'icon.iconset');

  // 获取源图片路径，默认使用 resources/logo.png
  const sourceLogo = process.argv[2] || path.join(resourcesDir, 'logo.png');

  // 检查源图片是否存在
  if (!fs.existsSync(sourceLogo)) {
    error(`源图片不存在: ${sourceLogo}`);
    log('\n用法: node scripts/generate-icons.js [源图片路径]');
    log('默认源图片: resources/logo.png\n');
    process.exit(1);
  }

  log(`源图片: ${sourceLogo}`);

  // 检查图片尺寸
  const size = getImageSize(sourceLogo);
  log(`图片尺寸: ${size.width} x ${size.height}`);

  if (size.width !== size.height) {
    error('源图片必须是正方形!');
    process.exit(1);
  }

  if (size.width < 1024) {
    warn(`图片尺寸 (${size.width}px) 小于推荐的 1024px，可能影响显示效果`);
  } else {
    success('图片尺寸符合要求');
  }

  const platform = checkPlatform();
  const hasImageMagick = checkImageMagick();

  log(`\n当前平台: ${platform}`);
  log(`ImageMagick: ${hasImageMagick ? '已安装' : '未安装'}`);

  // 确保 iconset 目录存在
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  // ========================================
  // 生成 macOS iconset
  // ========================================
  log('\n生成 macOS iconset...', 'cyan');

  const iconsetSizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ];

  for (const { size, name } of iconsetSizes) {
    const outputPath = path.join(iconsetDir, name);
    exec(`sips -z ${size} ${size} "${sourceLogo}" --out "${outputPath}"`, true);
  }
  success(`已生成 ${iconsetSizes.length} 个 iconset 图标`);

  // ========================================
  // 生成 .icns (仅 macOS)
  // ========================================
  if (platform === 'darwin') {
    log('\n生成 macOS icon.icns...', 'cyan');
    const icnsPath = path.join(resourcesDir, 'icon.icns');
    if (exec(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, true)) {
      success('已生成 icon.icns');
    } else {
      error('生成 icon.icns 失败');
    }
  } else {
    warn('跳过 .icns 生成 (需要在 macOS 上运行)');
  }

  // ========================================
  // 生成 Windows .ico
  // ========================================
  log('\n生成 Windows icon.ico...', 'cyan');
  const icoPath = path.join(resourcesDir, 'icon.ico');

  if (hasImageMagick) {
    // 使用 ImageMagick
    if (exec(`convert "${sourceLogo}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`, true)) {
      success('已生成 icon.ico (使用 ImageMagick)');
    } else {
      error('生成 icon.ico 失败');
    }
  } else {
    // 尝试使用 png2ico (如果存在)
    const hasPng2ico = execSilent('which png2ico') !== null;
    if (hasPng2ico) {
      // 生成多尺寸临时 PNG
      const tmpDir = path.join(resourcesDir, '.tmp-ico');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      
      const icoSizes = [256, 128, 64, 48, 32, 16];
      for (const size of icoSizes) {
        exec(`sips -z ${size} ${size} "${sourceLogo}" --out "${tmpDir}/icon_${size}.png"`, true);
      }
      
      const pngFiles = icoSizes.map(s => `"${tmpDir}/icon_${s}.png"`).join(' ');
      if (exec(`png2ico "${icoPath}" ${pngFiles}`, true)) {
        success('已生成 icon.ico (使用 png2ico)');
      }
      
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      warn('未安装 ImageMagick 或 png2ico，跳过 .ico 生成');
      log('  安装方法: brew install imagemagick', 'yellow');
      log('  或使用在线工具: https://icoconvert.com/', 'yellow');
    }
  }

  // ========================================
  // 复制其他 PNG 文件
  // ========================================
  log('\n复制 PNG 图标文件...', 'cyan');

  const pngCopies = [
    { dest: 'icon.png', desc: '通用图标' },
    { dest: 'icon_1024.png', desc: '高分辨率图标' },
  ];

  for (const { dest, desc } of pngCopies) {
    const destPath = path.join(resourcesDir, dest);
    try {
      fs.copyFileSync(sourceLogo, destPath);
      success(`已复制 ${dest} (${desc})`);
    } catch (e) {
      error(`复制 ${dest} 失败: ${e.message}`);
    }
  }

  // ========================================
  // 总结
  // ========================================
  log('\n========================================', 'cyan');
  log('     生成完成!', 'green');
  log('========================================\n', 'cyan');

  log('已生成的文件:', 'cyan');
  log('  macOS:');
  log('    - resources/icon.icns');
  log('    - resources/icon.iconset/*.png');
  log('  Windows:');
  log('    - resources/icon.ico');
  log('  Linux/通用:');
  log('    - resources/icon.png');
  log('    - resources/icon_1024.png');

  if (!hasImageMagick && platform !== 'darwin') {
    log('\n注意事项:', 'yellow');
    log('  - Windows .ico 文件可能未生成，请手动创建或安装 ImageMagick');
  }

  if (platform !== 'darwin') {
    log('\n注意事项:', 'yellow');
    log('  - macOS .icns 文件需要在 macOS 上生成');
  }

  log('\n提示: 运行 npm run build 来验证图标是否正确打包\n');
}

main().catch((e) => {
  error(`脚本执行失败: ${e.message}`);
  process.exit(1);
});

