import { join, resolve } from 'node:path'
import {
  gitBin as defaultGitBin,
  npmBin as defaultNpmBin,
  npmCacheDir as defaultCacheDir,
  pnpmBin as defaultPnpmBin,
  repoRoot as defaultRepoRoot,
} from './config.mjs'
import { runPackageChecks } from './checks.mjs'
import { checkChangelog } from './changelog.mjs'
import { assertCommitted } from './git.mjs'
import { assertPackContents, packDryRun } from './pack.mjs'
import {
  assertManifests,
  discoverPackages,
  selectPackages,
  sortByDependencies,
} from './packages.mjs'
import { createReportDirectory, writeReport } from './report.mjs'
import { assertOfficialSource } from './source.mjs'
import { assertTagAbsent, createAnnotatedTag, headCommit, localTagCommit, pushTag, tagDeleteCommands, tagName } from './tags.mjs'
import { getTarget } from './targets/index.mjs'
import { ReleaseError } from './util.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
  isTTY: false,
  ask: async () => '',
}

export function formatPlan(plan, target) {
  return [
    `发布计划（target: ${target.id}, registry: ${target.registry}）`,
    ...plan.map((item, index) => (
      `  ${index + 1}. ${item.pkg.name}@${item.pkg.version}  ${item.pkg.relDir}  tarball ${item.files.length} 个文件  changelog: ${item.changelog ?? '?'}  tag: ${item.tag ?? '?'}`
    )),
  ]
}

export async function confirmPublish(io, yes) {
  if (yes === true) return
  if (io.isTTY !== true) {
    throw new ReleaseError('非交互环境需要 --yes 才能发布')
  }
  const answer = await io.ask('确认发布以上包？输入 y 继续：')
  if (answer.trim().toLowerCase() !== 'y' && answer.trim().toLowerCase() !== 'yes') {
    throw new ReleaseError('已取消发布')
  }
}

export async function publishAll({
  plan,
  target,
  otp,
  io,
  releaseCommit,
  repoRoot,
  gitBin,
  remote = 'origin',
  tagRetries = 2,
  tagging = true,
}) {
  const results = plan.map(item => ({
    name: item.pkg.name,
    version: item.pkg.version,
    status: 'pending',
    releaseCommit,
  }))

  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index]
    const { name, version } = item.pkg
    io.log(`发布 ${index + 1}/${plan.length}：${name}@${version}`)
    try {
      const output = await target.publish({ name, version, dir: item.pkg.dir, otp })
      const tag = tagName(item.pkg)
      results[index] = {
        name,
        version,
        status: 'published',
        integrity: output.integrity,
        url: output.url,
        publishedAt: new Date().toISOString(),
        releaseCommit,
        tag,
        tagCreated: false,
        tagPushed: false,
      }

      if (tagging) {
        try {
          await createAnnotatedTag({ tag, commit: releaseCommit, repoRoot, gitBin })
          results[index].tagCreated = true
          await pushTag({ tag, remote, retries: tagRetries, repoRoot, gitBin })
          results[index].tagPushed = true
        } catch (tagError) {
          results[index].tagError = tagError.message
          for (let rest = index + 1; rest < plan.length; rest += 1) {
            results[rest] = {
              name: plan[rest].pkg.name,
              version: plan[rest].pkg.version,
              status: 'not-attempted',
              releaseCommit,
            }
          }
          break
        }
      }
    } catch (error) {
      let status = 'failed'
      let detail = error.message
      try {
        const state = await target.inspectVersion({ name, version, withTime: false })
        if (state.state === 'published') {
          status = 'published-uncertain'
          detail = `${error.message}（查询显示该版本已存在）`
        }
      } catch (reconcileError) {
        status = 'unknown'
        detail = `${error.message}（对账失败：${reconcileError.message}）`
      }
      results[index] = { name, version, status, error: detail, releaseCommit }
      for (let rest = index + 1; rest < plan.length; rest += 1) {
        results[rest] = {
          name: plan[rest].pkg.name,
          version: plan[rest].pkg.version,
          status: 'not-attempted',
          releaseCommit,
        }
      }
      break
    }
  }
  return results
}

export async function collectRollback(target, results) {
  const commands = []
  const notes = []
  for (const result of results) {
    if (result.status !== 'published' && result.status !== 'published-uncertain') continue
    try {
      const plan = await target.withdrawPlan({ name: result.name, version: result.version })
      commands.push(...plan.commands)
      if (!plan.executable) notes.push(`${result.name}@${result.version}：${plan.note}`)
    } catch (error) {
      notes.push(`${result.name}@${result.version}：${error.message}`)
    }
    if (result.tag !== undefined) {
      commands.push(...tagDeleteCommands(result.tag, {
        local: result.tagCreated === true,
        pushed: result.tagPushed === true,
      }))
    }
  }
  return {
    commands: [...new Set(commands)],
    note: notes.length === 0
      ? '命令未执行；超过 72 小时或存在依赖者时改用 npm deprecate'
      : notes.join('；'),
  }
}

function planForReport(plan) {
  return plan.map((item, index) => ({
    name: item.pkg.name,
    version: item.pkg.version,
    relDir: item.pkg.relDir,
    order: index + 1,
  }))
}

export async function runPublish(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const npmBin = options.npmBin ?? defaultNpmBin
  const pnpmBin = options.pnpmBin ?? defaultPnpmBin
  const gitBin = options.gitBin ?? defaultGitBin
  const cacheDir = options.cacheDir ?? defaultCacheDir
  const target = options.targetAdapter ?? getTarget(options.targetId)
  const dryRun = options.dryRun === true
  const startedAt = new Date().toISOString()

  const packages = await discoverPackages(join(repoRoot, 'plugins'), repoRoot)
  const selected = selectPackages(packages, options.packages ?? [])
  if (selected.length === 0) throw new ReleaseError('没有可发布的子包')
  const ordered = sortByDependencies(selected)

  await assertOfficialSource({
    repoRoot,
    npmrcPath: join(repoRoot, '.npmrc'),
    lockfilePath: join(repoRoot, 'pnpm-lock.yaml'),
    npmBin,
    pnpmBin,
    registry: target.registry,
    env: options.env,
  })
  await assertManifests(ordered, { registry: target.registry })

  const plan = []
  for (const pkg of ordered) {
    if (typeof target.prepare === 'function') await target.prepare(pkg)
    const files = await packDryRun(pkg, { npmBin, cacheDir })
    await assertPackContents(pkg, files)
    if (!files.includes('CHANGELOG.md')) {
      throw new ReleaseError(`${pkg.name} 的 CHANGELOG.md 未进入 tarball`)
    }
    const tag = tagName(pkg)
    const localTag = await localTagCommit(tag, { repoRoot, gitBin })
    if (localTag !== null) throw new ReleaseError(`本地 tag 已存在：${tag}（${localTag}）`)
    await checkChangelog({ pkg, version: pkg.version, repoRoot, gitBin })
    plan.push({
      pkg,
      files,
      changelog: 'ok',
      tag: 'new',
    })
  }

  try {
    await assertCommitted({
      repoRoot,
      gitBin,
      tarballs: plan.map(({ pkg, files }) => ({ pkg, files })),
    })
  } catch (error) {
    if (!dryRun) throw error
    io.error(`警告：${error.message}`)
  }

  for (const item of plan) {
    await runPackageChecks(item.pkg, {
      pnpmBin,
      repoRoot,
      skip: options.skipChecks === true,
      env: options.env,
    })
  }

  if (!dryRun) {
    for (const item of plan) {
      await assertTagAbsent(item.pkg, { repoRoot, gitBin, remote: options.remote ?? 'origin' })
      const state = await target.inspectVersion({
        name: item.pkg.name,
        version: item.pkg.version,
        withTime: false,
      })
      if (state.state === 'published') {
        throw new ReleaseError(
          `${item.pkg.name}@${item.pkg.version} 已发布；先提升版本号再发布`,
        )
      }
    }
    await target.checkAuth()
  }

  for (const line of formatPlan(plan, target)) io.log(line)

  if (dryRun) {
    io.log('dry-run：未发布，未认证。')
    return 0
  }

  await confirmPublish(io, options.yes)
  await assertCommitted({
    repoRoot,
    gitBin,
    tarballs: plan.map(({ pkg, files }) => ({ pkg, files })),
  })
  const releaseCommit = await headCommit({ repoRoot, gitBin })

  const results = await publishAll({
    plan,
    target,
    otp: options.otp,
    io,
    releaseCommit,
    repoRoot,
    gitBin,
    remote: options.remote ?? 'origin',
    tagRetries: options.tagRetries ?? 2,
  })
  const finishedAt = new Date().toISOString()
  const exitCode = results.every(result => result.status === 'published' && result.tagError === undefined)
    ? 0
    : 1
  const rollback = await collectRollback(target, results)
  const directory = options.reportDir === undefined
    ? await createReportDirectory(join(repoRoot, '.tmp/release'))
    : resolve(options.reportDir)

  await writeReport({
    directory,
    target: target.id,
    registry: target.registry,
    startedAt,
    finishedAt,
    exitCode,
    plan: planForReport(plan),
    results,
    rollback,
  })

  for (const result of results) {
    const detail = result.status === 'published' ? result.integrity ?? 'integrity 未知' : result.status
    io.log(`  ${result.name}@${result.version}：${detail}`)
  }
  io.log(`报告：${directory}`)
  if (exitCode !== 0) {
    io.error('发布未全部成功。检查报告中的回滚命令；工具没有自动撤销。')
  }
  return exitCode
}
