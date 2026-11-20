import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { assertPackContents, packDryRun } from '../pack.mjs'
import { discoverPackages } from '../packages.mjs'
import { makeTempDir, writeFiles, writeJson, writeExecutable } from '../test-support/helpers.mjs'

test('相对导入缺失时失败', async () => {
  const root = await makeTempDir()
  await writeFiles(root, {
    'index.js': "import { x } from './missing.js'\nexport { x }\n",
  })
  const pkg = { name: '@tjhaaa/dsh-plugin-alpha', dir: root, manifest: { exports: { '.': './index.js' } } }
  await assert.rejects(
    () => assertPackContents(pkg, ['index.js']),
    /index\.js 引用的 \.\/missing\.js 不在 tarball 内/,
  )
})

test('相对导入闭包完整时通过', async () => {
  const root = await makeTempDir()
  await writeFiles(root, {
    'index.js': "import { x } from './dep.js'\nexport { x }\n",
    'dep.js': 'export const x = 1\n',
  })
  const pkg = { name: '@tjhaaa/dsh-plugin-alpha', dir: root, manifest: { exports: { '.': './index.js' } } }
  await assertPackContents(pkg, ['index.js', 'dep.js'])
})

test('exports 与 bundle patch 必须在 tarball 内', async () => {
  const root = await makeTempDir()
  await writeFiles(root, { 'index.js': 'export {}\n' })
  const pkg = {
    name: '@tjhaaa/dsh-plugin-alpha',
    dir: root,
    manifest: {
      exports: { '.': './index.js', './icon': './icon.svg' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
  }
  await assert.rejects(
    () => assertPackContents(pkg, ['index.js']),
    error => {
      assert.match(error.message, /exports 目标不在 tarball 内：\.\/icon\.svg/)
      assert.match(error.message, /bundle patch 不在 tarball 内/)
      return true
    },
  )
})

test('packDryRun 解析假 npm 的 JSON 输出', async () => {
  const root = await makeTempDir()
  await writeJson(join(root, 'package.json'), { name: '@tjhaaa/dsh-plugin-alpha', version: '1.0.0' })
  const fakeNpm = await writeExecutable(root, 'fake-npm', `
    process.stdout.write(JSON.stringify([{ files: [{ path: 'index.js' }, { path: 'today.js' }] }]))
  `)
  const files = await packDryRun(
    { name: '@tjhaaa/dsh-plugin-alpha', dir: root },
    { npmBin: fakeNpm, cacheDir: join(root, 'cache') },
  )
  assert.deepEqual(files, ['index.js', 'today.js'])
})

test('真实 useage 包的 tarball 含 today.js 且导入闭包通过', async () => {
  const packages = await discoverPackages()
  const pkg = packages.find(item => item.name === '@tjhaaa/dsh-plugin-useage')
  assert.ok(pkg, '缺少 useage 包')
  const files = await packDryRun(pkg, { cacheDir: join(process.cwd(), '.tmp/release/npm-cache') })
  assert.ok(files.includes('today.js'))
  await assertPackContents(pkg, files)
})
