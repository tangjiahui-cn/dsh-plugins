/**
 * 会话标题行右侧的花费胶囊与弹窗。数据来自 Host 的 `conversationCost` 投影，
 * 余额在展开时按需查询账户服务，失败即隐藏。
 */
window.__ModuleLoader__.load({
  id: '@tjhaaa/dsh-plugin-useage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'useage'

    const zh = {
      title: '对话花费',
      todayShort: '今日',
      pillConversation: '此对话',
      conversationSpend: '此对话花费',
      conversationToday: '此对话今日总花费',
      todayTotal: '今日：',
      today: '此对话今日总花费',
      total: '此对话总花费',
      input: '输入',
      output: '输出',
      sum: '合计',
      balance: '余额：',
      unpriced: '未配置单价',
      empty: '暂无消耗',
      expand: '展开花费明细',
      platform: '前往平台',
      balanceLoading: '查询余额…',
      balanceFailed: '查询失败',
      retry: '重新查询',
      refresh: '点击刷新',
    }
    const en = {
      title: 'Spend',
      todayShort: 'Today',
      pillConversation: 'This chat',
      conversationSpend: 'This chat',
      conversationToday: 'This chat today',
      todayTotal: 'Today total',
      today: 'This chat today',
      total: 'This chat total',
      input: 'Input',
      output: 'Output',
      sum: 'Total',
      balance: 'Balance',
      unpriced: 'No price configured',
      empty: 'No spend yet',
      expand: 'Show spend details',
      platform: 'Open platform',
      balanceLoading: 'Loading balance…',
      balanceFailed: 'Balance unavailable',
      retry: 'Retry',
      refresh: 'Click to refresh',
    }

    const CSS = `
.ue-wrap{position:relative;display:flex;align-items:center}
.ue-pill{display:flex;align-items:center;gap:6px;height:26px;padding:0 8px 0 9px;
  border:1px solid var(--dsw-alias-border-l3,#2c2d34);border-radius:13px;
  background:var(--dsw-alias-card-fill,#1c1d22);
  box-shadow:0 1px 2px rgba(0,0,0,.25);color:var(--dsw-alias-label-primary,#f3f4f6);
  font-family:var(--dsw-font-family,system-ui);font-size:12px;line-height:1;cursor:pointer}
.ue-pill:hover{background:var(--dsw-alias-interactive-bg-hover,#26272d)}
.ue-dot{width:6px;height:6px;border-radius:50%;background:#3ecf8e;flex:none}
.ue-k{color:var(--dsw-alias-label-tertiary,#8a8c93)}
.ue-amt{font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.2px}
.ue-sep{width:1px;height:11px;background:var(--dsw-alias-border-l3,#34353c)}
.ue-tok{color:var(--dsw-alias-label-secondary,#9b9da4);font-variant-numeric:tabular-nums}
.ue-chev{width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;
  border-top:4px solid currentColor;opacity:.55;margin-left:1px}
.ue-pop{position:absolute;right:0;top:calc(100% + 8px);z-index:60;width:326px;
  padding:12px 14px 0;border-radius:13px;text-align:left;
  background:var(--dsw-alias-card-fill,#1b1c21);
  border:1px solid var(--dsw-alias-border-l3,#31323a);
  box-shadow:var(--dsw-elevation-panel,0 22px 60px rgba(0,0,0,.55));
  color:var(--dsw-alias-label-primary,#e8e9ec);font-family:var(--dsw-font-family,system-ui)}
.ue-hd{display:flex;align-items:baseline;gap:7px;margin-bottom:10px}
.ue-hd-t{font-size:12.5px;font-weight:600}
.ue-hd-d{font-size:11px;color:var(--dsw-alias-label-tertiary,#6f7178)}
.ue-card{padding:11px 13px 12px;border-radius:11px;margin-bottom:9px;
  background:color-mix(in srgb, var(--dsw-alias-label-primary,#ffffff) 5%, transparent);
  border:1px solid var(--dsw-alias-border-l2,#2b2c33)}
.ue-card:last-of-type{margin-bottom:0}
.ue-l{font-size:10.5px;letter-spacing:.3px;color:var(--dsw-alias-label-tertiary,#8b8d94)}
.ue-money{display:flex;align-items:baseline;gap:1px;margin:7px 0 8px}
.ue-money i{font-style:normal;font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary,#b9bbc2)}
.ue-money b{font-size:29px;font-weight:600;letter-spacing:-.9px;line-height:1;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#f4f5f7)}
.ue-line{font-size:10px;color:var(--dsw-alias-label-caption,#6f7178);font-variant-numeric:tabular-nums}
.ue-line b{font-weight:600;color:var(--dsw-alias-label-secondary,#9ea0a7)}
.ue-foot{display:flex;align-items:center;gap:2px;height:40px;margin-top:9px;padding-top:0;
  border-top:1px solid var(--dsw-alias-border-l2,#2a2b32)}
.ue-foot-k{font-size:10px;color:var(--dsw-alias-label-tertiary,#7c7e85)}
.ue-foot-v{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#f2f3f5)}
.ue-foot-note{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#6f7178)}
.ue-foot-seg{display:flex;align-items:center;gap:4px;width:132px;height:40px;min-width:0;overflow:hidden;white-space:nowrap}
.ue-foot-seg + .ue-foot-seg{width:108px;padding-left:6px;border-left:1px solid var(--dsw-alias-border-l2,#2a2b32)}
.ue-foot-refresh{padding:0;border:0;background:none;cursor:pointer;font:inherit;
  font-weight:600;color:inherit;font-variant-numeric:tabular-nums}
.ue-foot-refresh:hover{text-decoration:underline}
.ue-foot-link{margin-left:auto;padding:0;border:0;background:none;cursor:pointer;white-space:nowrap;
  font-family:inherit;font-size:10px;color:var(--dsw-alias-label-secondary,#8b8d94)}
.ue-foot-link:hover{color:var(--dsw-alias-label-primary,#f2f3f5);text-decoration:underline}
.ue-spin-value{margin-left:8px;align-self:center;opacity:.75}
.ue-spin{display:inline-block;width:10px;height:10px;vertical-align:0;
  border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;
  animation:ue-rot .8s linear infinite}
@keyframes ue-rot{to{transform:rotate(360deg)}}
.ue-error,.ue-error-inline{display:flex;align-items:center;padding:0;border:0;background:none;
  font:inherit;cursor:pointer;color:var(--dsw-alias-state-error-primary,#f0674a)}
.ue-error{gap:6px;font-size:11px}
.ue-error-inline{gap:5px}
.ue-error:hover,.ue-error-inline:hover{text-decoration:underline}
.ue-error-reason{font-style:normal;opacity:.75;max-width:150px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ue-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
`

    const allowAll = () => true

    const dayOf = timeZone => {
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      } catch {
        return new Date().toISOString().slice(0, 10)
      }
    }

    const amount = value => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return String(value)
      return parsed.toFixed(2)
    }

    const money = (value, currency) => {
      if (value === null || value === undefined) return '—'
      const symbol = currency === 'USD' ? '$' : '¥'
      return `${symbol}${amount(value)}`
    }

    const CAP = 999999
    const FULL_LENGTH = 5
    const compact = (value, currency) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return '—'
      const symbol = currency === 'USD' ? '$' : '¥'
      const fixed = parsed.toFixed(2)
      if (fixed.replace('.', '').length <= FULL_LENGTH) return `${symbol}${fixed}`
      const rounded = Math.round(parsed)
      return `${symbol}${rounded > CAP ? CAP : rounded}`
    }

    const tok = value => {
      const n = Number(value ?? 0)
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${Math.round(n / 1e3)}K`
      return String(n)
    }

    function Card(props) {
      const { label, node, currency, t } = props
      const tokens = node?.tokens ?? { input: 0, output: 0, total: 0 }
      return h('div', { className: 'ue-card' },
        h('div', { className: 'ue-l' }, label),
        node?.cost === null || node?.cost === undefined
          ? h('div', { className: 'ue-money' }, h('b', null, '—'))
          : h('div', { className: 'ue-money' },
            h('i', null, currency === 'USD' ? '$' : '¥'),
            h('b', null, node.cost),
          ),
        h('div', { className: 'ue-line' },
          `${t('input')} `, h('b', null, tok(tokens.input)), ` tok · `,
          `${t('output')} `, h('b', null, tok(tokens.output)), ` tok · `,
          `${t('sum')} `, h('b', null, tok(tokens.total)), ` tok`,
        ),
        node !== undefined && node.cost === null && node.unpriced?.length
          ? h('div', { className: 'ue-line', style: { marginTop: '6px' } }, t('unpriced'))
          : null,
      )
    }


    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[useage] render failed', error)
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'ue-wrap' },
            h('span', {
              className: 'ue-pill',
              title: String(this.state.error && this.state.error.message || this.state.error),
            }, h('span', { className: 'ue-k' }, 'useage'), h('span', { className: 'ue-amt' }, '—')),
          )
        }
        return this.props.children
      }
    }

    function Badge(props) {
      const { useProjection, t, remoteAccount, accountAccess, useAccess, accountUi, localeId } = props
      const view = useProjection('conversationCost')
      const [open, setOpen] = useState(false)
      const [balance, setBalance] = useState({ status: 'idle' })
      const [todayTotal, setTodayTotal] = useState({ status: 'idle' })
      const accessFn = useAccess ?? allowAll
      const canReadAccount = accessFn('account/watch') !== false
      const buttonRef = useRef(null)
      const wrapRef = useRef(null)

      const close = useCallback(() => {
        setOpen(false)
        if (buttonRef.current) buttonRef.current.focus()
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKey = event => { if (event.key === 'Escape') close() }
        const onDown = event => {
          const node = event.target
          if (node instanceof Node && wrapRef.current?.contains(node)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open, close])

      const loadTodayTotal = useCallback(() => {
        setTodayTotal(previous => ({ status: 'loading', data: previous.data }))
        fetch('/plugin/useage/today', { credentials: 'same-origin' })
          .then(async response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (body?.error !== undefined) throw new Error(String(body.error))
            setTodayTotal({ status: 'ready', data: body })
          })
          .catch(error => {
            console.warn('[useage] today total failed', error)
            setTodayTotal({ status: 'error' })
          })
      }, [])

      const loadBalance = useCallback(() => {
        setBalance({ status: 'loading' })
        const fallback = (reason = 'no data') => {
          const cached = accountUi?.getSnapshot?.()?.details?.balance
          const wallet = cached?.status === 'ready' ? cached.value?.[0] : undefined
          if (wallet !== undefined) { setBalance({ status: 'ready', wallet }); return }
          setBalance({ status: 'error', reason })
        }
        try {
          if (!canReadAccount) { console.warn('[useage] balance denied by access'); fallback(); return }
          const meta = accountUi?.clientMetadata?.(localeId) ?? {
            version: '0.0.0',
            locale: localeId,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }
          const runner = accountAccess?.run
          const query = typeof runner === 'function'
            ? runner
            : (remoteAccount !== undefined && typeof remoteAccount.getBalance === 'function'
              ? () => remoteAccount.getBalance(meta)
              : undefined)
          if (query === undefined) { fallback(); return }
          console.info('[useage] balance request', { via: typeof runner === 'function' ? 'access' : 'direct', meta })
          Promise.resolve(query(meta)).then(result => {
            const outcome = result?.ok ? result.value : undefined
            const wallet = outcome?.status === 'ready' ? outcome.value?.[0] : undefined
            if (wallet === undefined) {
              const reason = typeof result?.error === 'string'
                ? result.error
                : (result?.error?.code ?? outcome?.status ?? 'no account data')
              console.warn('[useage] balance unavailable', { reason, meta, result })
              fallback(reason)
              return
            }
            setBalance({ status: 'ready', wallet })
          }).catch(error => {
            console.warn('[useage] balance failed', error)
            fallback(String(error?.message ?? error))
          })
        } catch (error) {
          console.warn('[useage] balance unavailable', error)
          fallback(String(error?.message ?? error))
        }
      }, [accountUi, remoteAccount, accountAccess, canReadAccount, localeId])

      useEffect(() => {
        if (!open) return undefined
        loadBalance()
        loadTodayTotal()
        return undefined
      }, [open, loadBalance, loadTodayTotal])

      const timezone = view?.timezone ?? 'Asia/Shanghai'
      const currency = view?.currency ?? 'CNY'
      const today = view === undefined
        ? undefined
        : (view.days?.find(entry => entry.day === dayOf(timezone)) ?? view.today)

      const conversationTotal = view?.total?.cost
      const pillConversation = money(conversationTotal, currency)

      return h('div', { className: 'ue-wrap', ref: wrapRef },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('button', {
          type: 'button',
          ref: buttonRef,
          className: 'ue-pill',
          'aria-expanded': open,
          'aria-label': t('expand'),
          title: t('expand'),
          onClick: () => { setOpen(value => !value) },
        },
          h('i', { className: 'ue-dot' }),
          h('span', { className: 'ue-k' }, t('pillConversation')),
          h('span', { className: 'ue-amt' }, pillConversation),
          h('i', { className: 'ue-chev' }),
        ),
        open
          ? h('div', { className: 'ue-pop', role: 'dialog', 'aria-label': t('title') },
            h('div', { className: 'ue-hd' },
              h('span', { className: 'ue-hd-t' }, t('title')),
              h('span', { className: 'ue-hd-d' }, new Intl.DateTimeFormat(localeId, {
                month: 'long', day: 'numeric',
              }).format(new Date())),
            ),
            h(Card, { label: t('conversationToday'), node: today, currency, t }),
            h(Card, { label: t('total'), node: view?.total, currency, t }),
            h('div', { className: 'ue-foot' },
              h('div', { className: 'ue-foot-seg' },
                h('span', { className: 'ue-foot-k' }, t('balance')),
                balance.status === 'loading'
                  ? h('span', { className: 'ue-foot-v' }, h('i', { className: 'ue-spin' }))
                  : balance.status === 'error'
                    ? h('button', {
                      type: 'button',
                      className: 'ue-error',
                      title: balance.reason === undefined ? t('retry') : `${t('retry')} · ${balance.reason}`,
                      'aria-label': t('retry'),
                      onClick: loadBalance,
                    },
                      t('balanceFailed'),
                      h('svg', {
                        width: 12,
                        height: 12,
                        viewBox: '0 0 16 16',
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: 1.5,
                        strokeLinecap: 'round',
                        'aria-hidden': true,
                      }, h('path', { d: 'M13.2 8A5.2 5.2 0 1 1 11.4 4' }), h('path', { d: 'M11.4 1.6v2.8H8.6' })),
                    )
                    : balance.status === 'ready'
                      ? h('button', {
                        type: 'button',
                        className: 'ue-foot-v ue-foot-refresh',
                        title: t('refresh'),
                        'aria-label': t('refresh'),
                        onClick: loadBalance,
                      }, compact(balance.wallet.balance, balance.wallet.currency))
                      : h('span', { className: 'ue-foot-v' }, '—'),
              ),
              h('div', { className: 'ue-foot-seg' },
                h('span', { className: 'ue-foot-k' }, t('todayTotal')),
                todayTotal.status === 'loading'
                  ? h('span', { className: 'ue-foot-v' }, h('i', { className: 'ue-spin' }))
                  : todayTotal.status === 'error'
                    ? h('button', {
                      type: 'button', className: 'ue-error-inline', title: t('retry'), 'aria-label': t('retry'),
                      onClick: loadTodayTotal,
                    },
                      t('balanceFailed'),
                      h('svg', {
                        width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none',
                        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true,
                      }, h('path', { d: 'M13.2 8A5.2 5.2 0 1 1 11.4 4' }), h('path', { d: 'M11.4 1.6v2.8H8.6' })))
                    : h('button', {
                      type: 'button',
                      className: 'ue-foot-v ue-foot-refresh',
                      title: t('refresh'),
                      'aria-label': t('refresh'),
                      onClick: loadTodayTotal,
                    }, todayTotal.data === undefined ? '\u2014' : compact(todayTotal.data.amount, currency)),
              ),
              h('button', {
                type: 'button',
                className: 'ue-foot-link',
                onClick: () => { window.open('https://platform.deepseek.com/usage', '_blank', 'noopener,noreferrer') },
              }, t('platform')),
            ),
          )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'useage: dictionaries')
        const t = ctx.locale.bind(NS)
        const localeId = ctx.locale.getSnapshot?.()?.active ?? 'zh'
        const remoteAccount = ctx.get?.('remote.account') ?? ctx.remote?.account
        const accountAccess = { run: null }
        const remoteAccess = ctx.get?.('remoteAccess')
        if (remoteAccess !== undefined && remoteAccount !== undefined) {
          ctx.effect(() => remoteAccess.whenAccess('account/watch', function* () {
            accountAccess.run = meta => remoteAccount.getBalance(meta)
            yield () => { accountAccess.run = null }
          }), 'useage: account access')
        }
        const accountUi = ctx.get?.('accountUi')
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'useage',
          order: 20,
        }, props => h(Boundary, null, h(Badge, { ...props, t, remoteAccount, accountAccess, accountUi, localeId }))))
      },
    }
  },
})
