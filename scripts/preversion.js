#!/usr/bin/env node

/**
 * npm version 的 preversion 钩子
 * 
 * 流程:
 * 1. 检查是否在 develop 分支（或 main 分支）
 * 2. 确保工作区干净
 * 3. 拉取最新代码
 * 4. 运行编译检查
 * 5. 如果在 develop，切换到 main 并合并 develop
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 状态文件，用于在 postversion 中恢复
const STATE_FILE = path.join(__dirname, '.release-state.json');

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

function exec(command, options = {}) {
  log(`  $ ${command}`, 'blue');
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (e) {
    if (!options.ignoreError) {
      throw e;
    }
  }
}

function getCurrentBranch() {
  return execSilent('git rev-parse --abbrev-ref HEAD');
}

function hasUncommittedChanges() {
  const status = execSilent('git status --porcelain');
  return status && status.length > 0;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanupState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (e) {
    // ignore
  }
}

function recoverToOriginalBranch(originalBranch) {
  log('\n尝试恢复到原始状态...', 'yellow');
  try {
    const currentBranch = getCurrentBranch();
    if (currentBranch !== originalBranch) {
      // 重置 main 分支的合并
      execSync('git merge --abort', { stdio: 'pipe' }).toString();
    }
  } catch (e) {
    // ignore merge abort errors
  }
  
  try {
    execSync(`git checkout ${originalBranch}`, { stdio: 'pipe' });
    log(`已恢复到 ${originalBranch} 分支`, 'yellow');
  } catch (e) {
    log(`无法自动恢复到 ${originalBranch}，请手动检查`, 'red');
  }
  cleanupState();
}

async function confirm(question) {
  // 检查是否有 --yes 或 -y 参数（在 npm_config_yes 环境变量中）
  if (process.env.npm_config_yes === 'true' || process.env.npm_config_y === 'true') {
    return true;
  }
  
  // 检查是否是 CI 环境
  if (process.env.CI) {
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.yellow}${question} (y/N): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  log('\n========================================', 'cyan');
  log('     [preversion] 发布准备', 'cyan');
  log('========================================\n', 'cyan');

  const currentBranch = getCurrentBranch();
  const currentVersion = require('../package.json').version;
  
  log(`当前分支: ${currentBranch}`);
  log(`当前版本: ${currentVersion}`);

  // 允许从 develop 或 main 分支执行
  if (currentBranch !== 'develop' && currentBranch !== 'main') {
    error(`必须在 develop 或 main 分支执行 npm version (当前: ${currentBranch})`);
    process.exit(1);
  }

  // 检查工作区
  if (hasUncommittedChanges()) {
    error('工作区有未提交的更改，请先提交或暂存');
    process.exit(1);
  }
  success('工作区干净');

  // 显示将要执行的操作并确认
  log('\n即将执行以下操作:', 'cyan');
  log('  1. 拉取最新代码');
  log('  2. 运行编译检查');
  log('  3. 运行单元测试');
  if (currentBranch === 'develop') {
    log('  4. 切换到 main 分支');
    log('  5. 合并 develop 到 main');
    log('  6. 更新版本号并创建 tag');
    log('  7. 推送 main 和 tag');
    log('  8. 切回 develop 并 rebase');
    log('  9. 推送 develop');
  } else {
    log('  4. 更新版本号并创建 tag');
    log('  5. 推送 main 和 tag');
  }

  const shouldContinue = await confirm('\n确认继续?');
  if (!shouldContinue) {
    log('已取消', 'yellow');
    process.exit(1);
  }

  try {
    // 拉取最新代码
    log('\n拉取最新代码...', 'cyan');
    exec('git pull --ff-only');
    exec('git fetch --tags');
    success('代码已更新');

    // 运行编译检查
    log('\n运行编译检查...', 'cyan');
    exec('npm run build:check');
    success('编译检查通过');

    // 运行单元测试
    log('\n运行单元测试...', 'cyan');
    exec('npm run test:run');
    success('单元测试通过');

    // 如果在 develop 分支，需要切换到 main 并合并
    if (currentBranch === 'develop') {
      log('\n切换到 main 分支...', 'cyan');
      exec('git checkout main');
      exec('git pull --ff-only');
      success('已切换到 main');

      log('\n合并 develop 到 main...', 'cyan');
      exec('git merge develop --no-edit');
      success('合并完成');

      // 保存状态供 postversion 使用
      saveState({
        originalBranch: 'develop',
        needRebase: true,
      });
    } else {
      // 已经在 main 分支
      saveState({
        originalBranch: 'main',
        needRebase: false,
      });
    }

    log('\n✓ preversion 完成，继续执行版本更新...\n', 'green');

  } catch (e) {
    error('preversion 执行失败!');
    recoverToOriginalBranch(currentBranch);
    process.exit(1);
  }
}

main();
