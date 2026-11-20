import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { runTag } from '../tag-command.mjs'
import { headCommit, localTagCommit, remoteTagCommit } from '../tags.mjs'
import { runCommand } from '../util.mjs'
import { makeTempDir, writeJson } from '../test-support/helpers.mjs'

async function git(cwd, args) {
  const result = await runCommand('git', args, { cwd })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function fixture({ changelog = false, gitHead = true } = {}) {
  const root = await makeTempDir()
  const dir = join(root, 'plugins', 'alpha')
  await writeJson(join(dir, 'package.json'), {
    name: '@tjh/dsh-plugin-alpha',
    version: '0.1.0',
    files: ['index.js', 'CHANGELOG.md'],
  })
  await writeFile(join(dir, 'index.js'), 'export {}\n')
  if (changelog) await writeFile(join(dir, 'CHANGELOG.md'), '# Changelog\n')
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'feat: init'])
  const commit = (await headCommit({ repoRoot: root })).trim()

  const remoteRoot = await makeTempDir('dsh-release-tag-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])

  const target = {
    id: 'npm',
    registry: 'https://registry.npmjs.org/',
    async inspectVersion() {
      return {
        state: 'published',
        publishedAt: '2026-11-20T00:00:00.000Z',
        gitHead: gitHead ? commit : null,
      }
    },
  }
  return { root, dir, commit, target, options: { repoRoot: root, remote: 'origin', targetAdapter: target } }
}

const io = () => ({ log() {}, error() {} })

test('release:tag 用 gitHead 创建并 push tag', async () => {
  const data = await fixture()
  const result = await runTag({
    spec: '@tjh/dsh-plugin-alpha@0.1.0',
    io: io(),
    ...data.options,
  })
  assert.equal(result.state, 'created')
  assert.equal(result.changelogMissing, true)
  assert.equal(await localTagCommit('@tjh/dsh-plugin-alpha@0.1.0', data.options), data.commit)
  assert.equal(await remoteTagCommit('@tjh/dsh-plugin-alpha@0.1.0', data.options), data.commit)
})

test('release:tag 用 --at 在 gitHead 缺失时定位', async () => {
  const data = await fixture({ gitHead: false, changelog: true })
  const result = await runTag({
    spec: '@tjh/dsh-plugin-alpha@0.1.0',
    at: data.commit,
    io: io(),
    ...data.options,
  })
  assert.equal(result.state, 'created')
  assert.equal(result.changelogMissing, false)
})

test('release:tag 无目标 commit 时拒绝，不使用 HEAD', async () => {
  const data = await fixture({ gitHead: false })
  await assert.rejects(
    () => runTag({ spec: '@tjh/dsh-plugin-alpha@0.1.0', io: io(), ...data.options }),
    /请用 --at/,
  )
})

test('release:tag 版本与目标 commit 不一致时拒绝', async () => {
  const data = await fixture()
  await assert.rejects(
    () => runTag({ spec: '@tjh/dsh-plugin-alpha@9.9.9', io: io(), ...data.options }),
    /期望 .*9\.9\.9/,
  )
})
