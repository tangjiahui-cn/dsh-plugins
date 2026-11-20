import { spawn } from 'node:child_process'

/** 可预期的发布失败；CLI 只打印消息，不打印堆栈。 */
export class ReleaseError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'ReleaseError'
  }
}

/**
 * 运行子命令并收集输出。非零退出不抛错，由调用方判断；
 * 命令无法启动时返回 error。
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: Error}>}
 */
export function runCommand(command, args, options = {}) {
  const { cwd = process.cwd(), env = {}, input } = options
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: '', error })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolvePromise({ code: null, stdout, stderr, error }))
    child.on('close', code => resolvePromise({ code, stdout, stderr }))

    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** 运行命令，非零退出或无法启动时抛出 ReleaseError。 */
export async function runOrThrow(command, args, options = {}) {
  const result = await runCommand(command, args, options)
  if (result.error !== undefined) {
    throw new ReleaseError(`无法执行 ${formatCommand(command, args)}：${result.error.message}`)
  }
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
    throw new ReleaseError(`${formatCommand(command, args)} 退出码 ${result.code}${detail ? `\n${detail}` : ''}`)
  }
  return result
}

/** 单引号转义，用于生成可直接执行的 shell 命令。 */
export function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function formatCommand(command, args) {
  const safe = /^[A-Za-z0-9_%+=:,.-]+$/
  return [command, ...args]
    .map(value => (safe.test(value) ? value : quoteShell(value)))
    .join(' ')
}

/** 去掉末尾斜杠并统一为 URL 字符串；解析失败时返回原值。 */
export function normalizeRegistry(value) {
  const text = String(value ?? '').trim()
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return text.replace(/\/+$/, '')
  }
}

export function isOfficialRegistry(value) {
  try {
    const url = new URL(String(value).trim())
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'
  } catch {
    return false
  }
}

export function timestamp(date = new Date()) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z')
}

export function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/** 读取 package.json；供多个模块复用。 */
export async function readJson(path) {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(path, 'utf8'))
}


/** 解析 <name>@<version>，支持 scoped 包名。 */
export function parsePackageSpec(spec) {
  const text = String(spec ?? '').trim()
  const index = text.lastIndexOf('@')
  if (index <= 0 || index === text.length - 1) {
    throw new ReleaseError(`目标格式应为 <name>@<version>，实际：${text || '（空）'}`)
  }
  return { name: text.slice(0, index), version: text.slice(index + 1) }
}
