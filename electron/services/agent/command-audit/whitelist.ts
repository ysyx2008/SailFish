/**
 * 命令白名单（CommandRule 表）
 *
 * 设计原则：
 * - Allowlist：不在白名单的命令 → dangerous（Fail-Closed）
 * - safe 级别以只读命令为主（ls/cat/grep/find...）
 * - cp 为只增不减的复制，baseLevel 为 safe；其余写删改命令 baseLevel 至少 moderate
 *   可被路径分区降级（scratch/ 等）或升级（系统路径）
 * - flags 白名单：不认识的 flag → moderate（保守）
 *
 * 注意：shell 通道经 shell-ast 解析出 cmd + args + flags + redirects 后，
 * 复用本表的 CommandRule（basenameCommand/getArgvCommandRule 命名历史
 * 遗留，实际单通道共用）。
 */

import type { RiskLevel } from '@shared/types/agent'
import * as path from 'path'
import { maxRisk } from './risk-level'

/**
 * 命令的白名单规则
 */
export interface CommandRule {
  /** 命令名 */
  cmd: string
  /** 命令本身的风险等级（未经路径调整） */
  baseLevel: RiskLevel
  /** 安全的 flags（合并后的短 flag 也认：-rf 拆成 -r -f 后匹配） */
  safeFlags: Set<string>
  /** 接值的 flags（这些 flag 后面跟一个值，不当作路径） */
  valueFlags?: Set<string>
  /**
   * 路径参数的位置规则：
   * - 'all'    所有非 flag、非 value-flag 的参数都是路径
   * - 'fixed'  固定位置的参数是路径（见 pathArgIndices）
   */
  pathMode: 'all' | 'fixed' | 'none'
  /** 当 pathMode='fixed' 时，这些 index 是路径 */
  pathArgIndices?: number[]
  /**
   * 该命令是否会写文件（影响路径分区判断）：
   * - true  写/删操作，路径分区会调整风险
   * - false 只读，路径分区不影响
   */
  writesTo: boolean
}

/**
 * 规范化 flag：拆开合并的短 flag（-rf → -r -f），保留长 flag（--recursive）
 *
 * 注意：只处理短 flag 合并。--flag=value 形式由调用方传入时已拆开。
 */
/**
 * 规范化 flag：
 * - 长选项（--flag / --flag=value）保留并去掉 =value
 * - 短 flag 合并（-rf → -r -f）：拆开后**同时保留原 flag 和拆分结果**
 *   原因：拆分让 guard 能匹配 `-exec`/`-delete` 等多字母 flag（这些不该被拆），
 *   保留原 flag 让 assessCommandFlags 能匹配 `-lart`/`-lah` 等组合（整体匹配）。
 *   单字母 flag 不受影响（拆分结果就是原 flag 本身）。
 *
 * 长度阈值：仅对长度 ≤ 4 的短 flag 拆分，避免把 `-print`/`-exec`/`-delete` 等多字母长 flag 误拆。
 */
export function normalizeFlags(rawFlags: string[]): string[] {
  const result: string[] = []
  for (const f of rawFlags) {
    if (f.startsWith('--')) {
      // 长选项，去掉 =value 部分
      const eq = f.indexOf('=')
      result.push(eq >= 0 ? f.slice(0, eq) : f)
    } else if (f.startsWith('-') && !f.startsWith('--') && f.length > 2 && f.length <= 4) {
      // 短 flag 合并（-rf → -r -f），仅拆 ≤4 字符避免误拆 -print/-exec/-delete 等
      // 同时保留原 flag，让 assessCommandFlags 能整体匹配 -lart 等组合
      result.push(f)
      for (const ch of f.slice(1)) result.push(`-${ch}`)
    } else {
      // 单个 -、长度 > 4 的（-print/-exec/-delete/-name 等长 flag）、或非 flag，原样保留
      result.push(f)
    }
  }
  return result
}

/**
 * 从 argv 中分离 flags、value-flags、路径参数、其他参数
 *
 * 返回的 paths 是按出现顺序的路径位置参数（不含 flag、不含 value-flag 的值）
 */
export interface ParsedArgv {
  flags: string[]          // 规范化后的 flags
  paths: string[]          // 路径位置参数
  otherArgs: string[]      // 非路径的其他参数
  /** 解析失败原因（如某个 value-flag 没拿到值） */
  parseError?: string
}

export function splitArgv(args: string[], rule: CommandRule): ParsedArgv {
  const paths: string[] = []
  const otherArgs: string[] = []
  const valueFlags = rule.valueFlags ?? new Set()
  const rawFlags: string[] = []
  let pathArgIdx = 0

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined || a === '') continue

    // 是 flag
    if (a.startsWith('-') && a.length > 1) {
      // 长选项 --flag=value 形式：拆出 flag 和 value
      if (a.startsWith('--') && a.includes('=')) {
        const eq = a.indexOf('=')
        const flagName = a.slice(0, eq)
        const value = a.slice(eq + 1)
        rawFlags.push(flagName)
        // --flag=value 的 value 不进 paths
        void value
        continue
      }
      rawFlags.push(a)
      // 如果是 value-flag，下一个参数是它的值（不当作路径）
      if (valueFlags.has(a) || (a.startsWith('--') && a.includes('='))) {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          i++  // 跳过值
        }
      }
      continue
    }

    // 非 flag 参数：根据 pathMode 判断
    if (rule.pathMode === 'all') {
      paths.push(a)
    } else if (rule.pathMode === 'fixed' && rule.pathArgIndices?.includes(pathArgIdx)) {
      paths.push(a)
    } else {
      otherArgs.push(a)
    }
    pathArgIdx++
  }

  return {
    flags: normalizeFlags(rawFlags),
    paths,
    otherArgs,
  }
}

function rule(
  cmd: string,
  baseLevel: RiskLevel,
  opts: Partial<Omit<CommandRule, 'cmd' | 'baseLevel'>> = {},
): CommandRule {
  return {
    cmd,
    baseLevel,
    safeFlags: opts.safeFlags ?? new Set(),
    valueFlags: opts.valueFlags,
    pathMode: opts.pathMode ?? 'all',
    pathArgIndices: opts.pathArgIndices,
    writesTo: opts.writesTo ?? false,
  }
}

/** 命令白名单（未列出 → Fail-Closed unknownCmd；显式 dangerous 见写/删与高危段） */
export const ARGV_COMMAND_RULES: Record<string, CommandRule> = {
  // —— 只读 / 查询 ——
  ls: rule('ls', 'safe', {
    safeFlags: new Set(['-l', '-a', '-h', '-R', '-r', '-t', '-S', '-1', '-la', '-lah', '-al', '-ahl']),
    pathMode: 'all',
  }),
  cat: rule('cat', 'safe', { safeFlags: new Set(['-n', '-b', '-s']), pathMode: 'all' }),
  head: rule('head', 'safe', { safeFlags: new Set(['-n', '-c']), pathMode: 'all' }),
  tail: rule('tail', 'safe', { safeFlags: new Set(['-n', '-c']), pathMode: 'all' }),
  grep: rule('grep', 'safe', {
    safeFlags: new Set(['-i', '-v', '-r', '-n', '-c', '-l', '-E', '-F', '-w', '-h', '--color']),
    pathMode: 'all',
  }),
  find: rule('find', 'safe', {
    safeFlags: new Set(['-name', '-type', '-maxdepth', '-mindepth', '-mtime', '-size', '-print']),
    valueFlags: new Set(['-name', '-type', '-maxdepth', '-mindepth', '-mtime', '-size']),
    pathMode: 'fixed',
    pathArgIndices: [0],
  }),
  // cd 只换当前 shell 的目录，不碰任何文件。不收进来的话，每条带 cd 的命令都会被当成未识别命令拖到中危
  cd: rule('cd', 'safe', { safeFlags: new Set(['-P', '-L']), pathMode: 'all' }),
  pwd: rule('pwd', 'safe', { pathMode: 'none' }),
  echo: rule('echo', 'safe', { pathMode: 'none' }),
  sleep: rule('sleep', 'safe', { pathMode: 'none' }),
  true: rule('true', 'safe', { pathMode: 'none' }),
  false: rule('false', 'safe', { pathMode: 'none' }),
  date: rule('date', 'safe', { safeFlags: new Set(['-u', '-I']), pathMode: 'none' }),
  whoami: rule('whoami', 'safe', { pathMode: 'none' }),
  id: rule('id', 'safe', { pathMode: 'none' }),
  wc: rule('wc', 'safe', { safeFlags: new Set(['-l', '-w', '-c']), pathMode: 'all' }),
  sort: rule('sort', 'safe', { safeFlags: new Set(['-n', '-r', '-u']), pathMode: 'all' }),
  uniq: rule('uniq', 'safe', { safeFlags: new Set(['-c', '-d']), pathMode: 'all' }),
  diff: rule('diff', 'safe', { safeFlags: new Set(['-u', '-r', '-q']), pathMode: 'all' }),
  file: rule('file', 'safe', { pathMode: 'all' }),
  stat: rule('stat', 'safe', { pathMode: 'all' }),
  test: rule('test', 'safe', { pathMode: 'none' }),
  '[': rule('[', 'safe', { pathMode: 'none' }),
  which: rule('which', 'safe', { pathMode: 'all' }),
  type: rule('type', 'safe', { pathMode: 'all' }),
  printenv: rule('printenv', 'safe', { pathMode: 'none' }),
  git: rule('git', 'safe', {
    safeFlags: new Set(['-C', '--git-dir', '--work-tree', '-c']),
    valueFlags: new Set(['-C', '--git-dir', '--work-tree', '-c']),
    pathMode: 'none',
  }),
  // node: -e / --eval 不作为 safeFlag —— 内联 JS 代码无法静态审计，
  // 由 indirection-guard 在共享层直接 blocked。--version 仍 safe。
  node: rule('node', 'safe', {
    safeFlags: new Set(['-v', '--version']),
    pathMode: 'all',
  }),
  // python / python3: -c 不作为 safeFlag —— 内联 Python 代码无法静态审计，
  // 由 indirection-guard 在共享层直接 blocked。-m（跑已安装模块）保留。
  python: rule('python', 'safe', {
    safeFlags: new Set(['-m', '-V', '--version']),
    valueFlags: new Set(['-m']),
    pathMode: 'all',
  }),
  python3: rule('python3', 'safe', {
    safeFlags: new Set(['-m', '-V', '--version']),
    valueFlags: new Set(['-m']),
    pathMode: 'all' }),
  npm: rule('npm', 'moderate', {
    safeFlags: new Set(['run', 'test', 'ci', 'ls', 'list', 'view', 'outdated', '--']),
    pathMode: 'none',
  }),

  // —— 常见只读 / 无害 ——
  printf: rule('printf', 'safe', { pathMode: 'none' }),
  seq: rule('seq', 'safe', { pathMode: 'none' }),
  uname: rule('uname', 'safe', { safeFlags: new Set(['-a', '-s', '-m', '-r']), pathMode: 'none' }),
  hostname: rule('hostname', 'safe', { pathMode: 'none' }),
  uptime: rule('uptime', 'safe', { pathMode: 'none' }),
  who: rule('who', 'safe', { pathMode: 'none' }),
  w: rule('w', 'safe', { pathMode: 'none' }),
  du: rule('du', 'safe', {
    safeFlags: new Set(['-h', '-s', '-a', '-d']),
    valueFlags: new Set(['-d']),
    pathMode: 'all',
  }),
  df: rule('df', 'safe', { safeFlags: new Set(['-h']), pathMode: 'none' }),
  free: rule('free', 'safe', { safeFlags: new Set(['-h', '-m']), pathMode: 'none' }),
  env: rule('env', 'safe', { safeFlags: new Set(['-i', '-u', '-C', '-v', '-0']), valueFlags: new Set(['-u', '-C']), pathMode: 'none' }),
  ps: rule('ps', 'safe', { safeFlags: new Set(['-e', '-f', '-l', '-a', '-u', '-x', '-ef', '-aux', '-aux']), pathMode: 'none' }),
  lsof: rule('lsof', 'safe', { safeFlags: new Set(['-i', '-P', '-n', '-t', '-c', '-u']), valueFlags: new Set(['-i', '-c', '-u']), pathMode: 'none' }),
  basename: rule('basename', 'safe', { pathMode: 'all' }),
  dirname: rule('dirname', 'safe', { pathMode: 'all' }),
  readlink: rule('readlink', 'safe', { safeFlags: new Set(['-f']), pathMode: 'all' }),
  realpath: rule('realpath', 'safe', { pathMode: 'all' }),
  cut: rule('cut', 'safe', {
    safeFlags: new Set(['-d', '-f', '-c']),
    valueFlags: new Set(['-d', '-f', '-c']),
    pathMode: 'all',
  }),
  tr: rule('tr', 'safe', { pathMode: 'none' }),
  awk: rule('awk', 'safe', { safeFlags: new Set(['-F', '-v', '-f']), valueFlags: new Set(['-F', '-v', '-f']), pathMode: 'all' }),
  nl: rule('nl', 'safe', { pathMode: 'all' }),
  jq: rule('jq', 'safe', {
    safeFlags: new Set(['-r', '-c', '-e']),
    valueFlags: new Set(['-e']),
    pathMode: 'all',
  }),
  base64: rule('base64', 'safe', { safeFlags: new Set(['-d', '-D']), pathMode: 'all' }),
  shasum: rule('shasum', 'safe', { safeFlags: new Set(['-a']), valueFlags: new Set(['-a']), pathMode: 'all' }),
  md5: rule('md5', 'safe', { pathMode: 'all' }),
  md5sum: rule('md5sum', 'safe', { pathMode: 'all' }),
  sha256sum: rule('sha256sum', 'safe', { pathMode: 'all' }),
  cal: rule('cal', 'safe', { pathMode: 'none' }),
  clear: rule('clear', 'safe', { pathMode: 'none' }),
  tty: rule('tty', 'safe', { pathMode: 'none' }),
  groups: rule('groups', 'safe', { pathMode: 'none' }),
  users: rule('users', 'safe', { pathMode: 'none' }),
  logname: rule('logname', 'safe', { pathMode: 'none' }),
  rg: rule('rg', 'safe', {
    safeFlags: new Set(['-i', '-n', '-c', '-l', '-F', '-w', '--color']),
    pathMode: 'all',
  }),
  curl: rule('curl', 'moderate', {
    safeFlags: new Set(['-s', '-S', '-f', '-L', '-o', '-O', '-I', '-H']),
    valueFlags: new Set(['-o', '-O', '-H']),
    pathMode: 'none',
  }),

  // —— 写/删/改（baseLevel 至少 moderate；路径分区可降级或升级） ——
  rm: rule('rm', 'dangerous', {
    safeFlags: new Set(['-r', '-f', '-rf', '-fr', '-R', '-v', '-i']),
    pathMode: 'all',
    writesTo: true,
  }),
  mv: rule('mv', 'moderate', { safeFlags: new Set(['-f', '-n', '-v']), pathMode: 'all', writesTo: true }),
  cp: rule('cp', 'safe', {
    safeFlags: new Set(['-r', '-R', '-f', '-p', '-v', '-a']),
    pathMode: 'all',
    writesTo: true,
  }),
  mkdir: rule('mkdir', 'moderate', { safeFlags: new Set(['-p', '-m']), valueFlags: new Set(['-m']), pathMode: 'all', writesTo: true }),
  touch: rule('touch', 'moderate', { pathMode: 'all', writesTo: true }),
  // chmod/chown：改项目文件权限是日常操作；写 /etc 等仍由路径守卫升 dangerous/blocked
  chmod: rule('chmod', 'moderate', { safeFlags: new Set(['-R', '-v']), pathMode: 'all', writesTo: true }),
  chown: rule('chown', 'moderate', { safeFlags: new Set(['-R', '-v', '-h']), pathMode: 'all', writesTo: true }),
  chgrp: rule('chgrp', 'moderate', { safeFlags: new Set(['-R', '-v', '-h']), pathMode: 'all', writesTo: true }),
  ln: rule('ln', 'moderate', { safeFlags: new Set(['-s', '-f']), pathMode: 'all', writesTo: true }),
  tee: rule('tee', 'moderate', { safeFlags: new Set(['-a']), pathMode: 'all', writesTo: true }),
  mktemp: rule('mktemp', 'moderate', { safeFlags: new Set(['-d', '-u']), pathMode: 'none', writesTo: true }),

  // —— 显式高危：不可逆破坏 / 提权 / 关机 / 防火墙 / 账户 ——
  // 日常运维（包管理、容器、kill、systemctl、chmod、mount、crontab）→ 中风险
  // dd 参数为 if=/ of=/ 赋值形，不能当路径分区，否则会误落入 scratch 变 safe
  dd: rule('dd', 'dangerous', { pathMode: 'none', writesTo: false }),
  shred: rule('shred', 'dangerous', {
    safeFlags: new Set(['-f', '-u', '-v', '-z', '-n']),
    valueFlags: new Set(['-n']),
    pathMode: 'all',
    writesTo: true,
  }),
  mkfs: rule('mkfs', 'dangerous', { pathMode: 'all', writesTo: true }),
  'mkfs.ext4': rule('mkfs.ext4', 'dangerous', { pathMode: 'all', writesTo: true }),
  'mkfs.xfs': rule('mkfs.xfs', 'dangerous', { pathMode: 'all', writesTo: true }),
  'mkfs.vfat': rule('mkfs.vfat', 'dangerous', { pathMode: 'all', writesTo: true }),
  fdisk: rule('fdisk', 'dangerous', { pathMode: 'all', writesTo: true }),
  parted: rule('parted', 'dangerous', { pathMode: 'all', writesTo: true }),
  wipefs: rule('wipefs', 'dangerous', { pathMode: 'all', writesTo: true }),
  format: rule('format', 'dangerous', { pathMode: 'all', writesTo: true }),

  sudo: rule('sudo', 'dangerous', { pathMode: 'none' }),
  su: rule('su', 'dangerous', { pathMode: 'none' }),
  doas: rule('doas', 'dangerous', { pathMode: 'none' }),
  shutdown: rule('shutdown', 'dangerous', { pathMode: 'none' }),
  reboot: rule('reboot', 'dangerous', { pathMode: 'none' }),
  halt: rule('halt', 'dangerous', { pathMode: 'none' }),
  poweroff: rule('poweroff', 'dangerous', { pathMode: 'none' }),
  init: rule('init', 'dangerous', { pathMode: 'none' }),

  iptables: rule('iptables', 'dangerous', { pathMode: 'none' }),
  ip6tables: rule('ip6tables', 'dangerous', { pathMode: 'none' }),
  nft: rule('nft', 'dangerous', { pathMode: 'none' }),
  ufw: rule('ufw', 'dangerous', { pathMode: 'none' }),

  useradd: rule('useradd', 'dangerous', { pathMode: 'none' }),
  userdel: rule('userdel', 'dangerous', { pathMode: 'none' }),
  passwd: rule('passwd', 'dangerous', { pathMode: 'none' }),
  visudo: rule('visudo', 'dangerous', { pathMode: 'none' }),

  // —— 中风险运维：日常 Agent 高频，relaxed 默认放行，strict 仍确认 ——
  mount: rule('mount', 'moderate', { pathMode: 'all', writesTo: true }),
  umount: rule('umount', 'moderate', { pathMode: 'all', writesTo: true }),
  crontab: rule('crontab', 'moderate', { pathMode: 'none' }),
  kill: rule('kill', 'moderate', {
    safeFlags: new Set(['-l', '-s']),
    valueFlags: new Set(['-s']),
    pathMode: 'none',
  }),
  killall: rule('killall', 'moderate', { pathMode: 'none' }),
  pkill: rule('pkill', 'moderate', { pathMode: 'none' }),
  systemctl: rule('systemctl', 'moderate', { pathMode: 'none' }),
  service: rule('service', 'moderate', { pathMode: 'none' }),
  sysctl: rule('sysctl', 'moderate', { pathMode: 'none' }),
  timedatectl: rule('timedatectl', 'moderate', { pathMode: 'none' }),
  hostnamectl: rule('hostnamectl', 'moderate', { pathMode: 'none' }),
  'apt-get': rule('apt-get', 'moderate', { pathMode: 'none' }),
  apt: rule('apt', 'moderate', { pathMode: 'none' }),
  yum: rule('yum', 'moderate', { pathMode: 'none' }),
  dnf: rule('dnf', 'moderate', { pathMode: 'none' }),
  pacman: rule('pacman', 'moderate', { pathMode: 'none' }),
  brew: rule('brew', 'moderate', { pathMode: 'none' }),
  pip: rule('pip', 'moderate', { pathMode: 'none' }),
  pip3: rule('pip3', 'moderate', { pathMode: 'none' }),
  docker: rule('docker', 'moderate', { pathMode: 'none' }),
  'docker-compose': rule('docker-compose', 'moderate', { pathMode: 'none' }),
  npx: rule('npx', 'moderate', { pathMode: 'none' }),

  // —— Windows PowerShell cmdlet（与 Unix 命令对齐） ——
  'remove-item': rule('remove-item', 'dangerous', {
    safeFlags: new Set(['-Force', '-Recurse', '-LiteralPath', '-Path', '-Confirm', '-WhatIf', '-Verbose', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Include', '-Exclude', '-Filter', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'get-content': rule('get-content', 'safe', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-TotalCount', '-Tail', '-Wait', '-Raw', '-Encoding', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-TotalCount', '-Tail', '-Encoding', '-ErrorAction']),
    pathMode: 'all',
  }),
  'get-childitem': rule('get-childitem', 'safe', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Recurse', '-Force', '-Filter', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Filter', '-ErrorAction']),
    pathMode: 'all',
  }),
  'copy-item': rule('copy-item', 'safe', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Destination', '-Recurse', '-Force', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Destination', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'move-item': rule('move-item', 'moderate', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Destination', '-Force', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Destination', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'new-item': rule('new-item', 'moderate', {
    safeFlags: new Set(['-Path', '-ItemType', '-Force', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-ItemType', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'rename-item': rule('rename-item', 'moderate', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-NewName', '-Force', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-NewName', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'set-content': rule('set-content', 'moderate', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Force', '-Encoding', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Encoding', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'add-content': rule('add-content', 'moderate', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Encoding', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-Encoding', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'clear-content': rule('clear-content', 'dangerous', {
    safeFlags: new Set(['-Path', '-LiteralPath', '-Force', '-ErrorAction']),
    valueFlags: new Set(['-Path', '-LiteralPath', '-ErrorAction']),
    pathMode: 'all',
    writesTo: true,
  }),
  'stop-process': rule('stop-process', 'moderate', { pathMode: 'none' }),
  'stop-service': rule('stop-service', 'moderate', { pathMode: 'none' }),
  'restart-service': rule('restart-service', 'moderate', { pathMode: 'none' }),
  'start-service': rule('start-service', 'moderate', { pathMode: 'none' }),
  'remove-service': rule('remove-service', 'dangerous', { pathMode: 'none' }),
  'stop-computer': rule('stop-computer', 'dangerous', { pathMode: 'none' }),
  'restart-computer': rule('restart-computer', 'dangerous', { pathMode: 'none' }),
}

/** 从 cmd 路径提取命令名（/usr/bin/grep → grep） */
export function basenameCommand(cmd: string): string {
  const base = path.basename(cmd.trim())
  if (process.platform === 'win32' && base.toLowerCase().endsWith('.exe')) {
    return base.slice(0, -4)
  }
  return base
}

/** 仅查内置表（不含用户规则） */
export function getBuiltinArgvCommandRule(cmd: string): CommandRule | undefined {
  const name = basenameCommand(cmd).toLowerCase()
  return ARGV_COMMAND_RULES[name]
}

/**
 * 未知 flag → 至少 moderate（safe 升 moderate）；不得低于 baseLevel
 * （否则 kill -9 / sudo -u 等会把 dangerous 误降为 moderate）。
 */
export function assessCommandFlags(rule: CommandRule, flags: string[]): RiskLevel {
  const allowed = rule.safeFlags
  for (const f of flags) {
    if (!allowed.has(f)) {
      // head/tail 等命令的数字简写 flag（-5 = -n 5）
      if (f.startsWith('-') && !f.startsWith('--') && /^\d+$/.test(f.slice(1))) {
        continue
      }
      // 单个字符的拆分 flag（如 -rf 拆出的 -r/-f）一定已检查过；
      // 这里 f 是原 flag 或长度 > 4 的长 flag。如果原 flag 本身不在 allowed，
      // 检查它是否由 allowed 中的单字符 flag 组合而成（如 -lart 由 -l/-a/-r/-t 组成），
      // 这样 -lart / -lahr 等常见组合不会因长度阈值而误报。
      if (f.startsWith('-') && !f.startsWith('--') && f.length > 2) {
        const chars = f.slice(1).split('')
        if (chars.length > 0 && chars.every(ch => allowed.has(`-${ch}`))) {
          continue  // 整体是已知单字符 flag 的组合，放行
        }
      }
      return maxRisk(rule.baseLevel, 'moderate')
    }
  }
  // rm -rf 在工作区外仍由路径守卫处理；命令级保持 dangerous
  return rule.baseLevel
}


