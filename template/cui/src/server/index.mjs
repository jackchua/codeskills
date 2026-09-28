import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.mjs'
import { createApi } from './api.mjs'
import { sync } from './sync.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const APP_ROOT = resolve(here, '../..')
const DIST = join(APP_ROOT, 'dist/web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8">
<title>CUI — not built</title>
<style>body{font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:44rem;
margin:6rem auto;padding:0 1.5rem;background:#0d1117;color:#c9d1d9}
code{background:#161b22;padding:.15rem .4rem;border-radius:4px;color:#79c0ff}
h1{font-size:1.3rem}a{color:#79c0ff}</style>
<h1>The CUI web bundle is not built yet.</h1>
<p>Run <code>npm --prefix cui install &amp;&amp; npm --prefix cui run build</code>, then reload.</p>
<p>For live reload while developing the dashboard itself, use
<code>npm --prefix cui run dev</code>.</p>
<p>The API is already up: <a href="/api/overview">/api/overview</a></p>`

export function createServer(cfg) {
  const db = openDb(cfg)
  sync(db, cfg) // pick up YAML edits on every boot

  const app = new Hono()
  app.route('/api', createApi(db, cfg))

  app.get('*', (c) => {
    const urlPath = new URL(c.req.url).pathname
    if (existsSync(DIST)) {
      const candidate = resolve(DIST, '.' + urlPath)
      if (
        candidate.startsWith(DIST + sep) &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
      ) {
        const type = MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream'
        return new Response(readFileSync(candidate), { headers: { 'content-type': type } })
      }
      const index = join(DIST, 'index.html')
      if (existsSync(index)) {
        return c.html(readFileSync(index, 'utf8')) // SPA fallback
      }
    }
    return c.html(PLACEHOLDER)
  })

  return { app, db }
}

export function startServer(cfg, { dev = false, open = false } = {}) {
  const { app } = createServer(cfg)

  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '127.0.0.1' }, (info) => {
    const apiUrl = `http://localhost:${info.port}`
    if (dev) {
      const vite = spawn('npx', ['vite', '--port', '4318', '--strictPort'], {
        cwd: APP_ROOT, stdio: 'inherit', env: { ...process.env, CUI_API: apiUrl },
      })
      const stop = () => { vite.kill(); process.exit(0) }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      console.log(`\n  CUI api   ${apiUrl}`)
      console.log(`  CUI ui    http://localhost:4318  (vite, hot reload)\n`)
    } else {
      console.log(`\n  CUI  ${apiUrl}`)
      console.log(`  repo ${cfg.root}\n`)
      if (!existsSync(DIST)) {
        console.log('  note: web bundle not built — run `npm --prefix cui run build`\n')
      }
      if (open) spawn('open', [apiUrl], { stdio: 'ignore', detached: true }).unref()
    }
  })

  return server
}
