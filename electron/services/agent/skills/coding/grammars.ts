/**
 * 编程技能 - 改后语法检查认得的语言（扩展名 → tree-sitter-wasms 里的语法名）
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
}

export const BUNDLED_GRAMMARS: readonly string[] = [...new Set(Object.values(GRAMMAR_BY_EXTENSION))]

/** 打包后 wasm 所在目录（相对主进程产物目录） */
export const BUNDLED_WASM_DIR = 'tree-sitter'
