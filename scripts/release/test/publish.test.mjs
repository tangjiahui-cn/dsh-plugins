import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { writeChangelog } from '../changelog.mjs'
import { discoverPackages } from '../packages.mjs'
import { confirmPublish, publishAll, runPublish } from '../publish.mjs'
import { runCommand } from '../util.mjs'
import { makeIo, makeTempDir, writeExecutable, writeFiles, writeJson } from '../test-support/helpers.mjs'

const official = 'https://registry.npmjs.org/'
const packFiles = ['package.json', 'LICENSE', 'cordis.patch.yml', 'CHANGELOG.md', 'index.js', 'locale/en.json']

async function git(root, args) {
  const result = await runCommand('git', args, { cwd: root })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
}

async function makePlugin(root, short) {
  const name = `@tjhaaa/dsh-plugin-${short}`
  const dir = join(root, 'plugins', short)
  await writeJson(join(dir, 'package.json'), {
    name,
    version: '0.1.0',
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.test/repo.git', directory: `plugins/${short}` },
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
}

async function makeRepo() {
  const root = await makeTempDir()
  await writeFiles(root, {
    '.npmrc': `registry=${official}\n@tjhaaa:registry=${official}\n`,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
  for (const short of ['alpha', 'beta', 'gamma']) await makePlugin(root, short)

  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'init'])

  const packages = await discoverPackages(join(root, 'plugins'), root)
  for (const pkg of packages) await writeChangelog({ pkg, version: pkg.version, repoRoot: root })
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'docs: changelog'])

  const remoteRoot = await makeTempDir('dsh-release-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])
  await git(root, ['push', '-q', 'origin', 'HEAD'])

  const binRoot = await makeTempDir('dsh-release-bin-')
  const fakeBin = await writeExecutable(binRoot, 'fake-npm', `
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n')
    if (args[0] === 'config') { process.stdout.write((process.env.FAKE_REGISTRY || ${JSON.stringify(official)}) + '\\n'); process.exit(0) }
    if (args[0] === 'pack') {
      process.stdout.write(JSON.stringify([{ files: ${JSON.stringify(packFiles)}.map(path => ({ path })) }]))
      process.exit(0)
    }
    process.exit(2)
  `)
  return { root, fakeBin, remoteRoot }
}

function fakeTarget(failName) {
  const published = []
  return {
    published,
    id: 'npm',
    registry: official,
    async checkAuth() { return { user: 'tester' } },
    async inspectVersion() { return { state: 'absent' } },
    async publish({ name, version }) {
      if (name === failName) throw new Error('boom')
      published.push(`${name}@${version}`)
      return { integrity: `sha512-${name}`, url: `https://www.npmjs.com/package/${name}` }
    },
    async withdrawPlan({ name, version }) {
      return {
        executable: true,
        commands: [`npm unpublish '${name}@${version}' --force`],
        note: '可撤回',
      }
    },
  }
}

const baseOptions = (data, io, extra = {}) => ({
  repoRoot: data.root,
  npmBin: data.fakeBin,
  pnpmBin: data.fakeBin,
  env: { FAKE_REGISTRY: official },
  targetAdapter: fakeTarget(),
  skipChecks: true,
  yes: true,
  reportDir: join(data.root, 'report'),
  io,
  ...extra,
})

test('确认：--yes 跳过，非 TTY 拒绝，输入 y 通过', async () => {
  const io = makeIo({ isTTY: true, answers: ['y'] })
  await confirmPublish(io, true)
  assert.equal(io.asks.length, 0)
  await confirmPublish(io, false)
  assert.equal(io.asks.length, 1)

  const nonTty = makeIo({ isTTY: false })
  await assert.rejects(() => confirmPublish(nonTty, false), /非交互环境需要 --yes/)

  const rejected = makeIo({ isTTY: true, answers: ['n'] })
  await assert.rejects(() => confirmPublish(rejected, false), /已取消发布/)
})

test('dry-run 只输出计划，不调用 publish', async () => {
  const data = await makeRepo()
  const io = makeIo({ isTTY: false })
  const target = fakeTarget()
  const code = await runPublish(baseOptions(data, io, { dryRun: true, targetAdapter: target }))
  assert.equal(code, 0)
  assert.equal(target.published.length, 0)
  assert.match(io.logs.join('\n'), /发布计划/)
  assert.match(io.logs.join('\n'), /@tjhaaa\/dsh-plugin-alpha@0\.1\.0/)
})

test('顺序发布成功并写报告', async () => {
  const data = await makeRepo()
  const io = makeIo()
  const target = fakeTarget()
  const code = await runPublish(baseOptions(data, io, { targetAdapter: target }))
  assert.equal(code, 0)
  assert.deepEqual(target.published, [
    '@tjhaaa/dsh-plugin-alpha@0.1.0',
    '@tjhaaa/dsh-plugin-beta@0.1.0',
    '@tjhaaa/dsh-plugin-gamma@0.1.0',
  ])
  const report = JSON.parse(await readFile(join(data.root, 'report', 'report.json'), 'utf8'))
  assert.equal(report.exitCode, 0)
  assert.ok(report.results.every(result => result.status === 'published'))
})

test('发布失败但版本已存在时标记为 published-uncertain', async () => {
  const calls = []
  const target = {
    id: 'npm',
    registry: official,
    async publish({ name, version, dir }) {
      calls.push({ name, version, dir })
      if (name === '@tjhaaa/dsh-plugin-beta') throw new Error('timeout')
      return { integrity: null, url: 'https://www.npmjs.com/package/x' }
    },
    async inspectVersion({ name }) {
      return name === '@tjhaaa/dsh-plugin-beta'
        ? { state: 'published', publishedAt: '2026-11-20T00:00:00.000Z' }
        : { state: 'absent' }
    },
    async withdrawPlan({ name, version }) {
      return { executable: true, commands: [`npm unpublish '${name}@${version}'`], note: '' }
    },
  }
  const plan = ['alpha', 'beta', 'gamma'].map(short => ({
    pkg: {
      name: `@tjhaaa/dsh-plugin-${short}`,
      version: '1.0.0',
      dir: `/repo/plugins/${short}`,
    },
    files: [],
  }))
  const results = await publishAll({ plan, target, io: makeIo(), tagging: false })
  assert.deepEqual(results.map(result => result.status), [
    'published',
    'published-uncertain',
    'not-attempted',
  ])
  assert.deepEqual(calls.map(call => call.dir), ['/repo/plugins/alpha', '/repo/plugins/beta'])
})

test('第 2 个包失败时停止，第三包标为未尝试并生成回滚命令', async () => {
  const data = await makeRepo()
  const io = makeIo()
  const code = await runPublish(baseOptions(data, io, {
    targetAdapter: fakeTarget('@tjhaaa/dsh-plugin-beta'),
  }))
  assert.equal(code, 1)
  const report = JSON.parse(await readFile(join(data.root, 'report', 'report.json'), 'utf8'))
  assert.deepEqual(report.results.map(result => result.status), [
    'published',
    'failed',
    'not-attempted',
  ])
  assert.match(report.rollback.commands[0], /unpublish '@tjhaaa\/dsh-plugin-alpha@0\.1\.0'/)
  const script = await readFile(join(data.root, 'report', 'rollback.sh'), 'utf8')
  assert.match(script, /unpublish '@tjhaaa\/dsh-plugin-alpha@0\.1\.0'/)
})

test('发布前发现 tag 已存在时终止', async () => {
  const data = await makeRepo()
  await git(data.root, ['tag', '@tjhaaa/dsh-plugin-alpha@0.1.0'])
  await assert.rejects(
    () => runPublish(baseOptions(data, makeIo())),
    /本地 tag 已存在/,
  )
})

test('发布前发现 changelog 缺失或与提交不一致时终止', async () => {
  const data = await makeRepo()
  const changelog = join(data.root, 'plugins/alpha/CHANGELOG.md')
  const { rm } = await import('node:fs/promises')
  await rm(changelog)
  await assert.rejects(
    () => runPublish(baseOptions(data, makeIo())),
    /缺少 CHANGELOG\.md|没有可写入 changelog/,
  )

  await writeFile(changelog, '# Changelog\n\n## 0.1.0 - 2026-11-20\n\ntampered\n')
  await assert.rejects(
    () => runPublish(baseOptions(data, makeIo())),
    /与提交不一致/,
  )
})

