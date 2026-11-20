import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import {
  checkChangelog,
  collectCommits,
  dateInShanghai,
  parseCommitSubject,
  renderSection,
  sectionForVersion,
  writeChangelog,
} from '../changelog.mjs'
import { runCommand } from '../util.mjs'
import { makeTempDir, writeJson } from '../test-support/helpers.mjs'

async function git(cwd, args) {
  const result = await runCommand('git', args, { cwd })
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function fixture() {
  const root = await makeTempDir()
  const dir = join(root, 'plugins', 'alpha')
  await writeJson(join(dir, 'package.json'), {
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '0.1.0',
    files: ['index.js', 'CHANGELOG.md'],
  })
  await writeFile(join(dir, 'index.js'), 'export {}\n')
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'release@example.test'])
  await git(root, ['config', 'user.name', 'Release Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'feat: initial'])
  const pkg = {
    name: '@tjhaaa/dsh-plugin-alpha',
    version: '0.1.0',
    relDir: 'plugins/alpha',
    dir,
  }
  return { root, dir, pkg, options: { repoRoot: root } }
}

test('dateInShanghai 输出 YYYY-MM-DD', () => {
  assert.match(dateInShanghai(new Date('2026-11-20T00:00:00Z')), /^2026-11-20$/)
})

test('parseCommitSubject 分类与破坏性标记', () => {
  assert.equal(parseCommitSubject('feat: add').category, 'feat')
  assert.equal(parseCommitSubject('fix(scope): repair').category, 'fix')
  assert.equal(parseCommitSubject('feat!: break').breaking, true)
  assert.equal(parseCommitSubject('random change').category, 'maintenance')
})

test('renderSection 按固定顺序分组', () => {
  const section = renderSection({
    version: '0.1.0',
    date: '2026-11-20',
    commits: [
      { ...parseCommitSubject('fix: b'), shortHash: '2' },
      { ...parseCommitSubject('feat: a'), shortHash: '1' },
      { ...parseCommitSubject('chore: c'), shortHash: '3' },
    ],
  })
  assert.match(section, /### 新功能[\s\S]*### 修复[\s\S]*### 维护/)
})

test('首次生成、提交后重跑不变、内容校验通过', async () => {
  const data = await fixture()
  const first = await writeChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })
  assert.equal(first.changed, true)
  const text = await readFile(join(data.dir, 'CHANGELOG.md'), 'utf8')
  assert.match(text, /## 0\.1\.0 - \d{4}-\d{2}-\d{2}/)
  assert.match(text, /feat: initial|initial/)
  assert.ok(sectionForVersion(text, '0.1.0'))

  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog'])
  await checkChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })

  const second = await writeChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })
  assert.equal(second.changed, false)
})

test('后续生成使用上一条 tag 到 HEAD，并跳过发布提交', async () => {
  const data = await fixture()
  await writeChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog'])
  await git(data.root, ['tag', '@tjhaaa/dsh-plugin-alpha@0.1.0'])

  await writeFile(join(data.dir, 'index.js'), 'export const changed = true\n')
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'fix: repair behavior'])
  await writeFile(join(data.dir, 'package.json'), JSON.stringify({
    name: data.pkg.name,
    version: '0.1.1',
    files: ['index.js', 'CHANGELOG.md'],
  }, null, 2))
  data.pkg.version = '0.1.1'

  const result = await writeChangelog({ pkg: data.pkg, version: '0.1.1', ...data.options })
  assert.equal(result.changed, true)
  const text = await readFile(join(data.dir, 'CHANGELOG.md'), 'utf8')
  assert.match(text, /## 0\.1\.1/)
  assert.match(text, /修复/)
  assert.match(text, /0\.1\.0/)

  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'chore(release): 0.1.1'])
  await checkChangelog({ pkg: data.pkg, version: '0.1.1', ...data.options })
})

test('非约定提交归入维护，merge 被排除', async () => {
  const data = await fixture()
  await git(data.root, ['checkout', '-qb', 'side'])
  await writeFile(join(data.dir, 'side.js'), 'export {}\n')
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'random change'])
  await git(data.root, ['checkout', '-q', '-'])
  await git(data.root, ['merge', '--no-ff', '-m', 'merge: side', 'side'])

  const commits = await collectCommits({ pkg: data.pkg, ...data.options })
  assert.ok(commits.some(commit => commit.subject === 'random change'))
  assert.ok(!commits.some(commit => commit.subject === 'merge: side'))
  assert.equal(commits.find(commit => commit.subject === 'random change').category, 'maintenance')
})

test('内容被手改后校验失败', async () => {
  const data = await fixture()
  await writeChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog'])
  const path = join(data.dir, 'CHANGELOG.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('initial', 'tampered'))
  await assert.rejects(
    () => checkChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options }),
    /与提交不一致/,
  )
})

test('版本与 changelog 分开提交时校验仍通过', async () => {
  const data = await fixture()
  await writeChangelog({ pkg: data.pkg, version: data.pkg.version, ...data.options })
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog'])
  await git(data.root, ['tag', '@tjhaaa/dsh-plugin-alpha@0.1.0'])

  await writeFile(join(data.dir, 'index.js'), 'export const fixed = true\n')
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'fix: repair'])
  const manifestPath = join(data.dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = '0.1.1'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  data.pkg.version = '0.1.1'
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'chore: bump version'])

  await writeChangelog({ pkg: data.pkg, version: '0.1.1', ...data.options })
  await git(data.root, ['add', '-A'])
  await git(data.root, ['commit', '-qm', 'docs: changelog 0.1.1'])
  await checkChangelog({ pkg: data.pkg, version: '0.1.1', ...data.options })
})
