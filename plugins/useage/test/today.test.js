import test from 'node:test'
import assert from 'node:assert/strict'

import { dayStart, foldSession, isPeak, price } from '../today.js'

const TZ = 'Asia/Shanghai'
const AT = Date.parse('2026-11-19T10:00:00+08:00') // 周四 10:00
const START = dayStart(AT, TZ)
const END = START + 24 * 60 * 60 * 1000

const header = (provider = 'deepseek-account', model = 'deepseek-flash') => ({
  type: 'request/header', seq: 0, time: AT,
  data: { header: { config: { provider, model } } },
})

const message = (usage, time = AT, overrides = {}) => ({
  type: 'assistant/message', seq: 1, time,
  data: { turn: 1, step: 1, usage, ...overrides },
})

test('dayStart 给出配置时区的当天零点', () => {
  assert.equal(new Date(START).toISOString(), '2026-11-18T16:00:00.000Z')
  assert.equal(END - START, 24 * 60 * 60 * 1000)
})

test('峰段判定按北京时间工作日', () => {
  assert.equal(isPeak(Date.parse('2026-11-19T10:00:00+08:00')), true)   // 周四上午
  assert.equal(isPeak(Date.parse('2026-11-19T15:00:00+08:00')), true)   // 周四下午
  assert.equal(isPeak(Date.parse('2026-11-19T08:00:00+08:00')), false)  // 早于 9 点
  assert.equal(isPeak(Date.parse('2026-11-21T10:00:00+08:00')), false)  // 周六
})

test('foldSession 只统计当天区间并保留模型', () => {
  const yesterday = AT - 24 * 60 * 60 * 1000
  const { byModel, missing } = foldSession([
    header(),
    message({ inputTokens: 100, outputTokens: 10 }, yesterday),
    message({ inputTokens: 160000, outputTokens: 2100, cacheReadTokens: 50 }, AT),
  ], START, END)
  assert.equal(missing, 0)
  assert.deepEqual(byModel['deepseek-account/deepseek-flash'].peak, {
    input: 160000, output: 2100, cacheRead: 50, cacheWrite: 0,
  })
  assert.deepEqual(byModel['deepseek-account/deepseek-flash'].off, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  })
})

test('foldSession 对同一步的重复结算按替换处理', () => {
  const { byModel } = foldSession([
    header(),
    message({ inputTokens: 100, outputTokens: 10 }),
    { ...message({ inputTokens: 1000, outputTokens: 100 }), seq: 2 },
  ], START, END)
  assert.deepEqual(byModel['deepseek-account/deepseek-flash'].peak, {
    input: 1000, output: 100, cacheRead: 0, cacheWrite: 0,
  })
})

test('谷段按半价计', () => {
  const morning = Date.parse('2026-11-19T08:00:00+08:00') // 早于峰段
  const { byModel } = foldSession([header(), message({ inputTokens: 1000, outputTokens: 100 }, morning)], START, END)
  assert.equal(byModel['deepseek-account/deepseek-flash'].off.input, 1000)
  assert.equal(byModel['deepseek-account/deepseek-flash'].peak.input, 0)
})

test('缺少 usage 的结算计入缺失计数', () => {
  const { missing } = foldSession([
    header(),
    message(undefined, AT, { usage: undefined }),
  ], START, END)
  assert.equal(missing, 1)
})

test('price 按内置单价换算元', () => {
  const buckets = { peak: { input: 160000, output: 2100, cacheRead: 0, cacheWrite: 0 },
    off: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const result = price({ 'deepseek-account/deepseek-flash': buckets }, {})
  assert.equal(result.amount, 0.3368) // 160000*2 + 2100*8 = 336800 micro
  assert.equal(result.tokens.total, 162100)
  assert.deepEqual(result.unpriced, [])
})
