import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { runClean } from '../clean-command.mjs'
import { bumpVersion, runRelease } from '../flow.mjs'
import { localTagCommit, remoteTagCommit } from '../tags.mjs'
import { readSession } from '../session.mjs'
import { headCommit } from '../tags.mjs'
import { runCommand } from '../util.mjs'
import { makeIo, makeTempDir, writeExecutable, writeFiles, writeJson } from '../test-support/helpers.mjs'

const official = 'https://registry.npmjs.org/'
const packFiles = ['package.json', 'LICENSE', 'cordis.patch.yml', 'CHANGELOG.md', 'index.js', 'locale/en.json']

async function git(cwd, args) {
  const result = await runCommand('git', args, { cwd })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function makeRepo({ published = false, changelog = false, gitHead = true } = {}) {
  const root = await makeTempDir()
  const dir = join(root, 'plugins', 'alpha')
  await writeFiles(root, {
    '.npmrc': `registry=${official}\n@tjh:registry=${official}\n`,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    '.gitignore': '.tmp/\n',
  })
  await writeJson(join(dir, 'package.json'), {
    name: '@tjh/dsh-plugin-alpha',
    version: '0.1.0',
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.test/repo.git', directory: 'plugins/alpha' },
    files: ['index.js', 'cordis.patch.yml', 'locale/*.json', 'LICENSE', 'CHANGELOG.md'],
    exports: { '.': './index.js', './locale/*.json': './locale/*.json' },
    publishConfig: { access: 'public', registry: official },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFiles(dir, {
    LICENSE: 'MIT\n',
    'cordis.patch.yml': '- insert: []\n',
    'index.js': 'export const ok = true\n',
    'locale/en.json': '{}\n',
  })
  if (changelog) await writeFile(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 - 2026-11-20\n\n### 维护\n\n- init (abc)\n')

  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'feat: init'])
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()

  const remoteRoot = await makeTempDir('dsh-release-flow-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])
  await git(root, ['push', '-q', 'origin', 'HEAD'])

  const binRoot = await makeTempDir('dsh-release-flow-bin-')
  const fakeBin = await writeExecutable(binRoot, 'fake-npm', `
    const args = process.argv.slice(2)
    if (args[0] === 'config') { process.stdout.write(${JSON.stringify(official)} + '\\n'); process.exit(0) }
    if (args[0] === 'pack') {
      process.stdout.write(JSON.stringify([{ files: ${JSON.stringify(packFiles)}.map(path => ({ path })) }]))
      process.exit(0)
    }
    process.exit(2)
  `)

  const publishedList = []
  const target = {
    id: 'npm',
    registry: official,
    async checkAuth() { return { user: 'tester' } },
    async inspectVersion() {
      return published
        ? { state: 'published', publishedAt: '2026-11-20T00:00:00.000Z', gitHead: gitHead ? commit : null }
        : { state: 'absent' }
    },
    async publish({ name, version }) {
      publishedList.push(`${name}@${version}`)
      return { integrity: 'sha512-test', url: `https://www.npmjs.com/package/${name}` }
    },
    async withdrawPlan({ name, version }) {
      return { executable: true, commands: [`npm unpublish '${name}@${version}' --force`], note: '' }
    },
  }

  return { root, dir, commit, fakeBin, target, publishedList }
}

const io = (answers = []) => makeIo({ isTTY: true, answers })

test('bumpVersion 支持 patch/minor/major', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
  assert.throws(() => bumpVersion('1.2.3', 'custom'), /未知版本变化/)
})

test('release 一键流程：问版本、生成 changelog、提交、发布、打 tag', async () => {
  const data = await makeRepo()
  const output = io(['', ''])
  const code = await runRelease({
    repoRoot: data.root,
    npmBin: data.fakeBin,
    pnpmBin: data.fakeBin,
    gitBin: 'git',
    targetAdapter: data.target,
    packages: ['@tjh/dsh-plugin-alpha'],
    skipChecks: true,
    yes: true,
    io: output,
  })
  assert.equal(code, 0)
  assert.deepEqual(data.publishedList, ['@tjh/dsh-plugin-alpha@0.1.0'])
  const changelog = await readFile(join(data.dir, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /## 0\.1\.0/)
  const tag = '@tjh/dsh-plugin-alpha@0.1.0'
  assert.ok(await localTagCommit(tag, { repoRoot: data.root }))
  assert.ok(await remoteTagCommit(tag, { repoRoot: data.root }))
})

test('release 只补 tag：不重新发布、不提交版本', async () => {
  const data = await makeRepo({ published: true, changelog: true })
  const output = io([])
  const code = await runRelease({
    repoRoot: data.root,
    npmBin: data.fakeBin,
    pnpmBin: data.fakeBin,
    gitBin: 'git',
    targetAdapter: data.target,
    packages: ['@tjh/dsh-plugin-alpha'],
    skipChecks: true,
    yes: true,
    io: output,
  })
  assert.equal(code, 0)
  assert.deepEqual(data.publishedList, [])
  assert.ok(await localTagCommit('@tjh/dsh-plugin-alpha@0.1.0', { repoRoot: data.root }))
})

test('release 初始工作区不干净时终止', async () => {
  const data = await makeRepo()
  await writeFile(join(data.root, 'dirty.txt'), 'dirty\n')
  await assert.rejects(
    () => runRelease({
      repoRoot: data.root,
      npmBin: data.fakeBin,
      pnpmBin: data.fakeBin,
      gitBin: 'git',
      targetAdapter: data.target,
      packages: ['@tjh/dsh-plugin-alpha'],
      skipChecks: true,
      yes: true,
      io: io([]),
    }),
    /工作区不干净/,
  )
  assert.deepEqual(data.publishedList, [])
})

test('release 取消版本询问时不写文件、不发布', async () => {
  const data = await makeRepo()
  await assert.rejects(
    () => runRelease({
      repoRoot: data.root,
      npmBin: data.fakeBin,
      pnpmBin: data.fakeBin,
      gitBin: 'git',
      targetAdapter: data.target,
      packages: ['@tjh/dsh-plugin-alpha'],
      skipChecks: true,
      yes: true,
      io: io(['q']),
    }),
    /已取消发布/,
  )
  assert.deepEqual(data.publishedList, [])
})

test('release 已发布但无法定位 tag commit 时停止', async () => {
  const data = await makeRepo({ published: true, changelog: true, gitHead: false })
  await assert.rejects(
    () => runRelease({
      repoRoot: data.root,
      npmBin: data.fakeBin,
      pnpmBin: data.fakeBin,
      gitBin: 'git',
      targetAdapter: data.target,
      packages: ['@tjh/dsh-plugin-alpha'],
      skipChecks: true,
      yes: true,
      io: io([]),
    }),
    /请用 --at/,
  )
  assert.deepEqual(data.publishedList, [])
})

test('release 在计划确认处取消后 clean 恢复快照', async () => {
  const data = await makeRepo()
  const output = io(['', '', 'n'])
  const code = await runRelease({
    repoRoot: data.root,
    npmBin: data.fakeBin,
    pnpmBin: data.fakeBin,
    gitBin: 'git',
    targetAdapter: data.target,
    packages: ['@tjh/dsh-plugin-alpha'],
    skipChecks: true,
    yes: false,
    io: output,
  })
  assert.equal(code, 1)
  assert.deepEqual(data.publishedList, [])
  const session = await readSession(data.root)
  assert.equal(session.stage, 'cancelled')

  const cleanCode = await runClean({
    repoRoot: data.root,
    targetAdapter: data.target,
    gitBin: 'git',
    io: io([]),
  })
  assert.equal(cleanCode, 0)
  assert.equal((await headCommit({ repoRoot: data.root })).trim(), data.commit)
  assert.equal(await readSession(data.root), null)
})

