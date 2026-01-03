#!/usr/bin/env node

/**
 * npm version 的 postversion 钩子
 * 
 * 流程:
 * 1. 推送 main 分支和 tag
 * 2. 如果原来在 develop，切回 develop
 * 3. rebase develop 到 main
 * 4. 推送 develop
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return state;
    }
  } catch (e) {
    // ignore
  }
  return { originalBranch: 'main', needRebase: false };
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

function main() {
  const version = process.env.npm_package_version;
  
  log('\n========================================', 'cyan');
  log('     [postversion] 发布完成', 'cyan');
  log('========================================\n', 'cyan');

  const state = loadState();
  log(`原始分支: ${state.originalBranch}`);
  log(`新版本: v${version}`);

  try {
    // 推送 main 分支和 tag
    log('\n推送 main 分支和 tag...', 'cyan');
    exec('git push');
    exec(`git push origin v${version}`);
    success('main 分支和 tag 已推送');

    // 如果原来在 develop，切回并 rebase
    if (state.needRebase && state.originalBranch === 'develop') {
      log('\n切回 develop 分支...', 'cyan');
      exec('git checkout develop');
      success('已切回 develop');

      log('\nRebase develop 到 main...', 'cyan');
      exec('git rebase main');
      success('Rebase 完成');

      log('\n推送 develop 分支...', 'cyan');
      exec('git push --force-with-lease');
      success('develop 分支已推送');
    }

    // 完成
    log('\n========================================', 'green');
    log('     🎉 发布完成!', 'green');
    log('========================================', 'green');
    log(`\n版本: v${version}`, 'green');
    log('\n后续步骤:', 'cyan');
    log('  - GitHub/GitLab 会自动触发 CI/CD 构建');
    log('  - 检查 Release 页面确认构建结果\n');

  } catch (e) {
    error('postversion 执行出错!');
    log('\n版本已更新但后续步骤失败，请手动执行:', 'yellow');
    log(`  git push`);
    log(`  git push origin v${version}`);
    if (state.needRebase) {
      log(`  git checkout develop`);
      log(`  git rebase main`);
      log(`  git push --force-with-lease`);
    }
    process.exit(1);
  } finally {
    cleanupState();
  }
}

main();
