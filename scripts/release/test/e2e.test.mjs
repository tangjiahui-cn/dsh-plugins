import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { writeChangelog } from '../changelog.mjs'
import { discoverPackages } from '../packages.mjs'
import { runPublish } from '../publish.mjs'
import { localTagCommit, remoteTagCommit } from '../tags.mjs'
import { createNpmTarget } from '../targets/npm.mjs'
import { runCommand } from '../util.mjs'
import { makeIo, makeTempDir, writeExecutable, writeFiles, writeJson } from '../test-support/helpers.mjs'

const official = 'https://registry.npmjs.org/'
const packFiles = ['package.json', 'LICENSE', 'cordis.patch.yml', 'CHANGELOG.md', 'index.js', 'locale/en.json']

async function git(root, args) {
  const result = await runCommand('git', args, { cwd: root })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
}

async function makePlugin(root, short) {
  const name = `@tjh/dsh-plugin-${short}`
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

async function makeRepo(shorts, failName = '') {
  const root = await makeTempDir()
  const stateFile = join(root, 'published.json')
  const binRoot = await makeTempDir('dsh-release-e2e-bin-')
  await writeFiles(root, {
    '.npmrc': `registry=${official}\n@tjh:registry=${official}\n`,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'published.json': '{}\n',
  })
  for (const short of shorts) await makePlugin(root, short)

  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'init'])

  const packages = await discoverPackages(join(root, 'plugins'), root)
  for (const pkg of packages) await writeChangelog({ pkg, version: pkg.version, repoRoot: root })
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'docs: changelog'])

  const remoteRoot = await makeTempDir('dsh-release-e2e-remote-')
  await git(remoteRoot, ['init', '--bare', '-q'])
  await git(root, ['remote', 'add', 'origin', remoteRoot])
  await git(root, ['push', '-q', 'origin', 'HEAD'])

  const fakeNpm = await writeExecutable(binRoot, 'fake-npm', `
    const fs = require('node:fs')
    const path = require('node:path')
    const args = process.argv.slice(2)
    const stateFile = process.env.FAKE_STATE
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const writeState = value => fs.writeFileSync(stateFile, JSON.stringify(value, null, 2))

    if (args[0] === 'config') {
      process.stdout.write(${JSON.stringify(official)} + '\\n')
      process.exit(0)
    }
    if (args[0] === 'pack') {
      process.stdout.write(JSON.stringify([{ files: ${JSON.stringify(packFiles)}.map(path => ({ path })) }]))
      process.exit(0)
    }
    if (args[0] === 'whoami') {
      process.stdout.write('tester\\n')
      process.exit(0)
    }
    if (args[0] === 'view') {
      const state = readState()
      const spec = args[1]
      const field = args[2]
      if (field === 'time') {
        const times = {}
        for (const [key, value] of Object.entries(state)) {
          if (key.startsWith(spec + '@')) times[key.slice(spec.length + 1)] = value.publishedAt
        }
        process.stdout.write(JSON.stringify(times))
        process.exit(0)
      }
      if (state[spec] === undefined) {
        process.stderr.write('npm error code E404\\n')
        process.exit(1)
      }
      process.stdout.write(JSON.stringify({ version: state[spec].version, gitHead: state[spec].gitHead ?? null }) + '\\n')
      process.exit(0)
    }
    if (args[0] === 'publish') {
      const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
      if (manifest.name === process.env.FAKE_FAIL_NAME) {
        process.stderr.write('npm error publish failed\\n')
        process.exit(1)
      }
      const state = readState()
      state[manifest.name + '@' + manifest.version] = {
        version: manifest.version,
        publishedAt: new Date().toISOString(),
      }
      writeState(state)
      process.stdout.write(JSON.stringify({ integrity: 'sha512-e2e', name: manifest.name, version: manifest.version }))
      process.exit(0)
    }
    process.stderr.write('unexpected npm call: ' + args.join(' ') + '\\n')
    process.exit(2)
  `)

  return {
    root,
    fakeNpm,
    remoteRoot,
    env: { FAKE_STATE: stateFile, FAKE_FAIL_NAME: failName },
  }
}

test('假 npm 端到端：多包发布成功', async () => {
  const data = await makeRepo(['alpha', 'beta'])
  const target = createNpmTarget({
    npmBin: data.fakeNpm,
    repoRoot: data.root,
    cacheDir: join(data.root, 'cache'),
    env: data.env,
  })
  const io = makeIo()
  const code = await runPublish({
    repoRoot: data.root,
    npmBin: data.fakeNpm,
    pnpmBin: data.fakeNpm,
    env: data.env,
    targetAdapter: target,
    skipChecks: true,
    yes: true,
    reportDir: join(data.root, 'report'),
    io,
  })
  assert.equal(code, 0)
  const report = JSON.parse(await readFile(join(data.root, 'report', 'report.json'), 'utf8'))
  assert.deepEqual(report.results.map(result => result.status), ['published', 'published'])
  const state = JSON.parse(await readFile(join(data.root, 'published.json'), 'utf8'))
  assert.ok(state['@tjh/dsh-plugin-alpha@0.1.0'])
  assert.ok(state['@tjh/dsh-plugin-beta@0.1.0'])
  for (const short of ['alpha', 'beta']) {
    const tag = `@tjh/dsh-plugin-${short}@0.1.0`
    assert.ok(await localTagCommit(tag, { repoRoot: data.root }))
    assert.ok(await remoteTagCommit(tag, { repoRoot: data.root }))
  }
  assert.ok(report.results.every(result => result.tagPushed === true))
})

test('假 npm 端到端：第 2 个失败并生成回滚命令', async () => {
  const data = await makeRepo(['alpha', 'beta', 'gamma'], '@tjh/dsh-plugin-beta')
  const target = createNpmTarget({
    npmBin: data.fakeNpm,
    repoRoot: data.root,
    cacheDir: join(data.root, 'cache'),
    env: data.env,
  })
  const io = makeIo()
  const code = await runPublish({
    repoRoot: data.root,
    npmBin: data.fakeNpm,
    pnpmBin: data.fakeNpm,
    env: data.env,
    targetAdapter: target,
    skipChecks: true,
    yes: true,
    reportDir: join(data.root, 'report'),
    io,
  })
  assert.equal(code, 1)
  const report = JSON.parse(await readFile(join(data.root, 'report', 'report.json'), 'utf8'))
  assert.deepEqual(report.results.map(result => result.status), [
    'published',
    'failed',
    'not-attempted',
  ])
  assert.match(report.rollback.commands[0], /npm unpublish '@tjh\/dsh-plugin-alpha@0\.1\.0'/)
  assert.ok(report.rollback.commands.some(command => command.includes('git tag -d')))
})
