import { spawn } from 'node:child_process'

/**
 * Runs Claude Code headless in the repo. Using the CLI rather than the API means no
 * API key to manage and, more usefully, the model can read any file in the repo to
 * ground its answer instead of relying on whatever context we thought to paste in.
 */
export function runClaude(cfg, prompt, opts = {}) {
  const {
    allowedTools = ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
    maxTurns = 40,
    timeoutMs = 10 * 60 * 1000,
    onProgress = null,
  } = opts

  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--allowedTools', allowedTools.join(','),
      '--max-turns', String(maxTurns),
    ]
    if (cfg.claude_model) args.push('--model', cfg.claude_model)

    let child
    try {
      child = spawn(cfg.claude_bin || 'claude', args, {
        cwd: cfg.root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cui' },
      })
    } catch (err) {
      reject(new Error(`could not start "${cfg.claude_bin}": ${err.message}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const started = Date.now()

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
      reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += d
      onProgress?.(stdout.length)
    })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(
        err.code === 'ENOENT'
          ? `"${cfg.claude_bin}" is not on PATH. Install Claude Code, or set claude_bin in .cui/config.yaml.`
          : err.message,
      ))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Date.now() - started

      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 600)}`))
        return
      }

      let text = stdout.trim()
      try {
        const parsed = JSON.parse(text)
        if (parsed?.is_error) {
          reject(new Error(`claude reported an error: ${parsed.result ?? parsed.subtype}`))
          return
        }
        if (typeof parsed?.result === 'string') text = parsed.result
      } catch {
        // Not JSON — the CLI printed plain text. Use it as-is.
      }

      if (!text) { reject(new Error('claude returned nothing')); return }
      resolve({ text: stripFences(text), durationMs })
    })

    child.stdin.end(prompt)
  })
}

/** Models sometimes wrap a whole markdown answer in a fence. Unwrap exactly that case. */
function stripFences(text) {
  const m = text.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  return m ? m[1].trim() : text.trim()
}

export async function claudeAvailable(cfg) {
  return new Promise((resolve) => {
    const child = spawn(cfg.claude_bin || 'claude', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
