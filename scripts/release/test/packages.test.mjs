import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import {
  discoverPackages,
  selectPackages,
  sortByDependencies,
  validateManifest,
} from '../packages.mjs'
import { makePackage, makeTempDir, validManifest, writeFiles } from '../test-support/helpers.mjs'

async function packageFrom(root, name, manifest, files) {
  const dir = join(root, name.replace('@tjhaaa/dsh-plugin-', ''))
  await makePackage(dir, manifest, files)
  return dir
}

test('发现匹配前缀的子包并按名称排序', async () => {
  const root = await makeTempDir()
  await packageFrom(root, '@tjhaaa/dsh-plugin-beta', validManifest('@tjhaaa/dsh-plugin-beta'))
  await packageFrom(root, '@tjhaaa/dsh-plugin-alpha', validManifest('@tjhaaa/dsh-plugin-alpha'))
  await writeFiles(join(root, 'not-a-plugin'), { 'package.json': '{}\n' })
  await writeFiles(join(root, 'unrelated'), {
    'package.json': JSON.stringify({ name: 'other-pkg', version: '1.0.0' }),
  })

  const packages = await discoverPackages(root)
  assert.deepEqual(packages.map(pkg => pkg.name), [
    '@tjhaaa/dsh-plugin-alpha',
    '@tjhaaa/dsh-plugin-beta',
  ])
})

test('选择包：未指定时全选，未知包名列出可用包', async () => {
  const packages = [
    { name: '@tjhaaa/dsh-plugin-alpha' },
    { name: '@tjhaaa/dsh-plugin-beta' },
  ]
  assert.deepEqual(selectPackages(packages, []), packages)
  assert.deepEqual(selectPackages(packages, ['@tjhaaa/dsh-plugin-beta']), [packages[1]])
  assert.throws(
    () => selectPackages(packages, ['@tjhaaa/dsh-plugin-missing']),
    /未知包.*@tjhaaa\/dsh-plugin-missing.*@tjhaaa\/dsh-plugin-alpha/,
  )
})

test('拓扑排序把本地依赖排在前面', async () => {
  const packages = [
    { name: '@tjhaaa/dsh-plugin-a', manifest: { dependencies: { '@tjhaaa/dsh-plugin-b': '^1.0.0' } } },
    { name: '@tjhaaa/dsh-plugin-b', manifest: { dependencies: { '@tjhaaa/dsh-plugin-c': '^1.0.0' } } },
    { name: '@tjhaaa/dsh-plugin-c', manifest: {} },
  ]
  assert.deepEqual(sortByDependencies(packages).map(pkg => pkg.name), [
    '@tjhaaa/dsh-plugin-c',
    '@tjhaaa/dsh-plugin-b',
    '@tjhaaa/dsh-plugin-a',
  ])
})

test('拓扑排序检测依赖环', () => {
  const packages = [
    { name: '@tjhaaa/dsh-plugin-a', manifest: { dependencies: { '@tjhaaa/dsh-plugin-b': '^1.0.0' } } },
    { name: '@tjhaaa/dsh-plugin-b', manifest: { dependencies: { '@tjhaaa/dsh-plugin-a': '^1.0.0' } } },
  ]
  assert.throws(() => sortByDependencies(packages), /依赖存在环.*@tjhaaa\/dsh-plugin-a/)
})

test('合法清单通过校验', async () => {
  const root = await makeTempDir()
  const dir = join(root, 'alpha')
  await makePackage(dir)
  const pkg = {
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '1.2.3',
    dir,
    manifest: validManifest(),
  }
  assert.deepEqual(await validateManifest(pkg), [])
})

test('清单校验逐项报告字段与包名', async () => {
  const root = await makeTempDir()
  const dir = join(root, 'alpha')
  await makePackage(dir)
  const base = validManifest()
  const cases = [
    [{ private: true }, 'private'],
    [{ version: 'not-semver' }, 'version'],
    [{ files: [] }, 'files'],
    [{ license: undefined }, 'license'],
    [{ repository: undefined }, 'repository'],
    [{ publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org/' } }, 'publishConfig.access'],
    [{ publishConfig: { access: 'public', registry: 'https://example.test/' } }, 'publishConfig.registry'],
    [{ dsh: { bundle: { patch: './missing.yml' } } }, 'dsh.bundle.patch'],
    [{ exports: { '.': './missing.js' } }, 'exports'],
  ]
  for (const [patch, field] of cases) {
    const manifest = { ...base, ...patch }
    const pkg = { name: manifest.name, version: manifest.version, dir, manifest }
    const errors = await validateManifest(pkg)
    assert.ok(
      errors.some(error => error.includes('@tjhaaa/dsh-plugin-alpha') && error.includes(field)),
      `期望 ${field} 出现在错误中，实际：${errors.join(' | ')}`,
    )
  }
})

test('缺少 LICENSE 文件被判失败', async () => {
  const root = await makeTempDir()
  const dir = join(root, 'alpha')
  await makePackage(dir, validManifest(), { LICENSE: '' })
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, 'LICENSE'))
  const errors = await validateManifest({
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '1.2.3',
    dir,
    manifest: validManifest(),
  })
  assert.ok(errors.some(error => error.includes('LICENSE')))
})
