import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  gitBin as defaultGitBin,
  npmBin as defaultNpmBin,
  pnpmBin as defaultPnpmBin,
  repoRoot as defaultRepoRoot,
} from './config.mjs'
import { writeChangelog } from './changelog.mjs'
import { workingTreeStatus } from './git.mjs'
import { discoverPackages, selectPackages } from './packages.mjs'
import { runPublish } from './publish.mjs'
import {
  clearSession,
  hashFiles,
  readSession,
  writeSession,
} from './session.mjs'
import { assertOfficialSource } from './source.mjs'
import {
  assertOrigin,
  changelogMissingAtCommit,
  headCommit,
  inspectTagState,
  repairTag,
  resolveTagCommit,
  tagName,
} from './tags.mjs'
import { getTarget } from './targets/index.mjs'
import { ReleaseError, runCommand } from './util.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
  isTTY: false,
  ask: async () => '',
}

async function git(args, options) {
  const result = await runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot,
    env: options.env,
  })
  if (result.error !== undefined) throw new ReleaseError(`无法执行 git：${result.error.message}`)
  if (result.code !== 0) {
    throw new ReleaseError(`git ${args.join(' ')} 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (match === null) throw new ReleaseError(`版本号必须是 x.y.z：${version}`)
  return match.slice(1).map(Number)
}

export function bumpVersion(current, choice) {
  const [major, minor, patch] = parseVersion(current)
  if (choice === 'patch') return `${major}.${minor}.${patch + 1}`
  if (choice === 'minor') return `${major}.${minor + 1}.0`
  if (choice === 'major') return `${major + 1}.0.0`
  throw new ReleaseError(`未知版本变化：${choice}`)
}

async function promptVersion(io, pkg) {
  const answer = (await io.ask(
    `${pkg.name} 当前 ${pkg.version}；新版本 [patch/minor/major/custom/keep]（默认 keep）：`,
  )).trim().toLowerCase()
  if (answer === 'q') throw new ReleaseError('已取消发布')
  if (answer === '' || answer === 'keep') return pkg.version
  if (answer === 'custom') {
    const custom = (await io.ask('输入新版本（x.y.z）：')).trim()
    parseVersion(custom)
    return custom
  }
  return bumpVersion(pkg.version, answer)
}

async function setPackageVersion(pkg, version) {
  const path = join(pkg.dir, 'package.json')
  const text = await readFile(path, 'utf8')
  const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
  if (next === text) throw new ReleaseError(`无法写入版本号：${path}`)
  JSON.parse(next)
  await writeFile(path, next)
  pkg.version = version
  pkg.manifest.version = version
}

function parseSelection(answer, count) {
  const text = answer.trim().toLowerCase()
  if (text === '' || text === 'all') return Array.from({ length: count }, (_, index) => index)
  const indexes = []
  for (const part of text.split(',')) {
    const index = Number(part.trim())
    if (!Number.isInteger(index) || index < 1 || index > count) {
      throw new ReleaseError(`无效选择：${part}`)
    }
    if (!indexes.includes(index - 1)) indexes.push(index - 1)
  }
  return indexes
}

function selectionLabel(state) {
  if (state.kind === 'tag-only') return '已发布，只补 tag'
  return '未发布'
}

async function classify(pkg, target, options) {
  const state = await target.inspectVersion({ name: pkg.name, version: pkg.version, withTime: false })
  if (state.state === 'absent') return { kind: 'unpublished', state }
  const tags = await inspectTagState(pkg, options)
  return { kind: 'tag-only', state, tags }
}

export async function runRelease(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const gitBin = options.gitBin ?? defaultGitBin
  const npmBin = options.npmBin ?? defaultNpmBin
  const pnpmBin = options.pnpmBin ?? defaultPnpmBin
  const target = options.targetAdapter ?? getTarget(options.targetId)
  const startedAt = new Date().toISOString()

  const prior = await readSession(repoRoot)
  if (prior !== null) {
    throw new ReleaseError(
      `上次发布未完成（阶段：${prior.stage}）。先执行 pnpm release:clean 恢复到发布前快照，再重新运行 pnpm release。`,
    )
  }

  const status = await workingTreeStatus({ repoRoot, gitBin })
  if (status.length > 0) {
    throw new ReleaseError(`工作区不干净，先提交或 stash：\n${status.join('\n')}`)
  }

  await assertOfficialSource({
    repoRoot,
    npmrcPath: join(repoRoot, '.npmrc'),
    lockfilePath: join(repoRoot, 'pnpm-lock.yaml'),
    npmBin,
    pnpmBin,
    registry: target.registry,
    env: options.env,
  })
  await assertOrigin({ repoRoot, gitBin, remote: options.remote ?? 'origin' })
  await target.checkAuth()

  const packages = await discoverPackages(join(repoRoot, 'plugins'), repoRoot)
  const candidates = selectPackages(packages, options.packages ?? [])
  const classified = []
  for (const pkg of candidates) {
    classified.push({ pkg, ...(await classify(pkg, target, { repoRoot, gitBin, remote: options.remote ?? 'origin' })) })
  }
  if (classified.length === 0) {
    io.log('没有可处理的子包。')
    return 0
  }

  let selected
  if ((options.packages ?? []).length > 0) {
    selected = classified
  } else {
    io.log('可选子包：')
    classified.forEach((item, index) => {
      io.log(`  ${index + 1}. ${item.pkg.name}@${item.pkg.version}  ${selectionLabel(item)}`)
    })
    const answer = await io.ask('选择包（all 或序号，逗号分隔；默认 all）：')
    const indexes = parseSelection(answer, classified.length)
    selected = indexes.map(index => classified[index])
  }

  const unpublished = selected.filter(item => item.kind === 'unpublished')
  const tagOnly = selected.filter(item => item.kind === 'tag-only')
  const changedPaths = []

  for (const item of unpublished) {
    const version = await promptVersion(io, item.pkg)
    if (version !== item.pkg.version) {
      await setPackageVersion(item.pkg, version)
      changedPaths.push(`${item.pkg.relDir}/package.json`)
    }
  }

  for (const item of unpublished) {
    const result = await writeChangelog({
      pkg: item.pkg,
      version: item.pkg.version,
      repoRoot,
      gitBin,
    })
    if (result.changed) changedPaths.push(`${item.pkg.relDir}/CHANGELOG.md`)
    if (result.section === null && result.reason !== undefined) {
      io.error(`警告：${item.pkg.name} 没有可写入的 changelog 提交：${result.reason}`)
    }
  }

  const baseHead = await headCommit({ repoRoot, gitBin })
  const files = await hashFiles(repoRoot, [...new Set(changedPaths)])
  const releasePackages = unpublished.map(item => ({
    name: item.pkg.name,
    version: item.pkg.version,
  }))
  await writeSession({
    command: 'release',
    stage: 'prepared',
    baseHead,
    releaseCommit: null,
    files,
    packages: releasePackages,
    startedAt,
  }, repoRoot)

  const commitPaths = [...new Set(changedPaths)]
  if (commitPaths.length > 0) {
    await git(['add', '--', ...commitPaths], { repoRoot, gitBin })
    const diff = await git(['diff', '--cached', '--stat'], { repoRoot, gitBin })
    if (diff.trim() !== '') {
      io.log(diff.trimEnd())
      const names = unpublished.map(item => `${item.pkg.name}@${item.pkg.version}`).join(', ')
      const message = (await io.ask(`提交信息（默认 chore(release): ${names}）：`)).trim()
        || `chore(release): ${names}`
      await git(['commit', '-m', message], { repoRoot, gitBin, env: options.env })
    }
  }

  const releaseCommit = await headCommit({ repoRoot, gitBin })
  await writeSession({
    command: 'release',
    stage: 'committed',
    baseHead,
    releaseCommit,
    files,
    packages: releasePackages,
    startedAt,
  }, repoRoot)

  let exitCode = 0
  if (unpublished.length > 0) {
    try {
      exitCode = await runPublish({
        repoRoot,
        npmBin,
        pnpmBin,
        gitBin,
        targetAdapter: target,
        packages: unpublished.map(item => item.pkg.name),
        skipChecks: options.skipChecks === true,
        yes: options.yes === true,
        otp: options.otp,
        reportDir: options.reportDir,
        env: options.env,
        io,
      })
    } catch (error) {
      if (error instanceof ReleaseError && /已取消发布/.test(error.message)) {
        await writeSession({
          command: 'release',
          stage: 'cancelled',
          baseHead,
          releaseCommit,
          files,
          packages: releasePackages,
          startedAt,
        }, repoRoot)
        io.log('已取消发布。运行 pnpm release:clean 可恢复到发布前快照。')
        return 1
      }
      throw error
    }
    if (exitCode !== 0) {
      io.error('发布未完成，已停止后续步骤。按报告处理已发布版本后，执行 pnpm release:clean 再重新发布。')
      return exitCode
    }
  }

  for (const item of tagOnly) {
    const targetCommit = await resolveTagCommit({
      pkg: item.pkg,
      session: null,
      gitHead: item.state.gitHead,
      at: options.at,
      repoRoot,
      gitBin,
      remote: options.remote ?? 'origin',
    })
    const changelogMissing = await changelogMissingAtCommit({
      pkg: item.pkg,
      commit: targetCommit,
      repoRoot,
      gitBin,
    })
    await repairTag({
      pkg: item.pkg,
      targetCommit,
      repoRoot,
      gitBin,
      remote: options.remote ?? 'origin',
    })
    io.log(`tag ${tagName(item.pkg)}：已修复${changelogMissing ? '（发布包缺 changelog）' : ''}`)
    if (changelogMissing) io.error(`警告：${item.pkg.name}@${item.pkg.version} 缺 changelog，无法事后补入已发布 tarball。`)
  }

  if (exitCode === 0) {
    await clearSession(repoRoot)
  }
  return exitCode
}
