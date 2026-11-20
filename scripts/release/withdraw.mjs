import { join } from 'node:path'
import { gitBin as defaultGitBin, repoRoot as defaultRepoRoot, withdrawWindowHours } from './config.mjs'
import { discoverPackages } from './packages.mjs'
import { deleteLocalTag, deleteRemoteTag } from './tags.mjs'
import { getTarget } from './targets/index.mjs'
import { ReleaseError, parsePackageSpec, sleep } from './util.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
  isTTY: false,
  ask: async () => '',
}

/** 解析 <name>@<version>，支持 scoped 包名。 */
export function parseSpec(spec) {
  return parsePackageSpec(spec)
}

function printImpact(io, { name, version, state, plan, tags }) {
  io.log(`撤回目标：${name}@${version}`)
  io.log(`发布时间：${state.publishedAt ?? '未知'}`)
  const matchingTags = Object.entries(tags).filter(([, tagged]) => tagged === version)
  if (matchingTags.length > 0) {
    io.log(`dist-tags：${matchingTags.map(([tag]) => tag).join('、')} 指向该版本`)
  }
  io.log('影响：lockfile 中引用该版本的安装会失败；依赖者数量不做估算。')
  io.log(`窗口：npm unpublish 仅在发布后 ${withdrawWindowHours} 小时内可用。`)
  for (const command of plan.commands) io.log(`命令：${command}`)
}

export async function runWithdraw(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const target = options.targetAdapter ?? getTarget(options.targetId)
  const wait = options.sleepFn ?? sleep
  const { name, version } = parseSpec(options.spec)

  const packages = await discoverPackages(join(repoRoot, 'plugins'), repoRoot)
  if (!packages.some(pkg => pkg.name === name)) {
    throw new ReleaseError(
      `目标不属于当前仓库：${name}；可撤回的包：${packages.map(pkg => pkg.name).join('、') || '（无）'}`,
    )
  }

  const state = await target.inspectVersion({ name, version })
  if (state.state !== 'published') {
    throw new ReleaseError(`${name}@${version} 未发布，无需撤回`)
  }

  const plan = await target.withdrawPlan({ name, version })
  const tags = typeof target.distTags === 'function' ? await target.distTags(name) : {}
  printImpact(io, { name, version, state, plan, tags })

  if (!plan.executable) {
    io.error(`拒绝撤回：${plan.note}`)
    return 1
  }

  if (options.yes !== true) {
    if (io.isTTY !== true) throw new ReleaseError('非交互环境需要 --yes 才能撤回')
    const answer = await io.ask(`输入 ${name}@${version} 确认撤回：`)
    if (answer.trim() !== `${name}@${version}`) throw new ReleaseError('已取消撤回')
  }

  await target.withdraw({ name, version, otp: options.otp })
  io.log(`已提交撤回：${name}@${version}`)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await target.inspectVersion({ name, version })
    if (current.state === 'absent') {
      io.log(`已确认 ${name}@${version} 不再可查询。`)
      const tag = `${name}@${version}`
      const tagOps = options.tagOps ?? {
        deleteLocal: deleteLocalTag,
        deleteRemote: deleteRemoteTag,
      }
      try {
        const local = await tagOps.deleteLocal(tag, {
          repoRoot,
          gitBin: options.gitBin ?? defaultGitBin,
          remote: options.remote ?? 'origin',
        })
        const remote = await tagOps.deleteRemote(tag, {
          repoRoot,
          gitBin: options.gitBin ?? defaultGitBin,
          remote: options.remote ?? 'origin',
        })
        io.log(`tag ${tag}：本地${local ? '已删除' : '不存在'}，远程${remote ? '已删除' : '不存在'}。`)
      } catch (error) {
        throw new ReleaseError(`版本已撤回，但 tag 删除失败：${error.message}`)
      }
      return 0
    }
    if (attempt < 2) await wait(2000)
  }

  throw new ReleaseError(`${name}@${version} 撤回后仍可查询，registry 可能尚未反映`)
}
