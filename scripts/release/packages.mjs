import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pluginPrefix, pluginsDir, registry as defaultRegistry, repoRoot } from './config.mjs'
import { ReleaseError, normalizeRegistry } from './util.mjs'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 递归列出包内文件，跳过 node_modules 与 .git；路径使用 / 分隔。 */
export async function listPackageFiles(dir, base = dir, result = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await listPackageFiles(full, base, result)
    } else if (entry.isFile()) {
      result.push(relative(base, full).split(sep).join('/'))
    }
  }
  return result
}

/** 发现 plugins/* 下符合命名约定的子包。 */
export async function discoverPackages(dir = pluginsDir, baseRoot = repoRoot) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw new ReleaseError(`无法读取插件目录 ${dir}：${error.message}`)
  }

  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packageDir = join(dir, entry.name)
    const manifestPath = join(packageDir, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new ReleaseError(`无法解析 ${manifestPath}：${error.message}`)
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(pluginPrefix)) continue
    packages.push({
      name: manifest.name,
      version: manifest.version,
      dir: packageDir,
      relDir: relative(baseRoot, packageDir),
      manifest,
      manifestPath,
    })
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))
  return packages
}

/** 按 --package 过滤；未知包名直接报错。 */
export function selectPackages(packages, requested = []) {
  if (requested.length === 0) return packages
  const available = new Map(packages.map(pkg => [pkg.name, pkg]))
  const seen = new Set()
  const selected = []
  const unknown = []
  for (const name of requested) {
    if (seen.has(name)) continue
    seen.add(name)
    const pkg = available.get(name)
    if (pkg === undefined) unknown.push(name)
    else selected.push(pkg)
  }
  if (unknown.length > 0) {
    throw new ReleaseError(
      `未知包：${unknown.join('、')}；可用包：${packages.map(pkg => pkg.name).join('、') || '（无）'}`,
    )
  }
  return selected
}

/** 按本地 dependencies / optionalDependencies 做稳定拓扑排序。 */
export function sortByDependencies(packages) {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const dependenciesOf = pkg => {
    const names = new Set()
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        if (byName.has(name)) names.add(name)
      }
    }
    return [...names].sort()
  }

  const remaining = new Set(byName.keys())
  const ordered = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(name => dependenciesOf(byName.get(name)).every(dep => !remaining.has(dep)))
      .sort()
    if (ready.length === 0) {
      throw new ReleaseError(`本地依赖存在环：${[...remaining].sort().join('、')}`)
    }
    for (const name of ready) {
      ordered.push(byName.get(name))
      remaining.delete(name)
    }
  }
  return ordered
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

async function targetExists(pkg, target, packageFiles) {
  const normalized = target.replace(/^\.\//, '')
  if (normalized.includes('*') || normalized.includes('?')) {
    const matcher = globToRegExp(normalized)
    return packageFiles.some(file => matcher.test(file))
  }
  try {
    await stat(join(pkg.dir, normalized))
    return true
  } catch {
    return false
  }
}

/**
 * 校验单个包的发布清单。返回错误字符串数组；空数组表示通过。
 */
export async function validateManifest(pkg, options = {}) {
  const targetRegistry = options.registry ?? defaultRegistry
  const errors = []
  const manifest = pkg.manifest
  const field = (name, message) => errors.push(`[${pkg.name}] ${name}: ${message}`)

  if (typeof manifest.name !== 'string' || !manifest.name.startsWith(pluginPrefix)) {
    field('name', `必须以 ${pluginPrefix} 开头`)
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    field('version', `不是合法 semver：${manifest.version ?? '（缺失）'}`)
  }
  if (manifest.private === true) field('private', '不能发布 private 包')

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    field('files', '必须是非空数组')
  }

  if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
    field('license', '缺少许可证标识')
  }
  try {
    await stat(join(pkg.dir, 'LICENSE'))
  } catch {
    field('LICENSE', '包目录缺少 LICENSE 文件')
  }

  const repositoryUrl = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url
  if (typeof repositoryUrl !== 'string' || repositoryUrl.trim() === '') {
    field('repository', '缺少 repository.url')
  }

  if (manifest.publishConfig?.access !== 'public') {
    field('publishConfig.access', '必须是 public')
  }
  if (normalizeRegistry(manifest.publishConfig?.registry) !== normalizeRegistry(targetRegistry)) {
    field('publishConfig.registry', `必须指向 ${targetRegistry}`)
  }

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.trim() === '') {
    field('dsh.bundle.patch', '缺少 bundle patch 路径')
  } else {
    try {
      await stat(join(pkg.dir, patch))
    } catch {
      field('dsh.bundle.patch', `文件不存在：${patch}`)
    }
  }

  if (!manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) {
    field('exports', '必须是对象')
  } else {
    const packageFiles = await listPackageFiles(pkg.dir)
    for (const target of flattenExportTargets(manifest.exports)) {
      if (!(await targetExists(pkg, target, packageFiles))) {
        field('exports', `目标不存在：${target}`)
      }
    }
  }

  return errors
}

/** 校验全部候选包；有错误时合并抛出。 */
export async function assertManifests(packages, options = {}) {
  const errors = []
  for (const pkg of packages) {
    errors.push(...(await validateManifest(pkg, options)))
  }
  if (errors.length > 0) {
    throw new ReleaseError(`包清单校验失败：\n${errors.map(error => `  - ${error}`).join('\n')}`)
  }
}
