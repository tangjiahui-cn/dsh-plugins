import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { assertCommitted, assertTracked, workingTreeStatus } from '../git.mjs'
import { runCommand } from '../util.mjs'
import { makeTempDir } from '../test-support/helpers.mjs'

async function git(root, args) {
  const result = await runCommand('git', args, { cwd: root })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function initRepo(root) {
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await writeFile(join(root, 'tracked.txt'), 'tracked\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'init'])
}

const tarballs = (files, relDir = '') => [{ pkg: { relDir }, files }]

test('干净且被跟踪的工作区通过', async () => {
  const root = await makeTempDir()
  await initRepo(root)
  assert.deepEqual(await workingTreeStatus({ repoRoot: root }), [])
  await assertCommitted({ repoRoot: root, tarballs: tarballs(['tracked.txt']) })
  await assertTracked(['tracked.txt'], { repoRoot: root })
})

test('未跟踪文件被拒绝', async () => {
  const root = await makeTempDir()
  await initRepo(root)
  await writeFile(join(root, 'untracked.txt'), 'new\n')
  await assert.rejects(
    () => assertCommitted({ repoRoot: root, tarballs: tarballs(['tracked.txt']) }),
    /未提交改动[\s\S]*untracked\.txt/,
  )
})

test('已暂存文件被拒绝', async () => {
  const root = await makeTempDir()
  await initRepo(root)
  await writeFile(join(root, 'staged.txt'), 'staged\n')
  await git(root, ['add', 'staged.txt'])
  await assert.rejects(
    () => assertCommitted({ repoRoot: root, tarballs: tarballs(['tracked.txt']) }),
    /未提交改动[\s\S]*staged\.txt/,
  )
})

test('被忽略但会进入 tarball 的文件被拒绝', async () => {
  const root = await makeTempDir()
  await initRepo(root)
  await writeFile(join(root, '.gitignore'), 'dist/\n')
  await git(root, ['add', '.gitignore'])
  await git(root, ['commit', '-qm', 'ignore'])
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'out.js'), 'out\n')

  assert.deepEqual(await workingTreeStatus({ repoRoot: root }), [])
  await assert.rejects(
    () => assertCommitted({ repoRoot: root, tarballs: tarballs(['dist/out.js']) }),
    /未被 git 跟踪[\s\S]*dist\/out\.js/,
  )
})
