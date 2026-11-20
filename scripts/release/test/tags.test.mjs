import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  assertTagAbsent,
  changelogMissingAtCommit,
  createAnnotatedTag,
  deleteLocalTag,
  deleteRemoteTag,
  headCommit,
  localTagCommit,
  pushTag,
  remoteTagCommit,
  repairTag,
  resolveTagCommit,
  tagName,
} from '../tags.mjs'
import { runCommand } from '../util.mjs'
import { makeTempDir, writeJson } from '../test-support/helpers.mjs'

async function git(cwd, args) {
  const result = await runCommand('git', args, { cwd })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function fixture() {
  const root = await makeTempDir()
  const dir = join(root, 'plugins', 'alpha')
  await writeJson(join(dir, 'package.json'), {
    name: '@tjh/dsh-plugin-alpha',
    version: '0.1.0',
    files: ['index.js', 'CHANGELOG.md'],
  })
  await writeFile(join(dir, 'index.js'), 'export {}\n')
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'feat: init'])

  const remoteRoot = await makeTempDir('dsh-release-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])

  return {
    root,
    remoteRoot,
    pkg: {
      name: '@tjh/dsh-plugin-alpha',
      version: '0.1.0',
      relDir: 'plugins/alpha',
      dir,
    },
    options: { repoRoot: root, remote: 'origin' },
  }
}

test('tag 名使用包名与版本', async () => {
  const data = await fixture()
  assert.equal(tagName(data.pkg), '@tjh/dsh-plugin-alpha@0.1.0')
})

test('tag 不存在时通过，创建并 push 后本地与远程一致', async () => {
  const data = await fixture()
  const tag = tagName(data.pkg)
  await assertTagAbsent(data.pkg, data.options)
  const commit = (await headCommit(data.options)).trim()
  await createAnnotatedTag({ tag, commit, ...data.options })
  await pushTag({ tag, ...data.options })
  assert.equal(await localTagCommit(tag, data.options), commit)
  assert.equal(await remoteTagCommit(tag, data.options), commit)
  await assert.rejects(() => assertTagAbsent(data.pkg, data.options), /tag 已存在/)
})

test('repairTag 覆盖 none/local-only/remote-only/both', async () => {
  const data = await fixture()
  const tag = tagName(data.pkg)
  const commit = (await headCommit(data.options)).trim()

  assert.equal((await repairTag({ pkg: data.pkg, targetCommit: commit, ...data.options })).state, 'created')
  assert.equal((await repairTag({ pkg: data.pkg, targetCommit: commit, ...data.options })).state, 'verified')

  await deleteRemoteTag(tag, data.options)
  assert.equal((await repairTag({ pkg: data.pkg, targetCommit: commit, ...data.options })).state, 'pushed-local')

  await deleteLocalTag(tag, data.options)
  assert.equal((await repairTag({ pkg: data.pkg, targetCommit: commit, ...data.options })).state, 'fetched-remote')

  await deleteLocalTag(tag, data.options)
  await deleteRemoteTag(tag, data.options)
  assert.equal((await repairTag({ pkg: data.pkg, targetCommit: commit, ...data.options })).state, 'created')
})

test('tag 指向冲突时拒绝，不移动已有 tag', async () => {
  const data = await fixture()
  const tag = tagName(data.pkg)
  const first = (await headCommit(data.options)).trim()
  await createAnnotatedTag({ tag, commit: first, ...data.options })
  await writeFile(join(data.root, 'other.txt'), 'other\n')
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'fix: other'])
  const second = (await headCommit(data.options)).trim()

  await assert.rejects(
    () => repairTag({ pkg: data.pkg, targetCommit: second, ...data.options }),
    /tag 冲突/,
  )
  assert.equal(await localTagCommit(tag, data.options), first)
})

test('resolveTagCommit 按 session、gitHead、--at 解析并校验版本', async () => {
  const data = await fixture()
  const commit = (await headCommit(data.options)).trim()
  assert.equal(
    await resolveTagCommit({ pkg: data.pkg, session: { releaseCommit: commit }, ...data.options }),
    commit,
  )
  assert.equal(
    await resolveTagCommit({ pkg: data.pkg, session: null, gitHead: commit, ...data.options }),
    commit,
  )
  assert.equal(
    await resolveTagCommit({ pkg: data.pkg, session: null, gitHead: null, at: commit, ...data.options }),
    commit,
  )
  await assert.rejects(
    () => resolveTagCommit({ pkg: data.pkg, session: null, gitHead: null, ...data.options }),
    /请用 --at/,
  )

  const other = { ...data.pkg, version: '9.9.9' }
  await assert.rejects(
    () => resolveTagCommit({ pkg: other, session: { releaseCommit: commit }, ...data.options }),
    /期望 .*9\.9\.9/,
  )
})

test('changelogMissingAtCommit 按目标 commit 判断', async () => {
  const data = await fixture()
  const without = (await headCommit(data.options)).trim()
  await writeFile(join(data.pkg.dir, 'CHANGELOG.md'), '# Changelog\n')
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog'])
  const withChangelog = (await headCommit(data.options)).trim()

  assert.equal(await changelogMissingAtCommit({ pkg: data.pkg, commit: without, ...data.options }), true)
  assert.equal(await changelogMissingAtCommit({ pkg: data.pkg, commit: withChangelog, ...data.options }), false)
})
