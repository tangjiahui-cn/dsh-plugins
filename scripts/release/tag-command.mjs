import { join } from 'node:path'
import { gitBin as defaultGitBin, repoRoot as defaultRepoRoot } from './config.mjs'
import { discoverPackages } from './packages.mjs'
import { readSession } from './session.mjs'
import {
  changelogMissingAtCommit,
  repairTag,
  resolveTagCommit,
} from './tags.mjs'
import { getTarget } from './targets/index.mjs'
import { ReleaseError, parsePackageSpec } from './util.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
}

export async function runTag(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const gitBin = options.gitBin ?? defaultGitBin
  const remote = options.remote ?? 'origin'
  const target = options.targetAdapter ?? getTarget(options.targetId)
  const { name, version } = parsePackageSpec(options.spec)

  const packages = await discoverPackages(join(repoRoot, 'plugins'), repoRoot)
  const found = packages.find(item => item.name === name)
  const pkg = found === undefined ? undefined : { ...found, version }
  if (pkg === undefined) {
    throw new ReleaseError(
      `目标不属于当前仓库：${name}；可修复的包：${packages.map(item => item.name).join('、') || '（无）'}`,
    )
  }

  const state = await target.inspectVersion({ name, version })
  if (state.state !== 'published') {
    throw new ReleaseError(`${name}@${version} 未发布，不能补 tag`)
  }

  const session = options.session ?? await readSession(repoRoot)
  const targetCommit = await resolveTagCommit({
    pkg,
    session,
    gitHead: state.gitHead,
    at: options.at,
    repoRoot,
    gitBin,
    remote,
  })
  const changelogMissing = await changelogMissingAtCommit({
    pkg,
    commit: targetCommit,
    repoRoot,
    gitBin,
  })
  const result = await repairTag({
    pkg,
    targetCommit,
    repoRoot,
    gitBin,
    remote,
  })

  io.log(`tag ${result.tag}：${result.state}，指向 ${result.commit}`)
  if (changelogMissing) {
    io.error(
      `警告：${name}@${version} 的发布 commit 缺少 CHANGELOG.md；tag 已修复，但已发布 tarball 无法补 changelog。`,
    )
  }
  return { ...result, changelogMissing }
}
