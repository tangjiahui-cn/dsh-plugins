import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { npmBin as defaultNpmBin, npmCacheDir as defaultCacheDir } from './config.mjs'
import { ReleaseError, runCommand } from './util.mjs'

function packJson(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new ReleaseError(`npm pack 输出不是 JSON：${stdout.slice(0, 300)}`)
  }
  return JSON.parse(stdout.slice(start, end + 1))
}

/** 执行 npm pack --dry-run --json，返回 tarball 内文件路径。 */
export async function packDryRun(pkg, options = {}) {
  const npmBin = options.npmBin ?? defaultNpmBin
  const cacheDir = options.cacheDir ?? defaultCacheDir
  const result = await runCommand(
    npmBin,
    ['pack', '--dry-run', '--json', '--cache', cacheDir],
    { cwd: pkg.dir, env: options.env },
  )
  if (result.error !== undefined) {
    throw new ReleaseError(`无法执行 npm pack：${result.error.message}`)
  }
  if (result.code !== 0) {
    throw new ReleaseError(`npm pack 失败（${pkg.name}）：${result.stderr.trim() || result.stdout.trim()}`)
  }
  const parsed = packJson(result.stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || !Array.isArray(entry.files)) {
    throw new ReleaseError(`npm pack 没有返回文件列表（${pkg.name}）`)
  }
  return entry.files.map(file => file.path)
}

function flattenExportTargets(value, result = []) {
  if (typeof value === 'string') result.push(value)
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) flattenExportTargets(nested, result)
  }
  return result
}

function globToRegExp(pattern) {
  const normalized = pattern.replace(/^\.\//, '')
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`)
}

const RELATIVE_IMPORT = /\b(?:from\s*|import\s*|import\(\s*)['"](\.[^'"]*)['"]/g

function resolveRelative(importer, specifier, packed) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}/index.js`]
  return candidates.find(candidate => packed.has(candidate))
}

/** 校验 exports、bundle patch、locale、icon 与相对导入闭包都在 tarball 内。 */
export async function assertPackContents(pkg, files) {
  const packed = new Set(files)
  const errors = []

  const patch = pkg.manifest.dsh?.bundle?.patch
  if (typeof patch === 'string') {
    const normalized = patch.replace(/^\.\//, '')
    if (!packed.has(normalized)) errors.push(`bundle patch 不在 tarball 内：${patch}`)
  }

  for (const target of flattenExportTargets(pkg.manifest.exports ?? {})) {
    const normalized = target.replace(/^\.\//, '')
    const matched = normalized.includes('*') || normalized.includes('?')
      ? files.some(file => globToRegExp(normalized).test(file))
      : packed.has(normalized)
    if (!matched) errors.push(`exports 目标不在 tarball 内：${target}`)
  }

  const queue = files.filter(file => /\.(?:js|mjs|cjs)$/.test(file))
  const scanned = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (scanned.has(file)) continue
    scanned.add(file)
    let source
    try {
      source = await readFile(join(pkg.dir, file), 'utf8')
    } catch (error) {
      errors.push(`无法读取 tarball 文件 ${file}：${error.message}`)
      continue
    }
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1]
      const resolved = resolveRelative(file, specifier, packed)
      if (resolved === undefined) {
        errors.push(`${file} 引用的 ${specifier} 不在 tarball 内`)
      } else if (!scanned.has(resolved)) {
        queue.push(resolved)
      }
    }
  }

  if (errors.length > 0) {
    throw new ReleaseError(
      `打包内容校验失败（${pkg.name}）：\n${errors.map(error => `  - ${error}`).join('\n')}`,
    )
  }
  return files
}
