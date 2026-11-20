import assert from 'node:assert/strict'
import test from 'node:test'
import { createNpmTarget } from '../targets/npm.mjs'
import { getTarget, targetIds } from '../targets/index.mjs'

const publishedAt = '2026-11-20T00:00:00.000Z'
const now = Date.parse('2026-11-20T01:00:00.000Z')
const registry = 'https://registry.npmjs.org/'
const cacheDir = '/repo/.tmp/release/npm-cache'

function fakeTarget(handler, options = {}) {
  const calls = []
  const target = createNpmTarget({
    npmBin: 'fake-npm',
    registry,
    cacheDir,
    repoRoot: '/repo',
    now: () => now,
    sleep: async () => {},
    exec: async (command, args, opts) => {
      calls.push({ command, args, opts })
      return handler(args, opts)
    },
    ...options,
  })
  return { target, calls }
}

test('getTarget 默认 npm，未知目标列出可用值', () => {
  assert.equal(getTarget().id, 'npm')
  assert.deepEqual(targetIds, ['npm'])
  assert.throws(() => getTarget('market'), /未知发布目标：market；可用目标：npm/)
})

test('checkAuth 成功与失败', async () => {
  const ok = fakeTarget(() => ({ code: 0, stdout: 'alice\n', stderr: '' }))
  assert.deepEqual(await ok.target.checkAuth(), { user: 'alice' })

  const bad = fakeTarget(() => ({ code: 1, stdout: '', stderr: 'E401 Unauthorized' }))
  await assert.rejects(() => bad.target.checkAuth(), /npm 认证失败[\s\S]*npm login/)
})

test('inspectVersion 把 E404 映射为 absent，参数含 registry 与 cache', async () => {
  const { target, calls } = fakeTarget(() => ({
    code: 1,
    stdout: '',
    stderr: 'npm error code E404',
  }))
  assert.deepEqual(await target.inspectVersion({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0' }), {
    state: 'absent',
  })
  assert.ok(calls[0].args.includes('--registry'))
  assert.ok(calls[0].args.includes(registry))
  assert.ok(calls[0].args.includes('--cache'))
  assert.ok(calls[0].args.includes(cacheDir))
})

test('inspectVersion 返回已发布版本与发布时间', async () => {
  const { target } = fakeTarget(args => {
    if (args.includes('time')) {
      return { code: 0, stdout: JSON.stringify({ '1.0.0': publishedAt }), stderr: '' }
    }
    return { code: 0, stdout: JSON.stringify({ version: '1.0.0', gitHead: 'abc123' }), stderr: '' }
  })
  assert.deepEqual(await target.inspectVersion({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0' }), {
    state: 'published',
    publishedAt,
    gitHead: 'abc123',
  })
})

test('publish 解析 integrity 并传 access public', async () => {
  const { target, calls } = fakeTarget(() => ({
    code: 0,
    stdout: JSON.stringify({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0', integrity: 'sha512-abc' }),
    stderr: '',
  }))
  const result = await target.publish({
    name: '@tjh/dsh-plugin-alpha',
    version: '1.0.0',
    dir: '/repo/plugins/alpha',
  })
  assert.equal(result.integrity, 'sha512-abc')
  assert.match(result.url, /@tjh\/dsh-plugin-alpha\/v\/1\.0\.0/)
  assert.ok(calls[0].args.includes('--access'))
  assert.ok(calls[0].args.includes('public'))
  assert.ok(calls[0].args.includes('--registry'))
})

test('withdrawPlan 在 72 小时内给出 unpublish，超出窗口给出 deprecate', async () => {
  const inWindow = fakeTarget(args => {
    if (args.includes('time')) {
      return { code: 0, stdout: JSON.stringify({ '1.0.0': publishedAt }), stderr: '' }
    }
    return { code: 0, stdout: JSON.stringify({ version: '1.0.0', gitHead: null }), stderr: '' }
  })
  const plan = await inWindow.target.withdrawPlan({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0' })
  assert.equal(plan.executable, true)
  assert.match(plan.commands[0], /npm unpublish '@tjh\/dsh-plugin-alpha@1\.0\.0' --force/)

  const oldTime = '2026-11-01T00:00:00.000Z'
  const outOfWindow = fakeTarget(args => {
    if (args.includes('time')) {
      return { code: 0, stdout: JSON.stringify({ '1.0.0': oldTime }), stderr: '' }
    }
    return { code: 0, stdout: JSON.stringify({ version: '1.0.0', gitHead: null }), stderr: '' }
  })
  const oldPlan = await outOfWindow.target.withdrawPlan({
    name: '@tjh/dsh-plugin-alpha',
    version: '1.0.0',
  })
  assert.equal(oldPlan.executable, false)
  assert.match(oldPlan.commands[0], /npm deprecate '@tjh\/dsh-plugin-alpha@1\.0\.0'/)
})

test('withdraw 只执行一次 unpublish', async () => {
  const calls = []
  const { target } = fakeTarget(args => {
    calls.push(args)
    if (args.includes('time')) {
      return { code: 0, stdout: JSON.stringify({ '1.0.0': publishedAt }), stderr: '' }
    }
    if (args[0] === 'unpublish') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: JSON.stringify({ version: '1.0.0', gitHead: null }), stderr: '' }
  })
  await target.withdraw({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0' })
  assert.equal(calls.filter(args => args[0] === 'unpublish').length, 1)
})

test('inspectVersion 在没有 gitHead 时返回 null', async () => {
  const { target } = fakeTarget(args => {
    if (args.includes('time')) return { code: 0, stdout: '{}', stderr: '' }
    return { code: 0, stdout: JSON.stringify({ version: '1.0.0' }), stderr: '' }
  })
  const state = await target.inspectVersion({ name: '@tjh/dsh-plugin-alpha', version: '1.0.0' })
  assert.equal(state.state, 'published')
  assert.equal(state.gitHead, null)
})

