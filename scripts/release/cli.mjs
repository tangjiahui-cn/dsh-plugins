#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { acquireLock, releaseLock } from './session.mjs'
import { ReleaseError } from './util.mjs'

const COMMANDS = new Set(['release', 'publish', 'changelog', 'tag', 'clean', 'withdraw'])
const MUTATING = new Set(['release', 'publish', 'changelog', 'tag', 'withdraw'])

const HELP = `用法：node scripts/release/cli.mjs <命令> [选项]

命令：
  release            一键交互发布：选包、问版本、changelog、提交、发布、打 tag
  publish            只执行发布与打 tag（需要已提交的 changelog 与版本）
  changelog          按 git tag 生成子包 CHANGELOG.md
  tag                为已发布版本补建或修复 git tag
  clean              清除 session、临时目录与陈旧发布锁
  withdraw           撤回指定包的已发布版本并删除 tag

通用选项：
  --target <id>      发布目标，默认 npm
  --otp <code>       npm 两步验证码
  --help, -h         显示帮助

release / publish 选项：
  --package <name>   只处理指定包，可重复
  --yes              跳过交互确认；非 TTY 环境必须提供
  --skip-checks      跳过包的 check 与 test
  --report-dir <dir> 报告目录，默认 .tmp/release/<时间戳>

publish 额外选项：
  --dry-run          只输出计划，不发布、不认证

changelog 选项：
  --package <name>   只生成指定包的 changelog，可重复

tag 选项：
  --at <commit>      指定发布 commit；session 与 npm gitHead 都不可用时使用

withdraw 选项：
  --yes              跳过确认；非 TTY 环境必须提供

示例：
  pnpm release
  pnpm release:changelog
  pnpm release:plan
  pnpm release:publish -- --package @tjh/dsh-plugin-useage
  pnpm release:tag -- @tjh/dsh-plugin-useage@0.1.0 --at <commit>
  pnpm release:withdraw -- @tjh/dsh-plugin-useage@0.1.0
  pnpm release:clean
`

/** 解析 CLI 参数；不访问文件系统，便于测试。 */
export function parseArgs(argv) {
  if (argv.length === 0) return { command: 'help', options: {}, positionals: [] }
  const first = argv[0]
  if (first === '--help' || first === '-h') return { command: 'help', options: {}, positionals: [] }
  if (first.startsWith('-')) {
    throw new ReleaseError(`缺少命令；可用命令：${[...COMMANDS].join('、')}\n\n${HELP}`)
  }

  const command = first
  if (!COMMANDS.has(command)) {
    throw new ReleaseError(`未知命令：${command}；可用命令：${[...COMMANDS].join('、')}`)
  }

  const options = {
    packages: [],
    dryRun: false,
    yes: false,
    otp: process.env.NPM_CONFIG_OTP || undefined,
    target: undefined,
    skipChecks: false,
    reportDir: undefined,
    at: undefined,
  }
  const positionals = []

  const takeValue = (index, name) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ReleaseError(`${name} 缺少值`)
    return value
  }
  const reject = name => {
    throw new ReleaseError(`${command} 不支持 ${name}`)
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') return { command: 'help', options, positionals }
    if (arg === '--dry-run') {
      if (command !== 'publish') reject('--dry-run')
      options.dryRun = true
      continue
    }
    if (arg === '--yes') {
      if (command === 'changelog' || command === 'tag' || command === 'clean') reject('--yes')
      options.yes = true
      continue
    }
    if (arg === '--skip-checks') {
      if (command !== 'release' && command !== 'publish') reject('--skip-checks')
      options.skipChecks = true
      continue
    }
    if (arg === '--package') {
      if (!['release', 'publish', 'changelog'].includes(command)) reject('--package')
      options.packages.push(takeValue(index, '--package'))
      index += 1
      continue
    }
    if (arg === '--otp') {
      if (!['release', 'publish', 'withdraw'].includes(command)) reject('--otp')
      options.otp = takeValue(index, '--otp')
      index += 1
      continue
    }
    if (arg === '--target') {
      if (!['release', 'publish', 'tag', 'withdraw', 'clean'].includes(command)) reject('--target')
      options.target = takeValue(index, '--target')
      index += 1
      continue
    }
    if (arg === '--report-dir') {
      if (command !== 'release' && command !== 'publish') reject('--report-dir')
      options.reportDir = takeValue(index, '--report-dir')
      index += 1
      continue
    }
    if (arg === '--at') {
      if (command !== 'tag') reject('--at')
      options.at = takeValue(index, '--at')
      index += 1
      continue
    }
    if (arg.startsWith('-')) throw new ReleaseError(`未知参数：${arg}`)
    positionals.push(arg)
  }

  if (command === 'tag' || command === 'withdraw') {
    if (positionals.length !== 1) {
      throw new ReleaseError(`${command} 需要且只接受一个参数：<name>@<version>`)
    }
  } else if (positionals.length > 0) {
    throw new ReleaseError(`${command} 不接受位置参数：${positionals.join(' ')}`)
  }

  return { command, options, positionals }
}

function createIo() {
  return {
    log: message => process.stdout.write(`${message}\n`),
    error: message => process.stderr.write(`${message}\n`),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
  }
}

async function dispatch(parsed, io) {
  const { target: targetId, ...rest } = parsed.options
  if (parsed.command === 'release') {
    const { runRelease } = await import('./flow.mjs')
    return runRelease({ ...rest, targetId, io })
  }
  if (parsed.command === 'publish') {
    const { runPublish } = await import('./publish.mjs')
    return runPublish({ ...rest, targetId, io })
  }
  if (parsed.command === 'changelog') {
    const { runChangelog } = await import('./changelog-command.mjs')
    return runChangelog({ ...rest, io })
  }
  if (parsed.command === 'tag') {
    const { runTag } = await import('./tag-command.mjs')
    return runTag({ ...rest, targetId, spec: parsed.positionals[0], io })
  }
  if (parsed.command === 'clean') {
    const { runClean } = await import('./clean-command.mjs')
    return runClean({ ...rest, targetId, io })
  }
  const { runWithdraw } = await import('./withdraw.mjs')
  return runWithdraw({ ...rest, targetId, spec: parsed.positionals[0], io })
}

export async function main(argv = process.argv.slice(2), io = createIo()) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof ReleaseError) {
      io.error(error.message)
      return 1
    }
    throw error
  }

  if (parsed.command === 'help') {
    io.log(HELP.trimEnd())
    return 0
  }

  let lock = null
  try {
    if (MUTATING.has(parsed.command)) {
      lock = await acquireLock({ command: parsed.command, clearStale: parsed.command === 'release' })
    }
    return await dispatch(parsed, io)
  } catch (error) {
    if (error instanceof ReleaseError) {
      io.error(`失败：${error.message}`)
      return 1
    }
    io.error(`失败：${error?.stack ?? error}`)
    return 1
  } finally {
    if (lock !== null) await releaseLock().catch(() => {})
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
