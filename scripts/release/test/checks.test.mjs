import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runPackageChecks } from '../checks.mjs'
import { makeTempDir, writeExecutable } from '../test-support/helpers.mjs'

test('check 或 test 失败时抛错', async () => {
  const root = await makeTempDir()
  const fakePnpm = await writeExecutable(root, 'fake-pnpm', `
    process.stderr.write('check failed\\n')
    process.exit(1)
  `)
  await assert.rejects(
    () => runPackageChecks(
      { name: '@tjh/dsh-plugin-alpha' },
      { pnpmBin: fakePnpm, repoRoot: root },
    ),
    /check 失败[\s\S]*check failed/,
  )
})

test('skip 时不执行任何检查', async () => {
  const root = await makeTempDir()
  const log = join(root, 'calls.txt')
  const fakePnpm = await writeExecutable(root, 'fake-pnpm', `
    require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
  `)
  await runPackageChecks(
    { name: '@tjh/dsh-plugin-alpha' },
    { pnpmBin: fakePnpm, repoRoot: root, skip: true },
  )
  await assert.rejects(() => readFile(log, 'utf8'))
})
