import assert from 'node:assert/strict'
import test from 'node:test'
import { main, parseArgs } from '../cli.mjs'
import { makeIo } from '../test-support/helpers.mjs'

test('parseArgs 识别新命令与选项', () => {
  assert.equal(parseArgs(['release', '--yes']).command, 'release')
  assert.deepEqual(parseArgs(['changelog', '--package', '@tjhaaa/dsh-plugin-alpha']).options.packages, [
    '@tjhaaa/dsh-plugin-alpha',
  ])
  const tag = parseArgs(['tag', '@tjhaaa/dsh-plugin-alpha@0.1.0', '--at', 'abc123'])
  assert.equal(tag.options.at, 'abc123')
  assert.deepEqual(tag.positionals, ['@tjhaaa/dsh-plugin-alpha@0.1.0'])
  assert.equal(parseArgs(['clean']).command, 'clean')
  assert.equal(parseArgs(['publish', '--dry-run']).options.dryRun, true)
})

test('parseArgs 拒绝未知命令与不适用选项', () => {
  assert.throws(() => parseArgs(['unknown']), /未知命令/)
  assert.throws(() => parseArgs(['clean', '--yes']), /clean 不支持 --yes/)
  assert.throws(() => parseArgs(['release', '--at', 'x']), /release 不支持 --at/)
  assert.throws(() => parseArgs(['tag']), /tag 需要且只接受一个参数/)
})

test('--help 退出 0 并列出新命令', async () => {
  const io = makeIo()
  assert.equal(await main(['--help'], io), 0)
  const output = io.logs.join('\n')
  for (const command of ['release', 'publish', 'changelog', 'tag', 'clean', 'withdraw']) {
    assert.match(output, new RegExp(command))
  }
})
