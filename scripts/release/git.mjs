import { posix } from 'node:path'
import { repoRoot as defaultRepoRoot, gitBin as defaultGitBin } from './config.mjs'
import { ReleaseError, runCommand } from './util.mjs'

async function git(args, options) {
  const result = await runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot,
    env: options.env,
  })
  if (result.error !== undefined) {
    throw new ReleaseError(`无法执行 git：${result.error.message}`)
  }
  if (result.code !== 0) {
    throw new ReleaseError(`git ${args.join(' ')} 退出码 ${result.code}：${result.stderr.trim()}`)
  }
  return result.stdout
}

/** 返回工作区状态行；空数组表示干净。 */
export async function workingTreeStatus(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const output = await git(['status', '--porcelain=v1', '--untracked-files=all'], { ...options, repoRoot })
  return output.split('\n').filter(Boolean)
}

/** 返回仓库中所有被 git 跟踪的文件（相对仓库根，/ 分隔）。 */
export async function trackedFiles(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const output = await git(['ls-files', '-z'], { ...options, repoRoot })
  return new Set(output.split('\0').filter(Boolean))
}

/** 断言工作区干净，且给定包目录下的 tarball 文件都被 git 跟踪。 */
export async function assertCommitted(options) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const status = await workingTreeStatus({ ...options, repoRoot })
  if (status.length > 0) {
    throw new ReleaseError(
      `工作区有未提交改动，先提交再发布：\n${status.map(line => `  ${line}`).join('\n')}`,
    )
  }

  const tracked = await trackedFiles({ ...options, repoRoot })
  const missing = []
  for (const { pkg, files } of options.tarballs) {
    for (const file of files) {
      const repoPath = posix.normalize(posix.join(pkg.relDir ?? '', file))
      if (!tracked.has(repoPath)) missing.push(repoPath)
    }
  }
  if (missing.length > 0) {
    throw new ReleaseError(
      `以下文件会进入 tarball，但未被 git 跟踪：\n${missing.map(path => `  ${path}`).join('\n')}`,
    )
  }
}

/** 断言指定路径都被 git 跟踪；供单测直接使用。 */
export async function assertTracked(paths, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const tracked = await trackedFiles({ ...options, repoRoot })
  const missing = paths.filter(path => !tracked.has(path))
  if (missing.length > 0) {
    throw new ReleaseError(`以下文件未被 git 跟踪：\n${missing.map(path => `  ${path}`).join('\n')}`)
  }
}
