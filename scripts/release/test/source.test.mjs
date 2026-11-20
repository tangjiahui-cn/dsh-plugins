import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { assertOfficialSource, parseNpmrc } from '../source.mjs'
import { makeTempDir, writeExecutable } from '../test-support/helpers.mjs'
import { writeFile } from 'node:fs/promises'

const official = 'https://registry.npmjs.org/'

async function fixture({ npmrc, lockfile = 'lockfileVersion: 9.0\n', registry = official } = {}) {
  const root = await makeTempDir()
  await writeFile(join(root, '.npmrc'), npmrc ?? `registry=${official}\n@tjh:registry=${official}\n`)
  await writeFile(join(root, 'pnpm-lock.yaml'), lockfile)
  const fake = await writeExecutable(root, 'fake-bin', `
    process.stdout.write((process.env.FAKE_REGISTRY || ${JSON.stringify(registry)}) + '\\n')
  `)
  return { root, fake }
}

function options({ root, fake }, env = {}) {
  return {
    repoRoot: root,
    npmrcPath: join(root, '.npmrc'),
    lockfilePath: join(root, 'pnpm-lock.yaml'),
    npmBin: fake,
    pnpmBin: fake,
    env: { FAKE_REGISTRY: official, ...env },
  }
}

test('parseNpmrc 忽略注释与空行', () => {
  const values = parseNpmrc('# comment\nregistry = https://registry.npmjs.org/\n')
  assert.equal(values.get('registry'), official)
})

test('官方源配置通过', async () => {
  const data = await fixture()
  await assertOfficialSource(options(data))
})

test('.npmrc 缺失时失败', async () => {
  const data = await fixture()
  await assert.rejects(
    () => assertOfficialSource({ ...options(data), npmrcPath: join(data.root, 'missing') }),
    /无法读取/,
  )
})

test('.npmrc registry 不是官方源时失败', async () => {
  const data = await fixture({ npmrc: `registry=https://registry.example.test/\n@tjh:registry=${official}\n` })
  await assert.rejects(() => assertOfficialSource(options(data)), /\.npmrc 的 registry/)
})

test('.npmrc 缺少 @tjh scope 时失败', async () => {
  const data = await fixture({ npmrc: `registry=${official}\n` })
  await assert.rejects(() => assertOfficialSource(options(data)), /@tjh:registry/)
})

test('.npmrc 含凭据时失败', async () => {
  const data = await fixture({
    npmrc: `registry=${official}\n@tjh:registry=${official}\n//registry.npmjs.org/:_authToken=secret\n`,
  })
  await assert.rejects(() => assertOfficialSource(options(data)), /不能包含认证凭据/)
})

test('生效 registry 被环境覆盖时失败', async () => {
  const data = await fixture()
  await assert.rejects(
    () => assertOfficialSource(options(data, { FAKE_REGISTRY: 'https://registry.example.test/' })),
    /npm 生效 registry 不是官方源/,
  )
})

test('锁文件含非官方 tarball 时失败', async () => {
  const data = await fixture({
    lockfile: "packages:\n  a:\n    resolution: {tarball: https://registry.example.test/a.tgz}\n",
  })
  await assert.rejects(() => assertOfficialSource(options(data)), /非官方 tarball 地址/)
})
