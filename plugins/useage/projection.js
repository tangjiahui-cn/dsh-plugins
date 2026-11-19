/**
 * `conversationCost` 投影：从已提交的 provider usage 折叠出按日与累计的 token 桶，
 * 并按配置单价换算金额。金额在视图里按当前价格现算，因此改价不需要重放日志。
 */
import { z } from 'zod'

/** 默认配置：未配置价格时只展示 token。 */
export const DEFAULT_CONFIG = {
  currency: 'CNY',
  timezone: 'Asia/Shanghai',
  showBalance: true,
  prices: {},
}

/** 内置的 DeepSeek 官方标准价（每百万 token，CNY）；低峰价为标准价的一半。 */
export const DEFAULT_PRICES = {
  'deepseek-flash': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
  'deepseek-chat': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'deepseek-reasoner': { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 },
}

/** 状态里保留的天数窗口。 */
const DAY_WINDOW = 14

const emptyBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const bucketsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
}).strict()

const bucketNodeSchema = z.object({
  tokens: bucketsSchema,
  byModel: z.record(z.string(), bucketsSchema),
}).strict()

const tokensViewSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
}).strict()

const nodeViewSchema = z.object({
  cost: z.string().nullable(),
  unpriced: z.array(z.string()),
  tokens: tokensViewSchema,
}).strict()

const dayViewSchema = z.object({
  day: z.string(),
  cost: z.string().nullable(),
  unpriced: z.array(z.string()),
  tokens: tokensViewSchema,
}).strict()

const viewSchema = z.object({
  today: nodeViewSchema,
  total: nodeViewSchema,
  days: z.array(dayViewSchema).max(DAY_WINDOW),
  timezone: z.string(),
  currency: z.string(),
  costComplete: z.boolean(),
  usageMissingCount: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  total: bucketNodeSchema,
  days: z.record(z.string(), bucketNodeSchema),
  route: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    day: z.string(),
    modelKey: z.string(),
    tokens: bucketsSchema,
  }).strict().nullable(),
  usageMissing: z.number().int().nonnegative(),
  view: viewSchema,
}).strict()

const dayFormatters = new Map()

/**
 * 事件时间在配置时区下的自然日键。
 * @param {number} time Unix 毫秒。
 * @param {string} timeZone IANA 时区名。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dayKey(time, timeZone) {
  let formatter = dayFormatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      })
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      })
    }
    dayFormatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(time))
}

const emptyNode = () => ({ tokens: emptyBuckets(), byModel: {} })

/**
 * 把一次结算的 usage 加入或移出一个节点。
 * @param {object} node 目标节点。
 * @param {string} modelKey `provider/model`。
 * @param {object} tokens 四个桶。
 * @param {number} sign 1 加、-1 减。
 * @returns {object} 新节点。
 */
function bumpNode(node, modelKey, tokens, sign) {
  const byModel = { ...node.byModel }
  const previous = byModel[modelKey] ?? emptyBuckets()
  const next = {
    input: previous.input + sign * tokens.input,
    output: previous.output + sign * tokens.output,
    cacheRead: previous.cacheRead + sign * tokens.cacheRead,
    cacheWrite: previous.cacheWrite + sign * tokens.cacheWrite,
  }
  if (next.input === 0 && next.output === 0 && next.cacheRead === 0 && next.cacheWrite === 0) {
    delete byModel[modelKey]
  } else {
    byModel[modelKey] = next
  }
  return {
    tokens: {
      input: node.tokens.input + sign * tokens.input,
      output: node.tokens.output + sign * tokens.output,
      cacheRead: node.tokens.cacheRead + sign * tokens.cacheRead,
      cacheWrite: node.tokens.cacheWrite + sign * tokens.cacheWrite,
    },
    byModel,
  }
}

const priceOf = (prices, modelKey) => {
  const direct = prices[modelKey]
  if (direct !== undefined) return direct
  const model = modelKey.split('/').slice(1).join('/')
  return prices[model] ?? DEFAULT_PRICES[model]
}

/**
 * 一个节点在给定价格下的视图。
 * @param {object} node 节点。
 * @param {object} config 已解析配置。
 * @returns {object} 含金额字符串与未定价模型。
 */
export function nodeView(node, config) {
  let micro = 0
  const unpriced = []
  for (const [modelKey, bucket] of Object.entries(node.byModel)) {
    const price = priceOf(config.prices ?? {}, modelKey)
    if (price === undefined) {
      unpriced.push(modelKey)
      continue
    }
    micro += bucket.input * Number(price.input ?? 0)
      + bucket.output * Number(price.output ?? 0)
      + bucket.cacheRead * Number(price.cacheRead ?? price.input ?? 0)
      + bucket.cacheWrite * Number(price.cacheWrite ?? price.input ?? 0)
  }
  return {
    cost: unpriced.length > 0 ? null : (Math.round(micro) / 1e6).toFixed(2),
    unpriced,
    tokens: {
      ...node.tokens,
      total: node.tokens.input + node.tokens.output,
    },
  }
}

/**
 * 组装整个视图。
 * @param {object} facts 不含视图的状态。
 * @param {object} config 已解析配置。
 * @returns {object} 客户端视图。
 */
function buildView(facts, config) {
  const days = Object.entries(facts.days)
    .sort((left, right) => (left[0] < right[0] ? 1 : -1))
    .slice(0, DAY_WINDOW)
    .map(([day, node]) => ({ day, ...nodeView(node, config) }))
  const total = nodeView(facts.total, config)
  const todayEntry = days.find(entry => entry.day === dayKey(Date.now(), config.timezone))
  let today = nodeView(emptyNode(), config)
  if (todayEntry !== undefined) {
    const { day, ...rest } = todayEntry
    today = rest
  }
  return {
    today,
    total,
    days,
    timezone: config.timezone,
    currency: config.currency,
    costComplete: total.unpriced.length === 0,
    usageMissingCount: facts.usageMissing,
  }
}

const withView = (facts, config) => ({ ...facts, view: buildView(facts, config) })

/** 从一次结算里取 provider usage：优先埋点字段，其次流内最后一个 usage chunk。 */
function usageOf(event) {
  const data = event.data ?? {}
  if (data.usage !== undefined) return data.usage
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

const toBuckets = usage => ({
  input: Number(usage.inputTokens ?? 0),
  output: Number(usage.outputTokens ?? 0),
  cacheRead: Number(usage.cacheReadTokens ?? 0),
  cacheWrite: Number(usage.cacheWriteTokens ?? 0),
})

/**
 * 构造投影定义。
 * @param {object} config 插件配置。
 * @returns {object} `sessionProjections.register` 的定义。
 */
export function createConversationCostDefinition(config) {
  const resolved = { ...DEFAULT_CONFIG, ...config, prices: config?.prices ?? {} }

  return {
    key: 'conversationCost',
    stateVersion: 1,
    stateSchema,
    init: () => withView({
      total: emptyNode(),
      days: {},
      route: null,
      last: null,
      usageMissing: 0,
    }, resolved),
    apply: (state, event) => {
      if (event.type === 'request/header') {
        const calls = event.data?.header?.config
        const provider = calls?.provider
        const model = calls?.model
        if (typeof provider !== 'string' || typeof model !== 'string') return state
        if (state.route?.provider === provider && state.route.model === model) return state
        const { view, ...facts } = state
        return withView({ ...facts, route: { provider, model } }, resolved)
      }

      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        const usage = usageOf(event)
        const { view, ...facts } = state
        if (usage === undefined) {
          return withView({ ...facts, usageMissing: facts.usageMissing + 1, last: null }, resolved)
        }
        const turn = event.data?.turn
        const step = event.data?.step
        if (typeof turn !== 'number' || typeof step !== 'number') return state
        const tokens = toBuckets(usage)
        const day = dayKey(event.time, resolved.timezone)
        const modelKey = facts.route === null ? 'unknown' : `${facts.route.provider}/${facts.route.model}`

        let total = facts.total
        const days = { ...facts.days }
        const previous = facts.last
        if (previous !== null && previous.turn === turn && previous.step === step) {
          total = bumpNode(total, previous.modelKey, previous.tokens, -1)
          if (days[previous.day] !== undefined) {
            days[previous.day] = bumpNode(days[previous.day], previous.modelKey, previous.tokens, -1)
          }
        }

        total = bumpNode(total, modelKey, tokens, 1)
        days[day] = bumpNode(days[day] ?? emptyNode(), modelKey, tokens, 1)

        const kept = {}
        for (const key of Object.keys(days).sort().reverse().slice(0, DAY_WINDOW)) kept[key] = days[key]

        return withView({
          ...facts, total, days: kept, last: { turn, step, day, modelKey, tokens },
        }, resolved)
      }

      if (event.type === 'llm/retry-started') {
        if (state.last === null) return state
        if (state.last.turn !== event.data?.turn || state.last.step !== event.data?.step) return state
        const { view, ...facts } = state
        return withView({ ...facts, last: null }, resolved)
      }

      return state
    },
    wire: {
      viewSchema,
      view: state => state.view,
    },
  }
}
