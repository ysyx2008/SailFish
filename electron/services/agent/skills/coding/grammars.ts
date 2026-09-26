/**
 * 编程技能 - 改后语法检查认得的语言（扩展名 → 语法名，wasm 文件名为 tree-sitter-<语法名>.wasm）
 * 构建时按这张表把用到的语法 wasm 拷进安装包，所以这里不能 import 任何东西。
 */
export const GRAMMAR_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.c': 'c',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.rs': 'rust',
  '.lua': 'lua',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
}

export const BUNDLED_GRAMMARS: readonly string[] = [...new Set(Object.values(GRAMMAR_BY_EXTENSION))]

/**
 * tree-sitter-wasms 里这几种会调用底座不提供的 C/C++ 函数（解析到那一处才崩），或认错新写法，
 * 改用仓库里放的官方新版（来源见该目录 VERSION）
 */
const VENDORED_GRAMMARS: ReadonlySet<string> = new Set(['yaml', 'bash', 'css'])

/** 语法 wasm 在仓库里的目录（相对仓库根） */
export function grammarSourceDir(name: string): string {
  return VENDORED_GRAMMARS.has(name) ? 'resources/tree-sitter' : 'node_modules/tree-sitter-wasms/out'
}

/** 打包后 wasm 所在目录（相对主进程产物目录） */
export const BUNDLED_WASM_DIR = 'tree-sitter'
