import { gitBin as defaultGitBin, repoRoot as defaultRepoRoot } from './config.mjs'
import {
  cleanState,
  isProcessAlive,
  readLock,
  readSession,
  restoreGeneratedFiles,
} from './session.mjs'
import { headCommit, localTagCommit, remoteTagCommit } from './tags.mjs'
import { getTarget } from './targets/index.mjs'
import { ReleaseError, runCommand } from './util.mjs'
import { workingTreeStatus } from './git.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
}

function changedPath(line) {
  return line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')
}

export async function runClean(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const gitBin = options.gitBin ?? defaultGitBin
  const remote = options.remote ?? 'origin'

  const liveLock = await readLock(repoRoot)
  if (liveLock !== null && isProcessAlive(liveLock.pid)) {
    io.error(`发布锁仍被 pid ${liveLock.pid} 持有，未执行清理。`)
    return 1
  }

  const session = await readSession(repoRoot)
  if (session === null) {
    const result = await cleanState(repoRoot)
    for (const path of result.removed) io.log(`已删除：${path}`)
    if (result.removed.length === 0) io.log('没有需要清理的 session 或临时目录。')
    return 0
  }

  const target = options.targetAdapter ?? getTarget(options.targetId)
  for (const pkg of session.packages ?? []) {
    const state = await target.inspectVersion({ name: pkg.name, version: pkg.version })
    if (state.state === 'published') {
      throw new ReleaseError(
        `${pkg.name}@${pkg.version} 已发布，不能恢复到发布前快照；先执行 pnpm release:withdraw -- ${pkg.name}@${pkg.version}`,
      )
    }
    const tag = `${pkg.name}@${pkg.version}`
    const local = await localTagCommit(tag, { repoRoot, gitBin })
    const remoteTag = await remoteTagCommit(tag, { repoRoot, gitBin, remote })
    if (local !== null || remoteTag !== null) {
      throw new ReleaseError(
        `tag ${tag} 已存在，不能恢复到发布前快照；先确认并删除 tag 或执行 release:withdraw`,
      )
    }
  }

  const allowed = new Set((session.files ?? []).map(file => file.path))
  const dirty = (await workingTreeStatus({ repoRoot, gitBin })).map(changedPath)
  const extra = dirty.filter(path => !allowed.has(path))
  if (extra.length > 0) {
    throw new ReleaseError(
      `工作区存在本次 release 之外的改动，拒绝恢复到发布前快照：\n${extra.join('\n')}`,
    )
  }

  const head = await headCommit({ repoRoot, gitBin })
  if (session.releaseCommit !== undefined && session.releaseCommit !== null && head === session.releaseCommit) {
    const result = await runCommand(gitBin, ['reset', '--hard', session.baseHead], { cwd: repoRoot })
    if (result.code !== 0) {
      throw new ReleaseError(`恢复 ${session.baseHead} 失败：${result.stderr.trim()}`)
    }
    io.log(`已恢复分支到发布前提交：${session.baseHead}`)
  } else if (head === session.baseHead) {
    await restoreGeneratedFiles({ repoRoot, session, gitBin })
    io.log('已恢复发布前的生成文件。')
  } else {
    throw new ReleaseError(
      `当前 HEAD ${head} 既不是发布前提交 ${session.baseHead}，也不是发布提交 ${session.releaseCommit ?? '（无）'}；拒绝修改 git 历史`,
    )
  }

  const result = await cleanState(repoRoot)
  for (const path of result.removed) io.log(`已删除：${path}`)
  return 0
}
