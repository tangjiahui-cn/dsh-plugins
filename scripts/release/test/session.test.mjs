import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { runClean } from '../clean-command.mjs'
import {
  acquireLock,
  cleanState,
  hashFiles,
  readLock,
  readSession,
  releaseLock,
  restoreGeneratedFiles,
  writeSession,
} from '../session.mjs'
import { headCommit } from '../tags.mjs'
import { runCommand } from '../util.mjs'
import { makeTempDir, writeJson } from '../test-support/helpers.mjs'

async function git(cwd, args) {
  const result = await runCommand('git', args, { cwd })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function repo() {
  const root = await makeTempDir()
  await writeJson(join(root, 'file.json'), { version: '1.0.0' })
  await writeFile(join(root, '.gitignore'), '.tmp/\n')
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'init'])
  const remoteRoot = await makeTempDir('dsh-release-clean-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])
  await git(root, ['push', '-q', 'origin', 'HEAD'])
  return root
}

test('锁互斥、释放与陈旧锁清理', async () => {
  const root = await repo()
  const lock = await acquireLock({ repoRoot: root, command: 'release' })
  assert.equal((await readLock(root)).pid, process.pid)
  await assert.rejects(
    () => acquireLock({ repoRoot: root, command: 'publish' }),
    /已有一个发布命令在运行/,
  )
  await releaseLock(root)
  assert.equal(await readLock(root), null)

  await mkdir(join(root, '.tmp/release'), { recursive: true })
  await writeJson(join(root, '.tmp/release/lock'), { pid: 999999, command: 'old' })
  await assert.rejects(
    () => acquireLock({ repoRoot: root, command: 'publish' }),
    /存在陈旧发布锁/,
  )
  const next = await acquireLock({ repoRoot: root, command: 'release', clearStale: true })
  assert.equal(next.pid, process.pid)
  await releaseLock(root)
})

test('cleanState 删除 session、临时目录与陈旧锁，但保留报告和缓存', async () => {
  const root = await repo()
  await writeSession({ stage: 'prepared' }, root)
  await mkdir(join(root, '.tmp/release/session/tmp'), { recursive: true })
  await writeFile(join(root, '.tmp/release/session/tmp/a'), 'a')
  await mkdir(join(root, '.tmp/release/report'), { recursive: true })
  await writeFile(join(root, '.tmp/release/report/report.json'), '{}')
  await mkdir(join(root, '.tmp/release/npm-cache'), { recursive: true })
  await writeFile(join(root, '.tmp/release/npm-cache/a'), 'a')
  await writeJson(join(root, '.tmp/release/lock'), { pid: 999999, command: 'old' })

  const result = await cleanState(root)
  assert.ok(result.removed.length > 0)
  assert.equal(await readSession(root), null)
  assert.equal(await readLock(root), null)
  assert.ok((await stat(join(root, '.tmp/release/report/report.json'))).isFile())
  assert.ok((await stat(join(root, '.tmp/release/npm-cache/a'))).isFile())
})

test('提交前中断：hash 匹配时恢复文件', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeFile(join(root, 'file.json'), JSON.stringify({ version: '2.0.0' }))
  const files = await hashFiles(root, ['file.json'])
  await writeSession({ baseHead, files }, root)

  const result = await restoreGeneratedFiles({ repoRoot: root, session: await readSession(root) })
  assert.equal(result.restored, true)
  assert.match(await readFile(join(root, 'file.json'), 'utf8'), /1\.0\.0/)
})

test('提交前中断：hash 不匹配或 HEAD 变化时停止', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeFile(join(root, 'file.json'), JSON.stringify({ version: '2.0.0' }))
  const files = await hashFiles(root, ['file.json'])
  await writeSession({ baseHead, files }, root)
  await writeFile(join(root, 'file.json'), JSON.stringify({ version: '3.0.0' }))
  await assert.rejects(
    () => restoreGeneratedFiles({ repoRoot: root, session: { baseHead, files } }),
    /文件在中断后被修改/,
  )

  await git(root, ['checkout', '--', 'file.json'])
  await writeFile(join(root, 'other.txt'), 'x')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'other'])
  await writeFile(join(root, 'file.json'), JSON.stringify({ version: '4.0.0' }))
  await assert.rejects(
    () => restoreGeneratedFiles({ repoRoot: root, session: { baseHead, files } }),
    /HEAD.*已变化|工作区在中断后已变化/,
  )
})

test('release:clean 恢复提交前生成文件并清理状态', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeFile(join(root, 'file.json'), JSON.stringify({ version: '2.0.0' }))
  const files = await hashFiles(root, ['file.json'])
  await writeSession({ stage: 'prepared', baseHead, releaseCommit: null, files, packages: [] }, root)
  const logs = []
  const code = await runClean({ repoRoot: root, gitBin: 'git', io: { log: message => logs.push(message), error() {} } })
  assert.equal(code, 0)
  assert.match(await readFile(join(root, 'file.json'), 'utf8'), /1\.0\.0/)
  assert.equal(await readSession(root), null)
  assert.match(logs.join('\n'), /已恢复/)
})

test('release:clean 发现版本已发布时拒绝恢复', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeSession({
    stage: 'cancelled',
    baseHead,
    releaseCommit: baseHead,
    files: [],
    packages: [{ name: '@tjh/dsh-plugin-alpha', version: '0.1.0' }],
  }, root)
  const target = {
    async inspectVersion() {
      return { state: 'published', publishedAt: '2026-11-20T00:00:00.000Z', gitHead: null }
    },
  }
  await assert.rejects(
    () => runClean({ repoRoot: root, gitBin: 'git', targetAdapter: target, io: { log() {}, error() {} } }),
    /已发布，不能恢复到发布前快照/,
  )
  assert.notEqual(await readSession(root), null)
})


test('release:clean 发现额外改动时拒绝恢复', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeSession({ stage: 'prepared', baseHead, releaseCommit: null, files: [], packages: [] }, root)
  await writeFile(join(root, 'extra.txt'), 'extra\n')
  await assert.rejects(
    () => runClean({ repoRoot: root, gitBin: 'git', io: { log() {}, error() {} } }),
    /之外的改动/,
  )
})

test('release:clean 发现 tag 已存在时拒绝恢复', async () => {
  const root = await repo()
  const baseHead = (await headCommit({ repoRoot: root })).trim()
  await writeSession({
    stage: 'cancelled',
    baseHead,
    releaseCommit: baseHead,
    files: [],
    packages: [{ name: '@tjh/dsh-plugin-alpha', version: '0.1.0' }],
  }, root)
  await git(root, ['tag', '@tjh/dsh-plugin-alpha@0.1.0'])
  const target = {
    async inspectVersion() {
      return { state: 'absent' }
    },
  }
  await assert.rejects(
    () => runClean({ repoRoot: root, gitBin: 'git', targetAdapter: target, io: { log() {}, error() {} } }),
    /tag .* 已存在/,
  )
})

test('release:clean 无 session 时只清临时状态并保留报告与缓存', async () => {
  const root = await repo()
  await mkdir(join(root, '.tmp/release/report'), { recursive: true })
  await writeFile(join(root, '.tmp/release/report/report.json'), '{}')
  await mkdir(join(root, '.tmp/release/npm-cache'), { recursive: true })
  await writeFile(join(root, '.tmp/release/npm-cache/a'), 'a')
  const logs = []
  const code = await runClean({ repoRoot: root, gitBin: 'git', io: { log: message => logs.push(message), error() {} } })
  assert.equal(code, 0)
  assert.ok((await stat(join(root, '.tmp/release/report/report.json'))).isFile())
  assert.ok((await stat(join(root, '.tmp/release/npm-cache/a'))).isFile())
  assert.match(logs.join('\n'), /没有需要清理/)
})
