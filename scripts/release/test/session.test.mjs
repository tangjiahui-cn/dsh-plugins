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
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'init'])
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

test('release:clean 命令清理状态并返回 0', async () => {
  const root = await repo()
  await writeSession({ stage: 'prepared' }, root)
  const logs = []
  const code = await runClean({ repoRoot: root, io: { log: message => logs.push(message), error() {} } })
  assert.equal(code, 0)
  assert.equal(await readSession(root), null)
  assert.match(logs.join('\n'), /已删除/)
})

