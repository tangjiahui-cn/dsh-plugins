import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reportRoot as defaultReportRoot, withdrawWindowHours } from './config.mjs'
import { timestamp } from './util.mjs'

/** 创建唯一报告目录：.tmp/release/<时间戳>。 */
export async function createReportDirectory(root = defaultReportRoot, date = new Date()) {
  await mkdir(root, { recursive: true })
  const base = timestamp(date)
  let directory = join(root, base)
  let suffix = 1
  while (true) {
    try {
      await mkdir(directory, { recursive: false })
      return directory
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      directory = join(root, `${base}-${suffix}`)
      suffix += 1
    }
  }
}

function resultLine(result) {
  const detail = result.error === undefined
    ? ''
    : `：${String(result.error).replaceAll('\n', ' ').replaceAll('|', '\\|')}`
  const tagPush = result.tagPushed === true
    ? '已推送'
    : result.tagError !== undefined
      ? '失败'
      : result.tag === undefined
        ? '—'
        : '未推送'
  const changelog = result.changelogMissing === true ? '缺失' : '—'
  return `| ${result.name} | ${result.version} | ${result.status}${detail} | ${result.integrity ?? '—'} | ${result.tag ?? '—'} | ${tagPush} | ${changelog} |`
}

export function summaryMarkdown(data) {
  const lines = [
    '# 发布报告',
    '',
    `- 目标：${data.target}`,
    `- registry：${data.registry}`,
    `- 开始：${data.startedAt}`,
    `- 结束：${data.finishedAt}`,
    `- 退出码：${data.exitCode}`,
    '',
    '## 结果',
    '',
    '| 包 | 版本 | 状态 | integrity | tag | tag push | changelog |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...data.results.map(resultLine),
    '',
    '## 回滚',
    '',
    data.rollback.commands.length === 0
      ? '没有需要撤销的版本。'
      : `在 ${withdrawWindowHours} 小时内可执行以下命令；脚本未自动执行：`,
    '',
    ...data.rollback.commands.map(command => `\`\`\`sh\n${command}\n\`\`\``),
    '',
    `> ${data.rollback.note}`,
    '',
  ]
  return `${lines.join('\n')}`
}

export function rollbackScript(commands, data) {
  const header = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `# 由 ${data.target} 发布工具生成于 ${data.finishedAt}`,
    `# npm unpublish 只在发布后 ${withdrawWindowHours} 小时内可用；超时改用 npm deprecate。`,
    '# 本地与远程 tag 删除命令位于对应 unpublish 之后；本脚本生成后未执行。',
    '',
  ]
  if (commands.length === 0) {
    header.push('echo "没有需要撤销的版本"')
  } else {
    header.push(...commands, '')
  }
  return `${header.join('\n')}`
}

/** 写出 report.json、summary.md、rollback.sh；不执行任何撤销命令。 */
export async function writeReport(data) {
  await mkdir(data.directory, { recursive: true })
  const report = {
    schemaVersion: 1,
    target: data.target,
    registry: data.registry,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    exitCode: data.exitCode,
    plan: data.plan,
    results: data.results,
    rollback: {
      windowHours: withdrawWindowHours,
      commands: data.rollback.commands,
      note: data.rollback.note,
    },
  }
  await writeFile(join(data.directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(data.directory, 'summary.md'), summaryMarkdown(report))
  const script = join(data.directory, 'rollback.sh')
  await writeFile(script, rollbackScript(data.rollback.commands, report))
  await chmod(script, 0o755)
  return report
}
