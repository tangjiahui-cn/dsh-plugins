import {
  gitBin as defaultGitBin,
  repoRoot as defaultRepoRoot,
} from './config.mjs'
import { ReleaseError, formatCommand, runCommand, sleep } from './util.mjs'

export function tagName(pkg) {
  return `${pkg.name}@${pkg.version}`
}

async function git(args, options = {}) {
  const result = await runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot ?? defaultRepoRoot,
    env: options.env,
  })
  if (result.error !== undefined) {
    throw new ReleaseError(`无法执行 git ${args.join(' ')}：${result.error.message}`)
  }
  if (result.code !== 0) {
    throw new ReleaseError(
      `git ${args.join(' ')} 失败：${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout
}

function gitOptional(args, options = {}) {
  return runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot ?? defaultRepoRoot,
    env: options.env,
  })
}

export async function headCommit(options = {}) {
  return (await git(['rev-parse', 'HEAD'], options)).trim()
}

export async function commitExists(commit, options = {}) {
  const result = await gitOptional(['cat-file', '-e', `${commit}^{commit}`], options)
  return result.code === 0
}

export async function localTagCommit(tag, options = {}) {
  const result = await gitOptional(
    ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{}`],
    options,
  )
  return result.code === 0 ? result.stdout.trim() : null
}

export async function remoteTagCommit(tag, options = {}) {
  const output = await git(['ls-remote', '--tags', options.remote ?? 'origin'], options)
  let object = null
  let peeled = null
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const [sha, ref] = line.split('\t')
    if (ref === `refs/tags/${tag}`) object = sha
    if (ref === `refs/tags/${tag}^{}`) peeled = sha
  }
  return peeled ?? object
}

export async function assertOrigin(options = {}) {
  await git(['remote', 'get-url', options.remote ?? 'origin'], options)
}

export async function assertTagAbsent(pkg, options = {}) {
  const tag = tagName(pkg)
  await assertOrigin(options)
  const local = await localTagCommit(tag, options)
  if (local !== null) throw new ReleaseError(`本地 tag 已存在：${tag}（${local}）`)
  const remote = await remoteTagCommit(tag, options)
  if (remote !== null) throw new ReleaseError(`远程 tag 已存在：${tag}（${remote}）`)
}

export async function createAnnotatedTag({ tag, commit, repoRoot, gitBin, env }) {
  await git(['tag', '-a', tag, commit, '-m', tag], { repoRoot, gitBin, env })
}

export async function pushTag({ tag, remote = 'origin', retries = 2, repoRoot, gitBin, env, sleepFn = sleep }) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await gitOptional(['push', remote, tag], { repoRoot, gitBin, env })
    if (result.code === 0) return
    lastError = result.stderr.trim() || result.stdout.trim()
    if (attempt < retries) await sleepFn(1000)
  }
  throw new ReleaseError(`tag push 失败：${tag}\n${lastError}`)
}

export async function deleteLocalTag(tag, options = {}) {
  const current = await localTagCommit(tag, options)
  if (current === null) return false
  await git(['tag', '-d', tag], options)
  return true
}

export async function deleteRemoteTag(tag, options = {}) {
  const current = await remoteTagCommit(tag, options)
  if (current === null) return false
  await git(['push', options.remote ?? 'origin', `:refs/tags/${tag}`], options)
  return true
}

async function packageVersionAt(commit, pkg, options = {}) {
  const output = await git(['show', `${commit}:${pkg.relDir}/package.json`], options)
  return JSON.parse(output)
}

/** 解析补 tag 的目标 commit；不默认使用 HEAD。 */
export async function resolveTagCommit({ pkg, session, gitHead, at, ...options }) {
  const candidates = [session?.releaseCommit, gitHead, at].filter(
    value => typeof value === 'string' && value.trim() !== '',
  )
  if (candidates.length === 0) {
    throw new ReleaseError(
      `无法确定 ${tagName(pkg)} 的发布 commit：session、npm gitHead 与 --at 都没有可用值。请用 --at <commit> 指定。`,
    )
  }

  const rejected = []
  for (const candidate of candidates) {
    const commit = candidate.trim()
    if (!(await commitExists(commit, options))) {
      rejected.push(`${commit}：本地不存在`)
      continue
    }
    const manifest = await packageVersionAt(commit, pkg, options)
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      rejected.push(`${commit}：${manifest.name ?? '（无名）'}@${manifest.version ?? '（缺失）'}，期望 ${pkg.name}@${pkg.version}`)
      continue
    }
    return commit
  }
  throw new ReleaseError(
    `无法确定 ${tagName(pkg)} 的发布 commit；候选均不可用：${rejected.join('；')}`,
  )
}

export async function changelogMissingAtCommit({ pkg, commit, ...options }) {
  const fileCheck = await gitOptional(
    ['cat-file', '-e', `${commit}:${pkg.relDir}/CHANGELOG.md`],
    options,
  )
  if (fileCheck.code !== 0) return true
  const manifest = await packageVersionAt(commit, pkg, options)
  return !Array.isArray(manifest.files)
    || !manifest.files.some(entry => String(entry).includes('CHANGELOG'))
}

export async function inspectTagState(pkg, options = {}) {
  const tag = tagName(pkg)
  return {
    tag,
    local: await localTagCommit(tag, options),
    remote: await remoteTagCommit(tag, options),
  }
}

/** 按本地/远程状态修复 tag；不移动已有 tag。 */
export async function repairTag({ pkg, targetCommit, ...options }) {
  const tag = tagName(pkg)
  const local = await localTagCommit(tag, options)
  const remote = await remoteTagCommit(tag, options)

  if (local !== null && remote !== null) {
    if (local !== targetCommit || remote !== targetCommit) {
      throw new ReleaseError(
        `tag 冲突：${tag}；本地 ${local}，远程 ${remote}，期望 ${targetCommit}`,
      )
    }
    return { tag, commit: targetCommit, state: 'verified' }
  }

  if (local !== null) {
    if (local !== targetCommit) {
      throw new ReleaseError(`本地 tag 冲突：${tag} 指向 ${local}，期望 ${targetCommit}`)
    }
    await pushTag({ tag, ...options })
    return { tag, commit: targetCommit, state: 'pushed-local' }
  }

  if (remote !== null) {
    if (remote !== targetCommit) {
      throw new ReleaseError(`远程 tag 冲突：${tag} 指向 ${remote}，期望 ${targetCommit}`)
    }
    await git(['fetch', options.remote ?? 'origin', 'tag', tag], options)
    const fetched = await localTagCommit(tag, options)
    if (fetched !== targetCommit) {
      throw new ReleaseError(`fetch 后本地 tag 不匹配：${tag} 指向 ${fetched}`)
    }
    return { tag, commit: targetCommit, state: 'fetched-remote' }
  }

  await createAnnotatedTag({ tag, commit: targetCommit, ...options })
  await pushTag({ tag, ...options })
  return { tag, commit: targetCommit, state: 'created' }
}

export function tagDeleteCommands(tag, { local = true, pushed = false } = {}) {
  const commands = []
  if (local) commands.push(formatCommand('git', ['tag', '-d', tag]))
  if (pushed) commands.push(formatCommand('git', ['push', 'origin', `:refs/tags/${tag}`]))
  return commands
}
