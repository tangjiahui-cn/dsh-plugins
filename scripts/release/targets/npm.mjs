import {
  npmBin as defaultNpmBin,
  npmCacheDir as defaultCacheDir,
  registry as defaultRegistry,
  repoRoot as defaultRepoRoot,
  withdrawWindowHours,
} from '../config.mjs'
import { ReleaseError, formatCommand, runCommand } from '../util.mjs'

const HOUR = 60 * 60 * 1000

function npmArgs(registry, cacheDir, args) {
  return [...args, '--registry', registry, '--cache', cacheDir]
}

function isNotFound(result) {
  const text = `${result.stdout}\n${result.stderr}`
  return /\bE404\b/.test(text) || /\b404\s+Not Found\b/i.test(text)
}

function parseJson(text, fallback) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return fallback
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return fallback
  }
}

export function createNpmTarget(options = {}) {
  const npmBin = options.npmBin ?? defaultNpmBin
  const registry = options.registry ?? defaultRegistry
  const cacheDir = options.cacheDir ?? defaultCacheDir
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const exec = options.exec ?? runCommand
  const now = options.now ?? (() => Date.now())
  const defaultEnv = options.env ?? process.env

  async function run(args, { cwd = repoRoot, env = defaultEnv } = {}) {
    const result = await exec(npmBin, npmArgs(registry, cacheDir, args), { cwd, env })
    if (result.error !== undefined) {
      throw new ReleaseError(`无法执行 npm ${args[0]}：${result.error.message}`)
    }
    return result
  }

  async function checkAuth() {
    const result = await run(['whoami'])
    if (result.code !== 0) {
      throw new ReleaseError(
        `npm 认证失败。先执行 npm login --registry ${registry}，或配置 automation token。\n${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    const user = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
    return { user: user ?? '' }
  }

  async function inspectVersion({ name, version }) {
    const result = await run(['view', `${name}@${version}`, 'version', 'gitHead', '--json'])
    if (result.code !== 0) {
      if (isNotFound(result)) return { state: 'absent' }
      throw new ReleaseError(
        `查询 ${name}@${version} 失败：${result.stderr.trim() || result.stdout.trim()}`,
      )
    }

    let gitHead = null
    try {
      const parsed = JSON.parse(result.stdout)
      if (typeof parsed === 'string') {
        // 部分 npm 版本只输出 version。
        gitHead = null
      } else if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.gitHead === 'string' && parsed.gitHead.trim() !== '') {
          gitHead = parsed.gitHead.trim()
        }
      }
    } catch {
      gitHead = null
    }

    let publishedAt = null
    const timeResult = await run(['view', name, 'time', '--json'])
    if (timeResult.code === 0) {
      const times = parseJson(timeResult.stdout, null)
      if (times && typeof times[version] === 'string') publishedAt = times[version]
    }
    return { state: 'published', publishedAt, gitHead }
  }

  async function publish({ name, version, dir, otp }) {
    const args = ['publish', '--access', 'public', '--tag', 'latest', '--json']
    if (otp !== undefined) args.push('--otp', otp)
    const result = await run(args, { cwd: dir })
    if (result.code !== 0) {
      throw new ReleaseError(
        `发布 ${name}@${version} 失败：${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    const parsed = parseJson(result.stdout, null)
    const json = Array.isArray(parsed) ? parsed[0] : parsed
    return {
      integrity: typeof json?.integrity === 'string' ? json.integrity : null,
      url: `https://www.npmjs.com/package/${name}/v/${version}`,
    }
  }

  function unpublishCommand(name, version) {
    return formatCommand('npm', [
      'unpublish',
      `${name}@${version}`,
      '--force',
      '--registry',
      registry,
      '--cache',
      cacheDir,
    ])
  }

  function deprecateCommand(name, version) {
    return formatCommand('npm', [
      'deprecate',
      `${name}@${version}`,
      `withdrawn: ${version} 已撤回`,
      '--registry',
      registry,
      '--cache',
      cacheDir,
    ])
  }

  async function withdrawPlan({ name, version }) {
    const state = await inspectVersion({ name, version })
    if (state.state === 'absent') {
      return { executable: false, commands: [], note: '版本不存在，无需撤回' }
    }
    const publishedAt = state.publishedAt
    const publishedMs = publishedAt === null ? Number.NaN : Date.parse(publishedAt)
    if (!Number.isFinite(publishedMs)) {
      return {
        executable: false,
        commands: [deprecateCommand(name, version)],
        note: '无法读取发布时间，改用 npm deprecate',
      }
    }
    const age = now() - publishedMs
    if (age > withdrawWindowHours * HOUR) {
      return {
        executable: false,
        commands: [deprecateCommand(name, version)],
        note: `发布时间超过 ${withdrawWindowHours} 小时，npm 不再允许 unpublish`,
      }
    }
    return {
      executable: true,
      commands: [unpublishCommand(name, version)],
      note: `发布时间在 ${withdrawWindowHours} 小时内，可执行 npm unpublish`,
    }
  }

  async function withdraw({ name, version, otp }) {
    const plan = await withdrawPlan({ name, version })
    if (!plan.executable) throw new ReleaseError(plan.note)
    const args = ['unpublish', `${name}@${version}`, '--force']
    if (otp !== undefined) args.push('--otp', otp)
    const result = await run(args)
    if (result.code !== 0) {
      throw new ReleaseError(
        `撤回 ${name}@${version} 失败：${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return { command: plan.commands[0] }
  }

  async function distTags(name) {
    const result = await run(['view', name, 'dist-tags', '--json'])
    if (result.code !== 0) return {}
    return parseJson(result.stdout, {})
  }

  return {
    id: 'npm',
    registry,
    checkAuth,
    inspectVersion,
    publish,
    withdrawPlan,
    withdraw,
    distTags,
  }
}

/** 默认 npm 目标单例。 */
export const npmTarget = createNpmTarget()
