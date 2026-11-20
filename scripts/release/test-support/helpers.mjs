import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function makeTempDir(prefix = 'dsh-release-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

export function validManifest(name = '@tjhaaa/dsh-plugin-alpha') {
  return {
    name,
    version: '1.2.3',
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.test/repo.git', directory: 'plugins/alpha' },
    files: ['index.js', 'cordis.patch.yml', 'locale/*.json', 'LICENSE'],
    exports: {
      '.': './index.js',
      './locale/*.json': './locale/*.json',
    },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
}

export async function makePackage(root, manifest = validManifest(), files = {}) {
  await writeJson(join(root, 'package.json'), manifest)
  await writeFiles(root, {
    LICENSE: 'MIT\n',
    'cordis.patch.yml': "- insert: []\n",
    'index.js': 'export const ok = true\n',
    'locale/en.json': '{}\n',
    ...files,
  })
  return root
}

export async function readText(path) {
  return readFile(path, 'utf8')
}

/** 写入一个可直接执行的假命令，返回绝对路径。 */
export async function writeExecutable(root, name, body) {
  const path = join(root, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

export function makeIo(options = {}) {
  const logs = []
  const errors = []
  const asks = []
  const answers = [...(options.answers ?? [])]
  return {
    logs,
    errors,
    asks,
    isTTY: options.isTTY ?? false,
    log(message) { logs.push(message) },
    error(message) { errors.push(message) },
    async ask(question) {
      asks.push(question)
      return answers.shift() ?? ''
    },
  }
}
