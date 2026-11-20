/**
 * Host 半：注册 `conversationCost` 会话投影。渲染在 Client 半的 `client.js`。
 */
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { collectToday } from './today.js'
import { DEFAULT_CONFIG, createConversationCostDefinition } from './projection.js'

/** Cordis 插件名。 */
export const name = 'useage'

/** 投影注册表是插件的全部目的；没有它时该 fiber 保持 pending。 */
export const inject = ['sessionProjections']

/** 单价单位为「每百万 token」。 */
export const Config = z.object({
  currency: z.union(['CNY', 'USD']).default('CNY'),
  timezone: z.string().default('Asia/Shanghai'),
  showBalance: z.boolean().default(true),
  prices: z.dict(z.object({
    input: z.number().default(0),
    output: z.number().default(0),
    cacheRead: z.number().default(0),
    cacheWrite: z.number().default(0),
  })).default({}),
})

/**
 * 注册投影单元；注册是该 fiber 上的 effect，卸载即移除键。
 * @param {import('@deepseek-ai/cordis').Context} ctx 带投影注册表的上下文。
 * @param {object} [config] 插件配置。
 * @returns {Promise<void>} 注册完成。
 */
export async function apply(ctx, config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  await ctx.sessionProjections.register(createConversationCostDefinition(merged))

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // webServer 与 sessionPersistence 在启动时可能尚未就绪。注入作用域会在两者可用后执行一次，
  // 而不是像 ctx.get 那样探测一次就放弃注册。
  ctx.inject(['sessionPersistence', 'webServer'], (scope) => {
    const persistence = scope.sessionPersistence
    const webServer = scope.webServer
    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugin/useage/today',
      resource: async () => {
        try {
          const result = await collectToday({
            persistence, home, timezone: merged.timezone, prices: merged.prices,
          })
          return Response.json(result)
        } catch (error) {
          console.warn('[useage] today total failed', error)
          return Response.json({ error: String(error?.message ?? error) }, { status: 500 })
        }
      },
    }), 'useage: today route')
  })
}
