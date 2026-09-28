import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const DEFAULTS = {
  port: 4317,
  test_command: null,
  coverage_command: null,
  coverage_files: [
    'coverage/lcov.info',
    'lcov.info',
    'coverage.xml',
    'coverage/cobertura-coverage.xml',
    'coverage/coverage-final.json',
    'coverage.json',
    'coverage.out',
  ],
  source_globs: ['src/**', 'lib/**', 'app/**'],
  ignore_paths: ['node_modules/**', 'dist/**', 'build/**', 'cui/**', 'demos/**', '.cui/**'],
  diff_coverage_threshold: 80,
  claude_bin: 'claude',
  claude_model: null,
  enforce: true,
}

export function findRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.cui'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fall back to the git root so `cui init` works before .cui exists.
  dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

export function loadConfig(root = findRoot()) {
  const cuiDir = join(root, '.cui')
  let file = {}
  const path = join(cuiDir, 'config.yaml')
  if (existsSync(path)) {
    try {
      file = parseYaml(readFileSync(path, 'utf8')) ?? {}
    } catch (err) {
      throw new Error(`.cui/config.yaml is not valid YAML: ${err.message}`)
    }
  }
  const cfg = { ...DEFAULTS, ...file }
  cfg.root = root
  cfg.cuiDir = cuiDir
  cfg.dbPath = join(cuiDir, 'cui.db')
  cfg.walkthroughDir = join(cuiDir, 'walkthroughs')
  cfg.port = Number(process.env.CUI_PORT || cfg.port)
  return cfg
}

export function ensureDirs(cfg) {
  mkdirSync(cfg.cuiDir, { recursive: true })
  mkdirSync(cfg.walkthroughDir, { recursive: true })
}

export function readYamlFile(path) {
  if (!existsSync(path)) return null
  try {
    return parseYaml(readFileSync(path, 'utf8')) ?? null
  } catch (err) {
    throw new Error(`${path} is not valid YAML: ${err.message}`)
  }
}
