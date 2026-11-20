import { readFile } from 'node:fs/promises'
import {
  lockfilePath as defaultLockfilePath,
  npmBin as defaultNpmBin,
  npmrcPath as defaultNpmrcPath,
  pnpmBin as defaultPnpmBin,
  registry as defaultRegistry,
  repoRoot as defaultRepoRoot,
} from './config.mjs'
import { ReleaseError, isOfficialRegistry, normalizeRegistry, runCommand } from './util.mjs'

/** 解析 .npmrc 的 key=value；忽略注释与空行。 */
export function parseNpmrc(text) {
  const values = new Map()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key !== '') values.set(key, value)
  }
  return values
}

function credentialKey(key) {
  return key.includes('_authToken') || key.endsWith(':_auth') || key.endsWith(':_password') || key === 'username'
}

async function commandRegistry(command, args, options) {
  const result = await runCommand(command, args, { cwd: options.repoRoot, env: options.env, timeoutMs: 30000 })
  if (result.error !== undefined) {
    throw new ReleaseError(`无法执行 ${command} ${args.join(' ')}：${result.error.message}`)
  }
  if (result.code !== 0) {
    throw new ReleaseError(`${command} ${args.join(' ')} 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}

/** 校验根 .npmrc、生效 registry 与锁文件 tarball 地址都只指向官方源。 */
export async function assertOfficialSource(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const registry = options.registry ?? defaultRegistry
  const npmrcPath = options.npmrcPath ?? defaultNpmrcPath
  const lockfilePath = options.lockfilePath ?? defaultLockfilePath

  let npmrc
  try {
    npmrc = parseNpmrc(await readFile(npmrcPath, 'utf8'))
  } catch (error) {
    throw new ReleaseError(`无法读取 ${npmrcPath}：${error.message}`)
  }

  const configured = npmrc.get('registry')
  if (normalizeRegistry(configured) !== normalizeRegistry(registry)) {
    throw new ReleaseError(`.npmrc 的 registry 必须是 ${registry}，实际：${configured ?? '（缺失）'}`)
  }
  const scoped = npmrc.get('@tjh:registry')
  if (normalizeRegistry(scoped) !== normalizeRegistry(registry)) {
    throw new ReleaseError(`.npmrc 的 @tjh:registry 必须是 ${registry}，实际：${scoped ?? '（缺失）'}`)
  }
  const credential = [...npmrc.keys()].find(credentialKey)
  if (credential !== undefined) {
    throw new ReleaseError(`.npmrc 不能包含认证凭据：${credential}`)
  }

  const npmRegistry = await commandRegistry(
    options.npmBin ?? defaultNpmBin,
    ['config', 'get', 'registry'],
    { repoRoot, env: options.env },
  )
  if (normalizeRegistry(npmRegistry) !== normalizeRegistry(registry)) {
    throw new ReleaseError(`npm 生效 registry 不是官方源：${npmRegistry}`)
  }

  const pnpmRegistry = await commandRegistry(
    options.pnpmBin ?? defaultPnpmBin,
    ['config', 'get', 'registry'],
    { repoRoot, env: options.env },
  )
  if (normalizeRegistry(pnpmRegistry) !== normalizeRegistry(registry)) {
    throw new ReleaseError(`pnpm 生效 registry 不是官方源：${pnpmRegistry}`)
  }

  let lockfile
  try {
    lockfile = await readFile(lockfilePath, 'utf8')
  } catch (error) {
    throw new ReleaseError(`无法读取 ${lockfilePath}：${error.message}`)
  }
  for (const match of lockfile.matchAll(/\btarball:\s*([^\s,}]+)/g)) {
    const url = match[1].replace(/^['"]|['"]$/g, '')
    if (!isOfficialRegistry(url)) {
      throw new ReleaseError(`${lockfilePath} 含非官方 tarball 地址：${url}`)
    }
  }
}
