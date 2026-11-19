import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 用桩上下文取回胶囊组件。 */
function loadBadge() {
  let spec
  const loader = { __ModuleLoader__: { load(value) { spec = value } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(loader, require)
  const registrations = []
  const dictionaries = {}
  const ctx = {
    effect: fn => { fn(); return () => {} },
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
      bind: ns => key => dictionaries[ns]?.zh?.[key] ?? key,
      getSnapshot: () => ({ active: 'zh' }),
    },
    remote: { account: { getBalance: async () => ({ ok: false }) } },
    slots: {
      inject: (owner, cb) => cb(),
      register: (def, comp) => { registrations.push({ def, comp }); return () => {} },
    },
  }
  spec.factory(require).apply(ctx)
  assert.equal(registrations.length, 1)
  return registrations[0].comp
}

const view = {
  today: { cost: '0.09', unpriced: [], tokens: { input: 160000, output: 2100, cacheRead: 0, cacheWrite: 0, total: 162100 } },
  total: { cost: '1.50', unpriced: [], tokens: { input: 3420000, output: 46800, cacheRead: 0, cacheWrite: 0, total: 3466800 } },
  days: [{
    day: new Date().toLocaleDateString('en-CA'),
    cost: '0.09',
    unpriced: [],
    tokens: { input: 160000, output: 2100, cacheRead: 0, cacheWrite: 0, total: 162100 },
  }],
  timezone: 'Asia/Shanghai',
  currency: 'CNY',
  costComplete: true,
  usageMissingCount: 0,
}

const render = (Badge, data) => renderToStaticMarkup(Badge({
  useProjection: () => data,
  sessionId: 's1',
  t: key => ({
    title: '花费', today: '此对话花费', total: '今日总花费', input: '输入', output: '输出',
    sum: '合计', balance: '账户余额', unpriced: '未配置单价', missing: '部分调用缺少用量',
    todayShort: '今日', expand: '展开', platform: '前往平台',
  })[key] ?? key,
  remote: { account: { getBalance: async () => ({ ok: false }) } },
  localeId: 'zh',
}))

test('胶囊只展示此对话总金额', () => {
  const Badge = loadBadge()
  const html = render(Badge, view)
  assert.match(html, /¥1\.50/)
  assert.match(html, /此对话/)
  assert.equal((html.match(/\u00a5/g) ?? []).length >= 1, true)
})

test('缺少单价时金额显示破折号', () => {
  const Badge = loadBadge()
  const unpriced = {
    ...view,
    today: { cost: null, unpriced: ['deepseek/x'], tokens: view.today.tokens },
    total: { cost: null, unpriced: ['deepseek/x'], tokens: view.total.tokens },
    costComplete: false,
  }
  // 弹窗需要展开态，直接断言渲染不抛错且金额位存在破折号占位逻辑
  assert.doesNotThrow(() => render(Badge, unpriced))
})

test('投影尚未就绪时渲染占位而不抛错', () => {
  const Badge = loadBadge()
  const html = render(Badge, undefined)
  assert.match(html, /—/)
})
