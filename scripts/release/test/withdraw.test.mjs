import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { parseSpec, runWithdraw } from '../withdraw.mjs'
import { makeIo, makeTempDir, writeJson } from '../test-support/helpers.mjs'

const official = 'https://registry.npmjs.org/'

async function makeRepo() {
  const root = await makeTempDir()
  await writeJson(join(root, 'plugins', 'alpha', 'package.json'), {
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '1.0.0',
  })
  return root
}

async function fixture(overrides = {}) {
  const root = await makeRepo()
  const calls = { withdraw: 0 }
  const states = [overrides.initial ?? { state: 'published', publishedAt: '2026-11-20T00:00:00.000Z' }]
  const target = {
    id: 'npm',
    registry: official,
    async inspectVersion() {
      return states.length > 1 ? states.shift() : states[0]
    },
    async withdrawPlan() {
      return overrides.plan ?? {
        executable: true,
        commands: ["npm unpublish '@tjhaaa/dsh-plugin-alpha@1.0.0' --force"],
        note: '可撤回',
      }
    },
    async distTags() { return { latest: '1.0.0' } },
    async withdraw() { calls.withdraw += 1 },
  }
  return { root, target, calls, states }
}

const options = (data, io, extra = {}) => ({
  repoRoot: data.root,
  targetAdapter: data.target,
  spec: '@tjhaaa/dsh-plugin-alpha@1.0.0',
  io,
  sleepFn: async () => {},
  tagOps: {
    deleteLocal: async () => true,
    deleteRemote: async () => true,
  },
  ...extra,
})

test('parseSpec 支持 scoped 与普通包名', () => {
  assert.deepEqual(parseSpec('@tjhaaa/dsh-plugin-alpha@1.0.0'), {
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '1.0.0',
  })
  assert.deepEqual(parseSpec('plain@2.0.0'), { name: 'plain', version: '2.0.0' })
  assert.throws(() => parseSpec('@tjhaaa/dsh-plugin-alpha'), /格式应为/)
})

test('非本仓库包被拒绝', async () => {
  const data = await fixture()
  const io = makeIo()
  await assert.rejects(
    () => runWithdraw(options(data, io, { spec: '@tjhaaa/dsh-plugin-other@1.0.0' })),
    /目标不属于当前仓库/,
  )
})

test('未发布版本被拒绝', async () => {
  const data = await fixture({ initial: { state: 'absent' } })
  const io = makeIo()
  await assert.rejects(
    () => runWithdraw(options(data, io)),
    /未发布，无需撤回/,
  )
})

test('超出 72 小时只输出 deprecate，不执行撤回', async () => {
  const data = await fixture({
    plan: {
      executable: false,
      commands: ["npm deprecate '@tjhaaa/dsh-plugin-alpha@1.0.0' 'withdrawn'"],
      note: '超过窗口',
    },
  })
  const io = makeIo()
  const code = await runWithdraw(options(data, io, { yes: true }))
  assert.equal(code, 1)
  assert.equal(data.calls.withdraw, 0)
  assert.match(io.errors.join('\n'), /超过窗口/)
})

test('非 TTY 缺少 --yes 时终止', async () => {
  const data = await fixture()
  const io = makeIo({ isTTY: false })
  await assert.rejects(() => runWithdraw(options(data, io)), /非交互环境需要 --yes/)
  assert.equal(data.calls.withdraw, 0)
})

test('确认输入不匹配时取消', async () => {
  const data = await fixture()
  const io = makeIo({ isTTY: true, answers: ['wrong'] })
  await assert.rejects(() => runWithdraw(options(data, io)), /已取消撤回/)
  assert.equal(data.calls.withdraw, 0)
})

test('确认后撤回并轮询确认消失', async () => {
  const data = await fixture()
  data.states.push({ state: 'absent' })
  const io = makeIo({ isTTY: true, answers: ['@tjhaaa/dsh-plugin-alpha@1.0.0'] })
  const code = await runWithdraw(options(data, io))
  assert.equal(code, 0)
  assert.equal(data.calls.withdraw, 1)
  assert.match(io.logs.join('\n'), /不再可查询/)
})

test('撤回后仍可查询时报错', async () => {
  const data = await fixture()
  data.states[0] = { state: 'published', publishedAt: '2026-11-20T00:00:00.000Z' }
  const io = makeIo({ isTTY: true, answers: ['@tjhaaa/dsh-plugin-alpha@1.0.0'] })
  await assert.rejects(() => runWithdraw(options(data, io)), /仍可查询/)
  assert.equal(data.calls.withdraw, 1)
})

test('撤回成功后 tag 不存在时跳过删除', async () => {
  const data = await fixture()
  data.states.push({ state: 'absent' })
  const io = makeIo({ isTTY: true, answers: ['@tjhaaa/dsh-plugin-alpha@1.0.0'] })
  const code = await runWithdraw(options(data, io, {
    tagOps: {
      deleteLocal: async () => false,
      deleteRemote: async () => false,
    },
  }))
  assert.equal(code, 0)
  assert.match(io.logs.join('\n'), /本地不存在/)
})

test('撤回成功后 tag 删除失败时报错', async () => {
  const data = await fixture()
  data.states.push({ state: 'absent' })
  const io = makeIo({ isTTY: true, answers: ['@tjhaaa/dsh-plugin-alpha@1.0.0'] })
  await assert.rejects(
    () => runWithdraw(options(data, io, {
      tagOps: {
        deleteLocal: async () => true,
        deleteRemote: async () => { throw new Error('push failed') },
      },
    })),
    /tag 删除失败/,
  )
})
