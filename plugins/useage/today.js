/**
 * 本机今日消耗：枚举今天有写动的会话日志，折叠 provider usage，
 * 按模型和峰谷价换算金额。仅本地口径，不含网页端与其他设备。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_PRICES } from './projection.js'

/** 峰段（北京时间）：工作日 09:00–12:00、14:00–18:00，其余时段半价。 */
const PEAK_WINDOWS = [[9, 12], [14, 18]]

const formatterCache = new Map()
const zoneFormatter = timeZone => {
  let found = formatterCache.get(timeZone)
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    })
    formatterCache.set(timeZone, found)
  }
  return found
}

const zoneParts = (time, timeZone) => {
  const parts = {}
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(time))) {
    parts[part.type] = part.value
  }
  return parts
}

/**
 * 某时刻在给定时区的当天起点（epoch 毫秒）。
 * @param {number} time 参照时刻。
 * @param {string} timeZone IANA 时区。
 * @returns {number} 当天 00:00 的 epoch 毫秒。
 */
export function dayStart(time, timeZone) {
  const parts = zoneParts(time, timeZone)
  const midnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  const offset = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  ) - time
  return midnightUtc - offset
}

/**
 * 某时刻是否落在北京时间峰段。
 * @param {number} time epoch 毫秒。
 * @returns {boolean} 峰段为 true。
 */
export function isPeak(time) {
  const parts = zoneParts(time, 'Asia/Shanghai')
  const weekday = parts.weekday
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(parts.hour)
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

const emptyBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const usageOf = event => {
  const data = event.data ?? {}
  if (data.usage !== undefined) return data.usage
  if (!Array.isArray(data.stream)) return undefined
  for (let index = data.stream.length - 1; index >= 0; index -= 1) {
    const record = data.stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * 折叠一个会话的事件：按 step 替换语义累加 usage，只取当天区间。
 * @param {readonly object[]} events 会话事件。
 * @param {number} start 当天起点。
 * @param {number} end 次日起点。
 * @returns {{ byModel: Record<string, object>, missing: number }} 结果与缺失计数。
 */
export function foldSession(events, start, end) {
  let route = null
  let last = null
  const byModel = {}
  let missing = 0
  for (const event of events) {
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
        route = { provider: config.provider, model: config.model }
      }
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOf(event)
    if (usage === undefined) { missing += 1; continue }
    const turn = event.data?.turn
    const step = event.data?.step
    if (typeof turn !== 'number' || typeof step !== 'number') continue
    const modelKey = route === null ? 'unknown' : `${route.provider}/${route.model}`
    const tokens = {
      input: Number(usage.inputTokens ?? 0),
      output: Number(usage.outputTokens ?? 0),
      cacheRead: Number(usage.cacheReadTokens ?? 0),
      cacheWrite: Number(usage.cacheWriteTokens ?? 0),
    }
    const inRange = event.time >= start && event.time < end
    if (!inRange) { last = null; continue }
    const part = isPeak(event.time) ? 'peak' : 'off'
    if (last !== null && last.turn === turn && last.step === step) {
      subtract(byModel, last.modelKey, last.part, last.tokens)
    }
    add(byModel, modelKey, part, tokens)
    last = { turn, step, modelKey, part, tokens }
  }
  return { byModel, missing }
}

const slot = (byModel, modelKey, part) => {
  const entry = byModel[modelKey] ?? { peak: emptyBuckets(), off: emptyBuckets() }
  byModel[modelKey] = entry
  return entry[part]
}

const add = (byModel, modelKey, part, tokens) => {
  const bucket = slot(byModel, modelKey, part)
  bucket.input += tokens.input
  bucket.output += tokens.output
  bucket.cacheRead += tokens.cacheRead
  bucket.cacheWrite += tokens.cacheWrite
}

const subtract = (byModel, modelKey, part, tokens) => {
  const bucket = slot(byModel, modelKey, part)
  bucket.input -= tokens.input
  bucket.output -= tokens.output
  bucket.cacheRead -= tokens.cacheRead
  bucket.cacheWrite -= tokens.cacheWrite
}

const priceOf = (prices, modelKey) => {
  const direct = prices[modelKey]
  if (direct !== undefined) return direct
  const model = modelKey.split('/').slice(1).join('/')
  return prices[model] ?? DEFAULT_PRICES[model]
}

/**
 * 把聚合结果换算成金额与总量。
 * @param {Record<string, object>} byModel 各模型 token。
 * @param {object} prices 单价表，每百万 token。
 * @returns {{ amount: number, tokens: object, unpriced: string[] }} 金额（元）与合计。
 */
export function price(byModel, prices) {
  let micro = 0
  const unpriced = []
  const total = emptyBuckets()
  for (const [modelKey, parts] of Object.entries(byModel)) {
    for (const bucket of [parts.peak, parts.off]) {
      total.input += bucket.input
      total.output += bucket.output
      total.cacheRead += bucket.cacheRead
      total.cacheWrite += bucket.cacheWrite
    }
    const price = priceOf(prices, modelKey)
    if (price === undefined) { unpriced.push(modelKey); continue }
    for (const [part, factor] of [['peak', 1], ['off', 0.5]]) {
      const bucket = parts[part]
      micro += factor * (bucket.input * Number(price.input ?? 0)
        + bucket.output * Number(price.output ?? 0)
        + bucket.cacheRead * Number(price.cacheRead ?? price.input ?? 0)
        + bucket.cacheWrite * Number(price.cacheWrite ?? price.input ?? 0))
    }
  }
  return {
    amount: Math.round(micro) / 1e6,
    tokens: { ...total, total: total.input + total.output },
    unpriced,
  }
}

/**
 * 列出今天有写动的会话 id。
 * @param {string} home DSH 主目录。
 * @param {number} start 当天起点。
 * @returns {Promise<string[]>} 会话 id。
 */
export async function activeSessionIds(home, start) {
  const root = join(home, 'sessions')
  const ids = []
  let workspaces
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch { return ids }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const dir = join(root, workspace.name)
    let sessions
    try { sessions = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const target = join(dir, session.name)
      let newest = 0
      try {
        const entries = await readdir(target)
        for (const entry of entries) {
          if (!entry.startsWith('session.')) continue
          const info = await stat(join(target, entry))
          if (info.mtimeMs > newest) newest = info.mtimeMs
        }
      } catch { continue }
      if (newest >= start) ids.push(session.name)
    }
  }
  return ids
}

/**
 * 聚合本机今天的全部会话（含子会话）。
 * @param {object} options 依赖与配置。
 * @param {object} options.persistence 会话持久化服务。
 * @param {string} options.home DSH 主目录。
 * @param {string} options.timezone 日界时区。
 * @param {object} options.prices 单价表。
 * @param {number} [options.now] 参照时刻。
 * @returns {Promise<object>} 聚合结果。
 */
export async function collectToday({ persistence, home, timezone, prices, now = Date.now() }) {
  const start = dayStart(now, timezone)
  const end = start + 24 * 60 * 60 * 1000
  const ids = await activeSessionIds(home, start)
  const combined = {}
  let missing = 0
  let sessions = 0
  for (const id of ids) {
    let handle
    try {
      handle = await persistence.open(id, 'read')
      const { events } = await handle.read()
      const folded = foldSession(events, start, end)
      missing += folded.missing
      for (const [key, parts] of Object.entries(folded.byModel)) {
        for (const part of ['peak', 'off']) add(combined, key, part, parts[part])
      }
      sessions += 1
    } catch (error) {
      console.warn('[useage] session fold failed', { id, error: String(error?.message ?? error) })
    } finally {
      await handle?.close?.()
    }
  }
  const { amount, tokens, unpriced } = price(combined, prices)
  return {
    amount,
    tokens,
    unpriced,
    sessions,
    missing,
    timezone,
    fetchedAt: now,
  }
}
