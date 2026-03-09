/**
 * 代码结构查询工具
 * 基于 ts-morph 提供类层次、方法签名、引用查找等能力
 *
 * 用法: npx tsx scripts/code-query.ts <command> [args]
 *
 * 命令:
 *   hierarchy <ClassName>              查看类继承链
 *   methods <ClassName>                列出类的公开方法
 *   outline <file>                     文件结构概览（类、函数、导出）
 *   deps <file>                        文件的 import 依赖
 *   refs <SymbolName> [--files-only]   查找符号引用
 *   exports <file>                     文件的所有导出
 *   interfaces <file|ClassName>        接口/类型定义
 */

import { Project, SyntaxKind, Node, ClassDeclaration, SourceFile, Scope } from 'ts-morph'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')

let _project: Project | null = null
function getProject(): Project {
  if (!_project) {
    _project = new Project({
      tsConfigFilePath: path.join(ROOT, 'tsconfig.node.json'),
      skipAddingFilesFromTsConfig: false,
    })
    // Also add frontend files for cross-boundary queries
    _project.addSourceFilesAtPaths(path.join(ROOT, 'shared/**/*.ts'))
  }
  return _project
}

function resolveFile(input: string): string {
  if (path.isAbsolute(input)) return input
  return path.join(ROOT, input)
}

function getSourceFile(filePath: string): SourceFile {
  const resolved = resolveFile(filePath)
  const project = getProject()
  const sf = project.getSourceFile(resolved)
  if (!sf) {
    throw new Error(`File not found in project: ${filePath}`)
  }
  return sf
}

function findClass(name: string): ClassDeclaration | undefined {
  const project = getProject()
  for (const sf of project.getSourceFiles()) {
    const cls = sf.getClass(name)
    if (cls) return cls
  }
  return undefined
}

// ==================== Commands ====================

function cmdHierarchy(className: string) {
  const cls = findClass(className)
  if (!cls) {
    console.log(`Class "${className}" not found`)
    return
  }

  // Ancestors
  const ancestors: string[] = []
  let current = cls.getBaseClass()
  while (current) {
    const file = current.getSourceFile().getFilePath().replace(ROOT + '/', '')
    ancestors.push(`${current.getName()} (${file})`)
    current = current.getBaseClass()
  }

  // Descendants
  const descendants: string[] = []
  const project = getProject()
  for (const sf of project.getSourceFiles()) {
    for (const c of sf.getClasses()) {
      if (c.getBaseClass()?.getName() === className && c.getName() !== className) {
        const file = sf.getFilePath().replace(ROOT + '/', '')
        descendants.push(`${c.getName()} (${file})`)
      }
    }
  }

  // Implements
  const implements_ = cls.getImplements().map(i => i.getText())

  const file = cls.getSourceFile().getFilePath().replace(ROOT + '/', '')
  console.log(`=== ${className} (${file}) ===`)

  if (ancestors.length > 0) {
    console.log(`\nExtends:`)
    ancestors.forEach((a, i) => console.log(`  ${'  '.repeat(i)}← ${a}`))
  }

  if (implements_.length > 0) {
    console.log(`\nImplements: ${implements_.join(', ')}`)
  }

  if (descendants.length > 0) {
    console.log(`\nSubclasses:`)
    descendants.forEach(d => console.log(`  → ${d}`))
  }

  if (ancestors.length === 0 && descendants.length === 0 && implements_.length === 0) {
    console.log('  (no inheritance relationships)')
  }
}

function cmdMethods(className: string) {
  const cls = findClass(className)
  if (!cls) {
    console.log(`Class "${className}" not found`)
    return
  }

  const file = cls.getSourceFile().getFilePath().replace(ROOT + '/', '')
  console.log(`=== ${className} (${file}) ===\n`)

  const methods = cls.getMethods()
  const publicMethods = methods.filter(m => {
    const scope = m.getScope()
    return scope === undefined || scope === Scope.Public
  })
  const protectedMethods = methods.filter(m => m.getScope() === Scope.Protected)
  const privateMethods = methods.filter(m => m.getScope() === Scope.Private)

  const formatMethod = (m: ReturnType<ClassDeclaration['getMethods']>[0]) => {
    const async_ = m.isAsync() ? 'async ' : ''
    const static_ = m.isStatic() ? 'static ' : ''
    const params = m.getParameters().map(p => {
      const optional = p.isOptional() ? '?' : ''
      const type = p.getType().getText(p).replace(/import\([^)]+\)\./g, '')
      const short = type.length > 40 ? type.slice(0, 37) + '...' : type
      return `${p.getName()}${optional}: ${short}`
    }).join(', ')
    const returnType = m.getReturnType().getText(m).replace(/import\([^)]+\)\./g, '')
    const shortReturn = returnType.length > 50 ? returnType.slice(0, 47) + '...' : returnType
    return `${async_}${static_}${m.getName()}(${params}): ${shortReturn}`
  }

  if (publicMethods.length > 0) {
    console.log(`Public (${publicMethods.length}):`)
    publicMethods.forEach(m => console.log(`  ${formatMethod(m)}`))
  }

  if (protectedMethods.length > 0) {
    console.log(`\nProtected (${protectedMethods.length}):`)
    protectedMethods.forEach(m => console.log(`  ${formatMethod(m)}`))
  }

  if (privateMethods.length > 0) {
    console.log(`\nPrivate (${privateMethods.length}):`)
    privateMethods.forEach(m => console.log(`  ${formatMethod(m)}`))
  }

  // Properties
  const props = cls.getProperties()
  if (props.length > 0) {
    console.log(`\nProperties (${props.length}):`)
    props.forEach(p => {
      const scope = p.getScope() || 'public'
      const type = p.getType().getText(p).replace(/import\([^)]+\)\./g, '')
      const short = type.length > 50 ? type.slice(0, 47) + '...' : type
      console.log(`  [${scope}] ${p.getName()}: ${short}`)
    })
  }
}

function cmdOutline(filePath: string) {
  const sf = getSourceFile(filePath)
  const rel = sf.getFilePath().replace(ROOT + '/', '')
  console.log(`=== ${rel} ===\n`)

  // Classes
  const classes = sf.getClasses()
  if (classes.length > 0) {
    console.log('Classes:')
    classes.forEach(cls => {
      const base = cls.getBaseClass()?.getName()
      const ext = base ? ` extends ${base}` : ''
      const methods = cls.getMethods().length
      const props = cls.getProperties().length
      console.log(`  ${cls.isExported() ? 'export ' : ''}class ${cls.getName()}${ext} (${methods} methods, ${props} props)`)
    })
    console.log()
  }

  // Interfaces
  const interfaces = sf.getInterfaces()
  if (interfaces.length > 0) {
    console.log('Interfaces:')
    interfaces.forEach(iface => {
      const props = iface.getProperties().length
      const methods = iface.getMethods().length
      console.log(`  ${iface.isExported() ? 'export ' : ''}interface ${iface.getName()} (${props} props, ${methods} methods)`)
    })
    console.log()
  }

  // Type aliases
  const types = sf.getTypeAliases()
  if (types.length > 0) {
    console.log('Types:')
    types.forEach(t => {
      console.log(`  ${t.isExported() ? 'export ' : ''}type ${t.getName()} = ${t.getType().getText(t).slice(0, 60)}`)
    })
    console.log()
  }

  // Functions
  const functions = sf.getFunctions()
  if (functions.length > 0) {
    console.log('Functions:')
    functions.forEach(fn => {
      const async_ = fn.isAsync() ? 'async ' : ''
      console.log(`  ${fn.isExported() ? 'export ' : ''}${async_}function ${fn.getName()}(${fn.getParameters().length} params)`)
    })
    console.log()
  }

  // Variable declarations (exports)
  const vars = sf.getVariableDeclarations().filter(v => v.isExported())
  if (vars.length > 0) {
    console.log('Exported variables:')
    vars.forEach(v => {
      const type = v.getType().getText(v).replace(/import\([^)]+\)\./g, '')
      const short = type.length > 60 ? type.slice(0, 57) + '...' : type
      console.log(`  ${v.getName()}: ${short}`)
    })
    console.log()
  }
}

function cmdDeps(filePath: string) {
  const sf = getSourceFile(filePath)
  const rel = sf.getFilePath().replace(ROOT + '/', '')
  console.log(`=== Dependencies of ${rel} ===\n`)

  const imports = sf.getImportDeclarations()

  const internal: string[] = []
  const external: string[] = []

  imports.forEach(imp => {
    const module = imp.getModuleSpecifierValue()
    const names = [
      ...imp.getNamedImports().map(n => n.getName()),
    ]
    const defaultImport = imp.getDefaultImport()?.getText()
    if (defaultImport) names.unshift(defaultImport)
    const namespaceImport = imp.getNamespaceImport()?.getText()
    if (namespaceImport) names.unshift(`* as ${namespaceImport}`)

    const nameStr = names.length > 0 ? ` { ${names.join(', ')} }` : ''

    if (module.startsWith('.') || module.startsWith('@shared') || module.startsWith('@electron')) {
      // Resolve to actual file
      const sourceFile = imp.getModuleSpecifierSourceFile()
      const resolvedPath = sourceFile?.getFilePath().replace(ROOT + '/', '') || module
      internal.push(`${resolvedPath}${nameStr}`)
    } else {
      external.push(`${module}${nameStr}`)
    }
  })

  if (internal.length > 0) {
    console.log(`Internal (${internal.length}):`)
    internal.forEach(d => console.log(`  ${d}`))
  }

  if (external.length > 0) {
    console.log(`\nExternal (${external.length}):`)
    external.forEach(d => console.log(`  ${d}`))
  }
}

function cmdRefs(symbolName: string, filesOnly: boolean) {
  const project = getProject()

  // Find the symbol definition
  let found = false
  for (const sf of project.getSourceFiles()) {
    // Search in classes
    for (const cls of sf.getClasses()) {
      if (cls.getName() === symbolName) {
        printRefs(cls, symbolName, filesOnly)
        found = true
        break
      }
      // Search methods
      for (const method of cls.getMethods()) {
        const fullName = `${cls.getName()}.${method.getName()}`
        if (fullName === symbolName || method.getName() === symbolName) {
          printRefs(method, fullName, filesOnly)
          found = true
          break
        }
      }
      if (found) break
    }
    if (found) break

    // Search in functions
    for (const fn of sf.getFunctions()) {
      if (fn.getName() === symbolName) {
        printRefs(fn, symbolName, filesOnly)
        found = true
        break
      }
    }
    if (found) break

    // Search in interfaces
    for (const iface of sf.getInterfaces()) {
      if (iface.getName() === symbolName) {
        printRefs(iface, symbolName, filesOnly)
        found = true
        break
      }
    }
    if (found) break

    // Search in type aliases
    for (const t of sf.getTypeAliases()) {
      if (t.getName() === symbolName) {
        printRefs(t, symbolName, filesOnly)
        found = true
        break
      }
    }
    if (found) break
  }

  if (!found) {
    console.log(`Symbol "${symbolName}" not found`)
  }
}

function printRefs(node: Node, symbolName: string, filesOnly: boolean) {
  const defFile = node.getSourceFile().getFilePath().replace(ROOT + '/', '')
  console.log(`=== References to ${symbolName} ===`)
  console.log(`Defined in: ${defFile}:${node.getStartLineNumber()}\n`)

  const refs = (node as any).findReferencesAsNodes?.() as Node[] | undefined
  if (!refs || refs.length === 0) {
    console.log('  No references found')
    return
  }

  if (filesOnly) {
    const files = new Set<string>()
    refs.forEach(ref => {
      files.add(ref.getSourceFile().getFilePath().replace(ROOT + '/', ''))
    })
    console.log(`Referenced in ${files.size} files:`)
    Array.from(files).sort().forEach(f => console.log(`  ${f}`))
  } else {
    const byFile = new Map<string, number[]>()
    refs.forEach(ref => {
      const file = ref.getSourceFile().getFilePath().replace(ROOT + '/', '')
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file)!.push(ref.getStartLineNumber())
    })

    console.log(`${refs.length} references in ${byFile.size} files:`)
    Array.from(byFile.entries()).sort().forEach(([file, lines]) => {
      console.log(`  ${file}: L${lines.join(', L')}`)
    })
  }
}

function cmdExports(filePath: string) {
  const sf = getSourceFile(filePath)
  const rel = sf.getFilePath().replace(ROOT + '/', '')
  console.log(`=== Exports of ${rel} ===\n`)

  const exportedDecls = sf.getExportedDeclarations()
  exportedDecls.forEach((decls, name) => {
    decls.forEach(decl => {
      const kind = decl.getKindName()
      const line = decl.getStartLineNumber()
      const file = decl.getSourceFile().getFilePath().replace(ROOT + '/', '')
      const isReExport = file !== rel
      const from = isReExport ? ` (from ${file})` : ''
      console.log(`  ${name}: ${kind} L${line}${from}`)
    })
  })
}

function cmdInterfaces(input: string) {
  // If input looks like a file path, show interfaces in that file
  if (input.includes('/') || input.includes('.ts')) {
    const sf = getSourceFile(input)
    const rel = sf.getFilePath().replace(ROOT + '/', '')
    console.log(`=== Interfaces & Types in ${rel} ===\n`)

    sf.getInterfaces().forEach(iface => {
      console.log(`interface ${iface.getName()} {`)
      iface.getProperties().forEach(p => {
        const optional = p.hasQuestionToken() ? '?' : ''
        const type = p.getType().getText(p).replace(/import\([^)]+\)\./g, '')
        const short = type.length > 60 ? type.slice(0, 57) + '...' : type
        console.log(`  ${p.getName()}${optional}: ${short}`)
      })
      console.log('}\n')
    })

    sf.getTypeAliases().forEach(t => {
      const type = t.getType().getText(t).replace(/import\([^)]+\)\./g, '')
      console.log(`type ${t.getName()} = ${type}\n`)
    })
  } else {
    // Search for interface/type by name, prefer electron/services/ and shared/ over preload etc.
    const project = getProject()
    const candidates: Array<{ iface: ReturnType<SourceFile['getInterface']>; file: string }> = []
    for (const sf of project.getSourceFiles()) {
      const iface = sf.getInterface(input)
      if (iface) {
        candidates.push({ iface, file: sf.getFilePath().replace(ROOT + '/', '') })
      }
    }
    // Prefer definitions in services/ or shared/ directories
    const preferred = candidates.find(c => c.file.includes('/services/') || c.file.includes('shared/'))
    const match = preferred || candidates[0]
    if (match && match.iface) {
      console.log(`=== ${input} (${match.file}) ===\n`)
      console.log(`interface ${input} {`)
      match.iface.getProperties().forEach(p => {
        const optional = p.hasQuestionToken() ? '?' : ''
        const type = p.getType().getText(p).replace(/import\([^)]+\)\./g, '')
        const short = type.length > 60 ? type.slice(0, 57) + '...' : type
        console.log(`  ${p.getName()}${optional}: ${short}`)
      })
      console.log('}')
    } else {
      console.log(`Interface "${input}" not found`)
    }
  }
}

// ==================== Help ====================

function printHelp() {
  console.log(`
Usage: npx tsx scripts/code-query.ts <command> [args]

Commands:
  hierarchy <ClassName>              Class inheritance chain
  methods <ClassName>                List class methods & properties
  outline <file>                     File structure overview
  deps <file>                        File import dependencies
  refs <Symbol> [--files-only]       Find symbol references
  exports <file>                     File exports
  interfaces <file|Name>             Interface/type definitions

Examples:
  npx tsx scripts/code-query.ts hierarchy Agent
  npx tsx scripts/code-query.ts methods AgentService
  npx tsx scripts/code-query.ts outline electron/services/agent/agent.ts
  npx tsx scripts/code-query.ts deps electron/services/agent/index.ts
  npx tsx scripts/code-query.ts refs AiService --files-only
  npx tsx scripts/code-query.ts interfaces AgentConfig
`.trim())
}

// ==================== Main ====================

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

try {
  switch (command) {
    case 'hierarchy':
      if (!args[1]) { console.log('Usage: hierarchy <ClassName>'); break }
      cmdHierarchy(args[1])
      break
    case 'methods':
      if (!args[1]) { console.log('Usage: methods <ClassName>'); break }
      cmdMethods(args[1])
      break
    case 'outline':
      if (!args[1]) { console.log('Usage: outline <file>'); break }
      cmdOutline(args[1])
      break
    case 'deps':
      if (!args[1]) { console.log('Usage: deps <file>'); break }
      cmdDeps(args[1])
      break
    case 'refs':
      if (!args[1]) { console.log('Usage: refs <SymbolName> [--files-only]'); break }
      cmdRefs(args[1], args.includes('--files-only'))
      break
    case 'exports':
      if (!args[1]) { console.log('Usage: exports <file>'); break }
      cmdExports(args[1])
      break
    case 'interfaces':
      if (!args[1]) { console.log('Usage: interfaces <file|InterfaceName>'); break }
      cmdInterfaces(args[1])
      break
    default:
      console.log(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
