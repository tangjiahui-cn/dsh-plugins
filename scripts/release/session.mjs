import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  gitBin as defaultGitBin,
  repoRoot as defaultRepoRoot,
} from './config.mjs'
import { workingTreeStatus } from './git.mjs'
import { headCommit } from './tags.mjs'
import { ReleaseError, runCommand } from './util.mjs'

export const stateFiles = {
  lock: '.tmp/release/lock',
  session: '.tmp/release/session.json',
  sessionDir: '.tmp/release/session',
}

function paths(repoRoot) {
  return {
    root: join(repoRoot, '.tmp/release'),
    lock: join(repoRoot, stateFiles.lock),
    session: join(repoRoot, stateFiles.session),
    sessionDir: join(repoRoot, stateFiles.sessionDir),
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export async function readLock(repoRoot = defaultRepoRoot) {
  try {
    return JSON.parse(await readFile(paths(repoRoot).lock, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new ReleaseError(`无法读取发布锁：${error.message}`)
  }
}

/** 获取发布锁；release 可清理陈旧锁，其他命令要求先 release:clean。 */
export async function acquireLock({ repoRoot = defaultRepoRoot, command, clearStale = false } = {}) {
  const target = paths(repoRoot).lock
  await mkdir(paths(repoRoot).root, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readLock(repoRoot)
    if (current !== null) {
      if (isProcessAlive(current.pid)) {
        throw new ReleaseError(
          `已有一个发布命令在运行：pid ${current.pid}，命令 ${current.command ?? 'unknown'}`,
        )
      }
      if (!clearStale) {
        throw new ReleaseError(
          `存在陈旧发布锁（pid ${current.pid}）；先执行 pnpm release:clean`,
        )
      }
      await rm(target, { force: true })
    }
    const lock = {
      pid: process.pid,
      command,
      startedAt: new Date().toISOString(),
    }
    try {
      await writeFile(target, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' })
      return lock
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new ReleaseError('无法获取发布锁')
}

export async function releaseLock(repoRoot = defaultRepoRoot) {
  const current = await readLock(repoRoot).catch(() => null)
  if (current !== null && current.pid === process.pid) {
    await rm(paths(repoRoot).lock, { force: true })
  }
}

export async function readSession(repoRoot = defaultRepoRoot) {
  try {
    return JSON.parse(await readFile(paths(repoRoot).session, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new ReleaseError(`无法读取发布 session：${error.message}`)
  }
}

export async function writeSession(session, repoRoot = defaultRepoRoot) {
  const target = paths(repoRoot)
  await mkdir(target.root, { recursive: true })
  await writeFile(target.session, `${JSON.stringify(session, null, 2)}\n`)
}

export async function clearSession(repoRoot = defaultRepoRoot) {
  const target = paths(repoRoot)
  await rm(target.session, { force: true })
  await rm(target.sessionDir, { recursive: true, force: true })
}

async function removeStaleLock(repoRoot) {
  const current = await readLock(repoRoot)
  if (current === null) return { removed: false, live: false }
  if (isProcessAlive(current.pid)) return { removed: false, live: true }
  await rm(paths(repoRoot).lock, { force: true })
  return { removed: true, live: false }
}

/** 删除 session、临时目录与陈旧锁；不碰历史报告、npm 缓存或工作区。 */
export async function cleanState(repoRoot = defaultRepoRoot) {
  const removed = []
  const target = paths(repoRoot)
  for (const path of [target.session, target.sessionDir]) {
    try {
      await stat(path)
      await rm(path, { recursive: true, force: true })
      removed.push(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const lock = await removeStaleLock(repoRoot)
  if (lock.removed) removed.push(target.lock)
  return { removed, liveLock: lock.live }
}

export async function hashFiles(repoRoot, files) {
  const result = []
  for (const path of files) {
    const content = await readFile(join(repoRoot, path))
    result.push({
      path,
      hash: createHash('sha256').update(content).digest('hex'),
    })
  }
  return result
}

/** 提交前中断时，只有在 HEAD 未变且文件 hash 匹配时才恢复。 */
export async function restoreGeneratedFiles({ repoRoot = defaultRepoRoot, session, gitBin = defaultGitBin } = {}) {
  if (session === null || session === undefined) return { restored: false }
  const status = await workingTreeStatus({ repoRoot, gitBin })
  if (status.length === 0) return { restored: false }

  const head = await headCommit({ repoRoot, gitBin })
  if (session.baseHead !== undefined && head !== session.baseHead) {
    throw new ReleaseError(
      `工作区在中断后已变化（HEAD ${head}，session 基线 ${session.baseHead}）；不自动恢复，请人工处理`,
    )
  }

  const files = Array.isArray(session.files) ? session.files : []
  if (files.length === 0) {
    throw new ReleaseError(`工作区有未提交改动，但 session 没有可恢复文件：\n${status.join('\n')}`)
  }

  for (const file of files) {
    let content
    try {
      content = await readFile(join(repoRoot, file.path))
    } catch {
      throw new ReleaseError(`session 记录的文件已不存在或不可读：${file.path}`)
    }
    const hash = createHash('sha256').update(content).digest('hex')
    if (hash !== file.hash) {
      throw new ReleaseError(`文件在中断后被修改，不自动恢复：${file.path}`)
    }
  }

  const result = await runCommand(gitBin, ['checkout', '--', ...files.map(file => file.path)], {
    cwd: repoRoot,
  })
  if (result.code !== 0) {
    throw new ReleaseError(`恢复提交前文件失败：${result.stderr.trim()}`)
  }
  return { restored: true, files: files.map(file => file.path) }
}

/** 供测试与诊断：列出状态目录内容。 */
export async function listState(repoRoot = defaultRepoRoot) {
  try {
    return await readdir(paths(repoRoot).sessionDir)
  } catch {
    return []
  }
}
