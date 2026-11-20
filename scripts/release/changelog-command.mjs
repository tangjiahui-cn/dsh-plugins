import { join } from 'node:path'
import { gitBin as defaultGitBin, repoRoot as defaultRepoRoot } from './config.mjs'
import { writeChangelog } from './changelog.mjs'
import { discoverPackages, selectPackages } from './packages.mjs'
import { ReleaseError } from './util.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
}

export async function runChangelog(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const gitBin = options.gitBin ?? defaultGitBin
  const packages = await discoverPackages(join(repoRoot, 'plugins'), repoRoot)
  const selected = selectPackages(packages, options.packages ?? [])
  if (selected.length === 0) throw new ReleaseError('没有可生成 changelog 的子包')

  for (const pkg of selected) {
    const result = await writeChangelog({
      pkg,
      version: pkg.version,
      repoRoot,
      gitBin,
      date: options.date,
    })
    if (result.changed) {
      io.log(`${pkg.name}@${pkg.version}：已写入 ${result.path}`)
    } else {
      io.log(`${pkg.name}@${pkg.version}：${result.reason ?? '内容未变化'}`)
    }
  }
  return 0
}
