#!/usr/bin/env node

/**
 * npm version 的 postversion 钩子
 * 
 * npm 已在当前分支上完成 version bump + commit + tag。
 * 本脚本负责分支合并与推送。
 * 
 * 从 develop 发版时的流程:
 * 1. 推送 develop（含版本 commit）
 * 2. 切换到 main，合并 develop
 * 3. 推送 main 和 tag
 * 4. 切回 develop
 * 
 * 从 main 发版时的流程:
 * 1. 推送 main 和 tag
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

function execSilent(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

function exec(command) {
  log(`  $ ${command}`, 'blue');
  execSync(command, { stdio: 'inherit' });
}

function getCurrentBranch() {
  return execSilent('git rev-parse --abbrev-ref HEAD');
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return { originalBranch: 'main' };
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
    if (state.originalBranch === 'develop') {
      log('\n推送 develop 分支（含版本 commit）...', 'cyan');
      exec('git push');
      success('develop 分支已推送');

      log('\n切换到 main 分支...', 'cyan');
      exec('git checkout main');
      exec('git pull --ff-only');
      success('已切换到 main');

      log('\n合并 develop 到 main...', 'cyan');
      exec('git merge develop --ff-only');
      success('合并完成');

      log('\n推送 main 分支和 tag...', 'cyan');
      exec('git push');
      exec(`git push origin v${version}`);
      success('main 分支和 tag 已推送');

      log('\n切回 develop 分支...', 'cyan');
      exec('git checkout develop');
      success('已切回 develop');
    } else {
      log('\n推送 main 分支和 tag...', 'cyan');
      exec('git push');
      exec(`git push origin v${version}`);
      success('main 分支和 tag 已推送');
    }

    log('\n========================================', 'green');
    log('     🎉 发布完成!', 'green');
    log('========================================', 'green');
    log(`\n版本: v${version}`, 'green');
    log('\n后续步骤:', 'cyan');
    log('  - GitHub/GitLab 会自动触发 CI/CD 构建');
    log('  - 检查 Release 页面确认构建结果\n');

  } catch (e) {
    error('postversion 执行出错!');

    const currentBranch = getCurrentBranch();
    if (currentBranch !== state.originalBranch) {
      log(`\n尝试恢复到 ${state.originalBranch} 分支...`, 'yellow');
      try {
        execSync(`git checkout ${state.originalBranch}`, { stdio: 'pipe' });
        log(`已恢复到 ${state.originalBranch} 分支`, 'yellow');
      } catch (_) {
        log(`无法自动恢复到 ${state.originalBranch}，请手动 checkout`, 'red');
      }
    }

    log('\n版本已更新但后续步骤失败，请手动执行:', 'yellow');
    if (state.originalBranch === 'develop') {
      log(`  git push                          # 推送 develop`);
      log(`  git checkout main && git pull --ff-only`);
      log(`  git merge develop --ff-only`);
      log(`  git push                          # 推送 main`);
      log(`  git push origin v${version}`);
      log(`  git checkout develop`);
    } else {
      log(`  git push`);
      log(`  git push origin v${version}`);
    }
    cleanupState();
    process.exit(1);
  } finally {
    cleanupState();
  }
}

main();
