import { pnpmBin as defaultPnpmBin, repoRoot as defaultRepoRoot } from './config.mjs'
import { ReleaseError, runCommand } from './util.mjs'

/** 对单个包执行 check 与 test；任一失败即抛出。 */
export async function runPackageChecks(pkg, options = {}) {
  if (options.skip === true) return
  const pnpmBin = options.pnpmBin ?? defaultPnpmBin
  const repoRoot = options.repoRoot ?? defaultRepoRoot

  for (const script of ['check', 'test']) {
    const result = await runCommand(
      pnpmBin,
      ['--filter', pkg.name, 'run', '--if-present', script],
      { cwd: repoRoot, env: options.env, timeoutMs: 300000 },
    )
    if (result.error !== undefined) {
      throw new ReleaseError(`无法执行 pnpm ${script}（${pkg.name}）：${result.error.message}`)
    }
    if (result.code !== 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
      throw new ReleaseError(`${pkg.name} 的 ${script} 失败：\n${detail}`)
    }
  }
}
