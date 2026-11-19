import test from 'node:test'
import assert from 'node:assert/strict'

import { createConversationCostDefinition, dayKey } from '../projection.js'

const TZ = 'Asia/Shanghai'
const PRICES = {
  'deepseek/deepseek-v4-flash': { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 },
}
const AT = Date.parse('2026-11-19T10:00:00+08:00')

const config = () => ({ currency: 'CNY', timezone: TZ, showBalance: true, prices: PRICES })

const message = (usage, overrides = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time: AT,
  data: { turn: 1, step: 1, usage, ...overrides },
})

const header = (provider = 'deepseek', model = 'deepseek-v4-flash') => ({
  type: 'request/header',
  seq: 0,
  time: AT,
  data: { header: { config: { provider, model } } },
})

const usage = { inputTokens: 160000, outputTokens: 2100, cacheReadTokens: 0, cacheWriteTokens: 0 }

const run = (events) => {
  const definition = createConversationCostDefinition(config())
  return events.reduce((state, event) => definition.apply(state, event), definition.init())
}

test('无关事件返回同一引用', () => {
  const definition = createConversationCostDefinition(config())
  const state = definition.init()
  const next = definition.apply(state, { type: 'turn/start', seq: 1, time: AT, data: { turn: 1 } })
  assert.equal(next, state)
})

test('折叠 usage 到当日与累计桶', () => {
  const state = run([header(), message(usage)])
  const day = dayKey(AT, TZ)
  assert.deepEqual(state.days[day].tokens, { input: 160000, output: 2100, cacheRead: 0, cacheWrite: 0 })
  assert.equal(state.total.tokens.input, 160000)
  assert.equal(state.view.days[0].day, day)
  assert.equal(state.view.days[0].tokens.total, 162100)
})

test('重试后同一 step 只计一次并追加新尝试', () => {
  const first = run([header(), message(usage)])
  const retried = createConversationCostDefinition(config())
  const retryEvent = { type: 'llm/retry-started', seq: 2, time: AT, data: { turn: 1, step: 1 } }
  const second = { ...message({ inputTokens: 120000, outputTokens: 1000 }), seq: 3 }
  const state = [header(), message(usage), retryEvent, second]
    .reduce((acc, event) => retried.apply(acc, event), retried.init())
  assert.equal(state.total.tokens.input, 160000 + 120000)
  assert.equal(state.total.tokens.output, 2100 + 1000)
})

test('同一步的重复结算按替换处理', () => {
  const replaced = { ...message({ inputTokens: 100000, outputTokens: 500 }), seq: 2 }
  const state = run([header(), message(usage), replaced])
  assert.equal(state.total.tokens.input, 100000)
  assert.equal(state.total.tokens.output, 500)
})

test('价格命中时给出金额，未命中时置 null', () => {
  const priced = run([header(), message(usage)])
  assert.equal(priced.view.total.cost, '0.18')
  assert.equal(priced.view.costComplete, true)

  const unpriced = run([header('deepseek', 'unknown-model'), message(usage)])
  assert.equal(unpriced.view.total.cost, null)
  assert.equal(unpriced.view.costComplete, false)
  assert.deepEqual(unpriced.view.total.unpriced, ['deepseek/unknown-model'])
})

test('未配置单价时回落到内置 DeepSeek 价格', () => {
  const definition = createConversationCostDefinition({ ...config(), prices: {} })
  const state = [header('deepseek-account', 'deepseek-flash'), message(usage)]
    .reduce((acc, event) => definition.apply(acc, event), definition.init())
  // deepseek-flash: 输入 2 / 输出 8（每百万 token）
  assert.equal(state.view.total.cost, '0.34')
  assert.equal(state.view.costComplete, true)
})

test('wire 视图通过自身 schema', () => {
  const definition = createConversationCostDefinition(config())
  const state = [header(), message(usage)].reduce((acc, event) => definition.apply(acc, event), definition.init())
  const view = definition.wire.view(state)
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(view))
  assert.doesNotThrow(() => definition.stateSchema.parse(state))
  assert.equal(view.currency, 'CNY')
  assert.equal(view.timezone, TZ)
})

test('缺少 usage 的结算计入缺失计数', () => {
  const state = run([header(), message(undefined, { usage: undefined })])
  assert.equal(state.view.usageMissingCount, 1)
  assert.equal(state.total.tokens.input, 0)
})
