import { repoRoot as defaultRepoRoot } from './config.mjs'
import { cleanState } from './session.mjs'

const defaultIo = {
  log: message => console.log(message),
  error: message => console.error(message),
}

export async function runClean(options = {}) {
  const io = options.io ?? defaultIo
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const result = await cleanState(repoRoot)

  if (result.removed.length > 0) {
    for (const path of result.removed) io.log(`已删除：${path}`)
  } else {
    io.log('没有需要清理的 session 或临时目录。')
  }
  if (result.liveLock) {
    io.error('发布锁仍被存活进程持有，未删除；先确认该发布命令已结束。')
    return 1
  }
  return 0
}
