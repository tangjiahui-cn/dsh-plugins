import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitBin as defaultGitBin, repoRoot as defaultRepoRoot } from './config.mjs'
import { ReleaseError, runCommand } from './util.mjs'

const HEADER = '# Changelog'
const CATEGORY_ORDER = [
  ['breaking', '破坏性变更'],
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
  ['docs', '文档'],
  ['test', '测试'],
  ['maintenance', '维护'],
]
const TYPE_CATEGORY = {
  feat: 'feat',
  fix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  docs: 'docs',
  test: 'test',
}
const ALLOWED_RELEASE_FILES = new Set(['package.json', 'CHANGELOG.md'])

async function git(args, options = {}) {
  const result = await runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot ?? defaultRepoRoot,
    env: { GIT_TERMINAL_PROMPT: '0', ...options.env },
    timeoutMs: 60000,
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

async function gitOptional(args, options = {}) {
  return runCommand(options.gitBin ?? defaultGitBin, args, {
    cwd: options.repoRoot ?? defaultRepoRoot,
    env: { GIT_TERMINAL_PROMPT: '0', ...options.env },
    timeoutMs: 60000,
  })
}

export function dateInShanghai(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function parseCommitSubject(subject) {
  const match = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<subject>.+)$/.exec(subject)
  if (match === null) {
    return { type: 'maintenance', category: 'maintenance', subject, breaking: false }
  }
  const type = match.groups.type.toLowerCase()
  return {
    type,
    category: TYPE_CATEGORY[type] ?? 'maintenance',
    subject: match.groups.subject,
    breaking: match.groups.breaking === '!',
  }
}

function categoryKey(entry) {
  return entry.breaking ? 'breaking' : entry.category
}

export function renderSection({ version, date, commits }) {
  const groups = new Map()
  for (const commit of commits) {
    const key = categoryKey(commit)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(commit)
  }

  const lines = [`## ${version} - ${date}`]
  for (const [key, title] of CATEGORY_ORDER) {
    const entries = groups.get(key)
    if (entries === undefined || entries.length === 0) continue
    lines.push('', `### ${title}`, '')
    for (const entry of entries) lines.push(`- ${entry.subject} (${entry.shortHash})`)
  }
  return `${lines.join('\n')}`
}

function stripChangelogDir(file, pkg) {
  const prefix = `${pkg.relDir}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

async function isReleaseBookkeeping(commit, pkg, options) {
  const output = await git(
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit, '--', pkg.relDir],
    options,
  )
  const files = output.split('\n').map(line => line.trim()).filter(Boolean)
  if (files.length === 0) return false
  const relative = files.map(file => stripChangelogDir(file.replaceAll('\\', '/'), pkg))
  if (!relative.every(file => ALLOWED_RELEASE_FILES.has(file))) return false
  if (relative.length === 1 && relative[0] === 'CHANGELOG.md') return true

  const current = JSON.parse(await git(['show', `${commit}:${pkg.relDir}/package.json`], options))
  const parent = await gitOptional(
    ['show', `${commit}^:${pkg.relDir}/package.json`],
    options,
  )
  if (parent.code !== 0) return true
  const previous = JSON.parse(parent.stdout)
  return previous.version !== current.version
}

/** 采集从上一条 tag 到 HEAD 的包内提交，跳过末尾发布提交。 */
export async function collectCommits({ pkg, ...options }) {
  const tagResult = await gitOptional(
    ['describe', '--tags', '--abbrev=0', '--match', `${pkg.name}@*`, 'HEAD'],
    options,
  )
  const range = tagResult.code === 0 ? `${tagResult.stdout.trim()}..HEAD` : 'HEAD'
  const format = '--format=%H%x1f%h%x1f%s%x1e'
  const output = await git(['log', '--no-merges', format, range, '--', pkg.relDir], options)
  const commits = output
    .split('\x1e')
    .map(record => record.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map(record => {
      const [hash, shortHash, subject] = record.split('\x1f')
      return { hash, shortHash, subject, ...parseCommitSubject(subject) }
    })

  let start = 0
  while (start < commits.length && (await isReleaseBookkeeping(commits[start].hash, pkg, options))) {
    start += 1
  }
  return commits.slice(start)
}

export async function writeChangelog({ pkg, version, date = new Date(), ...options }) {
  const commits = await collectCommits({ pkg, ...options })
  const path = join(pkg.dir, 'CHANGELOG.md')
  const existing = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })

  if (commits.length === 0) {
    const current = sectionForVersion(existing, version)
    return {
      changed: false,
      path,
      section: current,
      reason: '没有可写入的提交',
    }
  }

  const section = renderSection({ version, date: dateInShanghai(date), commits })
  const merged = mergeChangelog(existing, version, section)
  if (merged === existing) {
    return { changed: false, path, section }
  }
  await writeFile(path, merged)
  return { changed: true, path, section }
}

export function sectionForVersion(text, version) {
  const pattern = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*$`, 'm')
  const match = pattern.exec(text)
  if (match === null) return null
  const start = match.index
  const rest = text.slice(start + match[0].length)
  const next = /\n## /.exec(rest)
  const section = next === null ? rest : rest.slice(0, next.index)
  return `${match[0]}${section}`.trim()
}

export function mergeChangelog(existing, version, section) {
  const sections = []
  let current = null
  for (const line of existing.split('\n')) {
    if (line.startsWith('## ')) {
      if (current !== null) sections.push({ key: current.key, lines: current.lines })
      current = { key: line.slice(3).trim().split(/\s+/)[0], lines: [line] }
    } else if (current !== null) {
      current.lines.push(line)
    }
  }
  if (current !== null) sections.push({ key: current.key, lines: current.lines })

  const others = sections
    .filter(item => item.key !== version)
    .map(item => item.lines.join('\n').trimEnd())
  const body = [section, ...others].join('\n\n')
  return `${HEADER}\n\n${body}\n`
}

export async function checkChangelog({ pkg, version, date = new Date(), ...options }) {
  const text = await readFile(join(pkg.dir, 'CHANGELOG.md'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') {
      throw new ReleaseError(`${pkg.name} 缺少 CHANGELOG.md；先运行 pnpm release:changelog`)
    }
    throw error
  })
  const actual = sectionForVersion(text, version)
  if (actual === null) {
    throw new ReleaseError(`${pkg.name} 的 CHANGELOG.md 缺少 ## ${version} 段落`)
  }

  const commits = await collectCommits({ pkg, ...options })
  if (commits.length === 0) {
    throw new ReleaseError(`${pkg.name}@${version} 没有可写入 changelog 的提交；先提交功能变更`)
  }
  const actualDate = /^## \S+ - (\S+)/.exec(actual)?.[1] ?? dateInShanghai(date)
  const expected = renderSection({ version, date: actualDate, commits })
  if (actual.trimEnd() !== expected.trimEnd()) {
    throw new ReleaseError(`${pkg.name} 的 CHANGELOG.md 与提交不一致；重跑 pnpm release:changelog`)
  }
}
