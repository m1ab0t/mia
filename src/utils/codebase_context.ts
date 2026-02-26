import { readdir, stat, readFile } from 'fs/promises'
import { join, extname } from 'path'

// Important files to look for (in priority order)
const IMPORTANT_FILES = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'requirements.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  'README.md',
]

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  'target',
  'vendor',
  '.venv',
  'venv',
  'coverage',
  '.cache',
])

// Language detection by file extension
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript/React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript/React',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
}

// Framework detection patterns
const FRAMEWORK_PATTERNS: Record<
  string,
  { files?: string[]; deps?: string[] }
> = {
  'Next.js': { files: ['next.config.js', 'next.config.ts'], deps: ['next'] },
  React: { deps: ['react', 'react-dom'] },
  Vue: { deps: ['vue'] },
  Angular: { files: ['angular.json'], deps: ['@angular/core'] },
  Express: { deps: ['express'] },
  FastAPI: { deps: ['fastapi'] },
  Django: { deps: ['django'] },
  Flask: { deps: ['flask'] },
  NestJS: { deps: ['@nestjs/core'] },
  Electron: { deps: ['electron'] },
  Ink: { deps: ['ink'] },
}

export interface CodebaseContext {
  rootPath: string
  languages: string[]
  frameworks: string[]
  mainDirectories: string[]
  importantFiles: string[]
  entryPoints: string[]
  sourceFiles: string[]  // Key source files with full paths
  totalFiles: number
  summary: string
}

interface ScanResult {
  files: string[]
  dirs: string[]
  langCount: Record<string, number>
}

/**
 * Recursively scan directory (limited depth for speed)
 */
async function scanDirectory(
  dir: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
): Promise<ScanResult> {
  const result: ScanResult = { files: [], dirs: [], langCount: {} }

  if (currentDepth > maxDepth) return result

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && currentDepth > 0) continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        result.dirs.push(entry.name)
        if (currentDepth < maxDepth) {
          const subResult = await scanDirectory(
            fullPath,
            maxDepth,
            currentDepth + 1,
          )
          result.files.push(...subResult.files.map((f) => join(entry.name, f)))
          for (const [lang, count] of Object.entries(subResult.langCount)) {
            result.langCount[lang] = (result.langCount[lang] || 0) + count
          }
        }
      } else if (entry.isFile()) {
        result.files.push(entry.name)
        const ext = extname(entry.name)
        const lang = LANGUAGE_EXTENSIONS[ext]
        if (lang) {
          result.langCount[lang] = (result.langCount[lang] || 0) + 1
        }
      }
    }
  } catch {
    // Ignore permission errors
  }

  return result
}

/**
 * Detect frameworks from package.json or similar
 */
async function detectFrameworks(rootPath: string): Promise<string[]> {
  const frameworks: string[] = []

  // Check package.json
  try {
    const pkgPath = join(rootPath, 'package.json')
    const content = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(content)
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

    for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
      if (pattern.deps?.some((dep) => dep in allDeps)) {
        frameworks.push(framework)
      }
    }
  } catch {
    // No package.json
  }

  // Check for framework-specific files
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (pattern.files) {
      for (const file of pattern.files) {
        try {
          await stat(join(rootPath, file))
          if (!frameworks.includes(framework)) {
            frameworks.push(framework)
          }
          break
        } catch {
          // File doesn't exist
        }
      }
    }
  }

  return frameworks
}

/**
 * Find entry points
 */
async function findEntryPoints(
  rootPath: string,
  files: string[],
): Promise<string[]> {
  const entryPoints: string[] = []

  // Common entry point patterns
  const patterns = [
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'src/app.ts',
    'src/app.js',
    'index.ts',
    'index.js',
    'main.py',
    'app.py',
    'main.go',
    'main.rs',
    'lib.rs',
  ]

  for (const pattern of patterns) {
    if (files.includes(pattern)) {
      entryPoints.push(pattern)
    }
  }

  // Check package.json for main/bin
  try {
    const pkgPath = join(rootPath, 'package.json')
    const content = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(content)

    if (pkg.main) entryPoints.push(pkg.main)
    if (pkg.bin) {
      const bins =
        typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin)
      entryPoints.push(...(bins as string[]))
    }
  } catch {
    // No package.json
  }

  return [...new Set(entryPoints)]
}

/**
 * Gather codebase context for system prompt injection
 */
export async function gatherCodebaseContext(
  rootPath: string,
): Promise<CodebaseContext> {
  // Scan the directory
  const scan = await scanDirectory(rootPath)

  // Get top languages by file count
  const sortedLangs = Object.entries(scan.langCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang)

  // Detect frameworks
  const frameworks = await detectFrameworks(rootPath)

  // Find important files that exist
  const importantFiles: string[] = []
  for (const file of IMPORTANT_FILES) {
    if (scan.files.includes(file)) {
      importantFiles.push(file)
    }
  }

  // Get main directories (top-level only)
  const mainDirs = scan.dirs.filter((d) => !d.startsWith('.')).slice(0, 10)

  // Find entry points
  const entryPoints = await findEntryPoints(rootPath, scan.files)

  // Collect key source files (code files with paths, excluding tests)
  const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb'])
  const sourceFiles = scan.files
    .filter((f) => {
      const ext = extname(f)
      if (!sourceExtensions.has(ext)) return false
      // Exclude test files and config files
      if (f.includes('.test.') || f.includes('.spec.') || f.includes('__test__')) return false
      return true
    })
    .slice(0, 50) // Limit to 50 files for token efficiency

  // Build summary
  const summary = buildSummary({
    languages: sortedLangs,
    frameworks,
    mainDirectories: mainDirs,
    importantFiles,
    entryPoints,
    sourceFiles,
    totalFiles: scan.files.length,
  })

  return {
    rootPath,
    languages: sortedLangs,
    frameworks,
    mainDirectories: mainDirs,
    importantFiles,
    entryPoints,
    sourceFiles,
    totalFiles: scan.files.length,
    summary,
  }
}

/**
 * Build a concise summary string for system prompt
 */
function buildSummary(
  ctx: Omit<CodebaseContext, 'rootPath' | 'summary'>,
): string {
  const parts: string[] = []

  if (ctx.languages.length > 0) {
    parts.push(`Languages: ${ctx.languages.join(', ')}`)
  }

  if (ctx.frameworks.length > 0) {
    parts.push(`Frameworks: ${ctx.frameworks.join(', ')}`)
  }

  if (ctx.mainDirectories.length > 0) {
    parts.push(`Directories: ${ctx.mainDirectories.join(', ')}`)
  }

  if (ctx.entryPoints.length > 0) {
    parts.push(`Entry points: ${ctx.entryPoints.join(', ')}`)
  }

  if (ctx.importantFiles.length > 0) {
    parts.push(`Config files: ${ctx.importantFiles.slice(0, 5).join(', ')}`)
  }

  if (ctx.sourceFiles.length > 0) {
    parts.push(`Source files:\n${ctx.sourceFiles.map((f) => `  ${f}`).join('\n')}`)
  }

  parts.push(`Total files: ${ctx.totalFiles}`)

  return parts.join('\n')
}

/**
 * Generate a compact context string for the system prompt
 * Designed to be token-efficient
 */
export function formatContextForPrompt(ctx: CodebaseContext): string {
  return `CODEBASE CONTEXT (use these EXACT paths):
${ctx.summary}

FILE PATH RULES:
- Copy paths EXACTLY from the list above (e.g., "src/agent.ts" not "agent.ts")
- If file not listed, use fuzzy_search to find correct path first
- Never guess paths - always verify`
}
