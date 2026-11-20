import assert from 'node:assert/strict'
import test from 'node:test'
import { runCommand } from '../util.mjs'

test('runCommand 超时会终止子进程', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'],
    { timeoutMs: 100 },
  )
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.match(result.error.message, /100ms/)
})
