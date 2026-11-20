import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createReportDirectory, writeReport } from '../report.mjs'
import { makeTempDir } from '../test-support/helpers.mjs'

const data = {
  target: 'npm',
  registry: 'https://registry.npmjs.org/',
  startedAt: '2026-11-20T01:00:00.000Z',
  finishedAt: '2026-11-20T01:01:00.000Z',
  exitCode: 1,
  plan: [{ name: '@tjh/dsh-plugin-useage', version: '0.1.0', relDir: 'plugins/useage', order: 1 }],
  results: [
    {
      name: '@tjh/dsh-plugin-useage',
      version: '0.1.0',
      status: 'published',
      integrity: 'sha512-abc',
      url: 'https://www.npmjs.com/package/@tjh/dsh-plugin-useage/v/0.1.0',
      releaseCommit: 'abc123',
      tag: '@tjh/dsh-plugin-useage@0.1.0',
      tagPushed: true,
      changelogMissing: false,
    },
    {
      name: '@tjh/dsh-plugin-other',
      version: '1.0.0',
      status: 'failed',
      error: 'boom',
      changelogMissing: true,
    },
  ],
  rollback: {
    commands: ["npm unpublish '@tjh/dsh-plugin-useage@0.1.0' --force"],
    note: '命令未执行',
  },
}

test('报告目录按时间戳唯一', async () => {
  const root = await makeTempDir()
  const first = await createReportDirectory(root, new Date('2026-11-20T01:00:00.000Z'))
  const second = await createReportDirectory(root, new Date('2026-11-20T01:00:00.000Z'))
  assert.notEqual(first, second)
})

test('成功与失败结果写入三种文件，rollback.sh 可执行且不自动运行', async () => {
  const root = await makeTempDir()
  const directory = join(root, 'report')
  await writeReport({ ...data, directory })

  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.results[0].status, 'published')
  assert.match(report.rollback.commands[0], /npm unpublish/)

  const summary = await readFile(join(directory, 'summary.md'), 'utf8')
  assert.match(summary, /@tjh\/dsh-plugin-useage/)
  assert.match(summary, /npm unpublish/)
  assert.match(summary, /已推送/)
  assert.match(summary, /缺失/)

  const script = await readFile(join(directory, 'rollback.sh'), 'utf8')
  assert.match(script, /^#!\/usr\/bin\/env bash/)
  assert.match(script, /set -euo pipefail/)
  assert.match(script, /72 小时/)
  assert.match(script, /npm unpublish/)
  assert.equal((await stat(join(directory, 'rollback.sh'))).mode & 0o777, 0o755)
})

test('没有可撤销版本时脚本只输出说明', async () => {
  const root = await makeTempDir()
  const directory = join(root, 'report-empty')
  await writeReport({
    ...data,
    directory,
    results: [{ name: '@tjh/dsh-plugin-useage', version: '0.1.0', status: 'failed', error: 'x' }],
    rollback: { commands: [], note: '无' },
  })
  const script = await readFile(join(directory, 'rollback.sh'), 'utf8')
  assert.match(script, /没有需要撤销的版本/)
})
