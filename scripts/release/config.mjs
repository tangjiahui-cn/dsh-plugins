import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：scripts/release/ 向上两级。 */
export const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** 发布目标 registry；仓库只允许官方源。 */
export const registry = 'https://registry.npmjs.org/'

/** 子包名称前缀；只有匹配该前缀的 plugins/* 才进入发布候选。 */
export const pluginPrefix = '@tjhaaa/dsh-plugin-'

/** 子包所在目录。 */
export const pluginsDir = resolve(repoRoot, 'plugins')

/** 报告根目录，位于 .gitignore 忽略的 .tmp 下。 */
export const reportRoot = resolve(repoRoot, '.tmp/release')

/** npm 独立缓存目录，避开用户级缓存的权限问题。 */
export const npmCacheDir = resolve(reportRoot, 'npm-cache')

/** 锁文件路径，用于官方源校验。 */
export const lockfilePath = resolve(repoRoot, 'pnpm-lock.yaml')

/** 根 .npmrc 路径。 */
export const npmrcPath = resolve(repoRoot, '.npmrc')

/** npm 撤回窗口。 */
export const withdrawWindowHours = 72

/** 可执行文件；测试通过环境变量注入假命令。 */
export const npmBin = process.env.RELEASE_NPM_BIN || 'npm'
export const pnpmBin = process.env.RELEASE_PNPM_BIN || 'pnpm'
export const gitBin = process.env.RELEASE_GIT_BIN || 'git'
