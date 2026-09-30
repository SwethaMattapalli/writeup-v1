'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { EventEmitter } = require('events')
const { app } = require('electron')

const BACKEND_PORT = 8090
const LOCAL_URL = `http://127.0.0.1:${BACKEND_PORT}`
const HEALTH_URL = `${LOCAL_URL}/health`

/** Hosted backend URL from electron/config.json (or WRITEUP_BACKEND_URL). Empty = local Python. */
function readRemoteUrl() {
  let url = process.env.WRITEUP_BACKEND_URL || ''
  if (!url) {
    try {
      url = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).backendUrl || ''
    } catch {
      // no config.json → local mode
    }
  }
  return String(url).trim().replace(/\/+$/, '')
}

class BackendManager extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.python = null
    this._waitingForKey = null
    this._running = false
    this.state = {
      stage: 'idle',
      message: '',
      detail: '',
      ready: false,
      port: BACKEND_PORT,
    }
    this.remote = readRemoteUrl()
  }

  isRemote() {
    return Boolean(this.remote)
  }

  /** What the widget needs to call the backend (remote or local). */
  clientConfig() {
    if (!this.isRemote()) return { url: LOCAL_URL, accessKey: '' }
    return { url: this.remote, accessKey: this.readMergedEnv().WRITEUP_ACCESS_KEY || '' }
  }

  userData() {
    return app.getPath('userData')
  }

  bundledBackendDir() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'backend')
    }
    return path.join(__dirname, '../../backend')
  }

  runtimeDir() {
    return path.join(this.userData(), 'backend')
  }

  venvDir() {
    return path.join(this.userData(), 'venv')
  }

  venvPython() {
    return process.platform === 'win32'
      ? path.join(this.venvDir(), 'Scripts', 'python.exe')
      : path.join(this.venvDir(), 'bin', 'python')
  }

  envFile() {
    return path.join(this.userData(), '.env')
  }

  stampFile() {
    return path.join(this.userData(), 'deps.stamp')
  }

  logFile() {
    return path.join(this.userData(), 'backend.log')
  }

  _set(stage, message, extra = {}) {
    this.state = {
      ...this.state,
      stage,
      message,
      detail: extra.detail || '',
      ready: stage === 'ready',
      ...extra,
    }
    this.emit('progress', { ...this.state })
  }

  readMergedEnv() {
    const env = {}
    const bundledEnv = path.join(this.bundledBackendDir(), '.env')
    if (fs.existsSync(bundledEnv)) Object.assign(env, parseEnvFile(bundledEnv))
    if (fs.existsSync(this.envFile())) Object.assign(env, parseEnvFile(this.envFile()))
    Object.assign(env, {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '',
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || '',
    })
    return env
  }

  hasLlmConfig() {
    const env = this.readMergedEnv()
    return Boolean((env.OLLAMA_BASE_URL || '').trim() || (env.OPENROUTER_API_KEY || '').trim())
  }

  hasApiKey() {
    return this.hasLlmConfig()
  }

  mergeUserEnv(updates) {
    fs.mkdirSync(this.userData(), { recursive: true })
    const existing = fs.existsSync(this.envFile()) ? parseEnvFile(this.envFile()) : {}
    Object.assign(existing, updates)
    writeEnvFile(this.envFile(), existing)
  }

  finishConfigWait(value) {
    if (this._waitingForKey) {
      const resolve = this._waitingForKey
      this._waitingForKey = null
      resolve(value)
    }
  }

  saveApiKey(key) {
    const trimmed = String(key || '').trim()
    if (!trimmed) throw new Error('API key is empty')
    this.mergeUserEnv({
      OPENROUTER_API_KEY: trimmed,
      OPENROUTER_MODEL: 'openai/gpt-4o-mini',
    })
    this.finishConfigWait(trimmed)
    return true
  }

  saveAccessKey(key) {
    const trimmed = String(key || '').trim()
    if (!trimmed) throw new Error('Access key is empty')
    this.mergeUserEnv({ WRITEUP_ACCESS_KEY: trimmed })
    this.finishConfigWait(trimmed)
    return true
  }

  saveLlmSettings(cfg = {}) {
    const provider = cfg.provider === 'openrouter' ? 'openrouter' : 'ollama'
    if (provider === 'ollama') {
      const url = String(cfg.ollamaUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '')
      const model = String(cfg.ollamaModel || 'qwen3').trim()
      if (!url) throw new Error('Ollama URL is empty')
      if (!model) throw new Error('Ollama model name is empty')
      this.mergeUserEnv({
        OLLAMA_BASE_URL: url,
        OLLAMA_MODEL: model,
      })
      this.finishConfigWait(url)
      return true
    }
    return this.saveApiKey(cfg.apiKey)
  }

  waitForApiKey() {
    return new Promise((resolve) => {
      this._waitingForKey = resolve
    })
  }

  backendEnv() {
    const env = { ...process.env }
    const sources = []
    const bundledEnv = path.join(this.bundledBackendDir(), '.env')
    if (fs.existsSync(bundledEnv)) sources.push(bundledEnv)
    if (fs.existsSync(this.envFile())) sources.push(this.envFile())
    for (const file of sources) {
      Object.assign(env, parseEnvFile(file))
    }
    env.WRITEUP_ENV_FILE = fs.existsSync(this.envFile()) ? this.envFile() : (sources[0] || '')
    env.WRITEUP_DB_PATH = path.join(this.userData(), 'interactions.db')
    env.PYTHONUNBUFFERED = '1'
    return env
  }

  async isHealthy() {
    return await httpOk(HEALTH_URL)
  }

  async detectOllama() {
    const urls = ['http://127.0.0.1:11434', 'http://localhost:11434']
    for (const url of urls) {
      const data = await httpGetJson(`${url}/api/tags`, 1500)
      const models = (data && data.models ? data.models : [])
        .map((m) => m && m.name)
        .filter(Boolean)
      if (!models.length) continue
      const preferred = process.env.OLLAMA_MODEL || ''
      const model =
        models.find((name) => name === preferred) ||
        models.find((name) => /qwen/i.test(name)) ||
        models[0]
      return { url, model, models }
    }
    return null
  }

  async setupAndStart() {
    if (this._running) return this.state
    this._running = true
    try {
      if (this.isRemote()) return await this.connectRemote()

      if (await this.isHealthy()) {
        const llmOk = await this.probeLlmConfig()
        if (!llmOk) {
          this._set('error', 'Backend is up but no LLM is configured.', {
            detail: 'Start Ollama or add an OpenRouter key, then click Retry.',
          })
          return this.state
        }
        this._set('ready', `Backend already running on port ${BACKEND_PORT}.`)
        return this.state
      }

      const venvReady = fs.existsSync(this.venvPython())
      if (venvReady) {
        this._set('python', 'Using the existing WriteUp Python environment…')
        this.copyBackendFiles()
        await this.ensureDeps()
      } else {
        this._set('python', 'Looking for Python 3…')
        this.python = await findPythonWithRetry((msg) => this._set('python', msg))
        if (!this.python) {
          this._set('error', 'Python 3 was not found.', { detail: pythonInstallHint() })
          return this.state
        }
        this._set('python', `Found ${this.python.label}`)

        this._set('copy', 'Installing application files…')
        this.copyBackendFiles()

        this._set('venv', 'Creating Python virtual environment…')
        await this.ensureVenv()

        this._set('deps', 'Installing backend packages (first launch may take a minute)…')
        await this.ensureDeps()
      }

      if (!this.hasLlmConfig()) {
        const ollama = await this.detectOllama()
        if (ollama) {
          this.mergeUserEnv({
            OLLAMA_BASE_URL: ollama.url,
            OLLAMA_MODEL: ollama.model,
          })
          this._set('start', `Found local Ollama (${ollama.model}). Connecting…`)
        } else {
          this._set('apikey', 'Choose local Ollama or an OpenRouter API key.')
          await this.waitForApiKey()
        }
      }

      await this.ensureOllama()
      this._set('start', 'Starting WriteUp backend…')
      await this.startWithRetries()
      this._set('ready', 'WriteUp is ready. Press Ctrl+Shift+G (Cmd+Shift+G on Mac) after selecting text.')
      return this.state
    } catch (err) {
      this._set('error', err.message || String(err), { detail: err.detail || '' })
      return this.state
    } finally {
      this._running = false
    }
  }

  /** Hosted backend: no Python, venv or Ollama on this computer — just an access key. */
  async connectRemote() {
    this._set('start', 'Connecting to WriteUp server…', { detail: this.remote })
    // Render's free tier sleeps when idle; waking it can take ~50 s.
    const up = await waitFor(() => httpOk(`${this.remote}/health`, 10000), 90000, 2000)
    if (!up) {
      this._set('error', 'Could not reach the WriteUp server.', {
        detail: `${this.remote}\nCheck your internet connection, then click Retry.`,
      })
      return this.state
    }
    // Server without WRITEUP_ACCESS_KEYS accepts anyone — don't ask for a key.
    const open = !this.clientConfig().accessKey &&
      (await httpStatus(`${this.remote}/suggest-mode?text=`, '')) === 200
    while (!open) {
      const { accessKey } = this.clientConfig()
      if (accessKey) {
        const status = await httpStatus(`${this.remote}/suggest-mode?text=`, accessKey)
        if (status === 200) break
        if (status !== 401) {
          this._set('error', `WriteUp server returned ${status || 'no response'}.`, { detail: this.remote })
          return this.state
        }
        this._set('accesskey', 'That access key was not accepted. Check it and try again.')
      } else {
        this._set('accesskey', 'Enter the WriteUp access key you were given.')
      }
      await this.waitForApiKey()
    }
    this._set('ready', 'WriteUp is ready. Press Ctrl+Shift+G (Cmd+Shift+G on Mac) after selecting text.')
    return this.state
  }

  /** After reboot, /health alone is not enough — confirm LLM env or live Ollama. */
  async probeLlmConfig() {
    if (this.hasLlmConfig()) return true
    const ollama = await this.detectOllama()
    if (ollama) {
      this.mergeUserEnv({
        OLLAMA_BASE_URL: ollama.url,
        OLLAMA_MODEL: ollama.model,
      })
      return true
    }
    return false
  }

  copyBackendFiles() {
    const src = this.bundledBackendDir()
    const dest = this.runtimeDir()
    if (!fs.existsSync(src)) {
      throw Object.assign(new Error('Backend files are missing from this install.'), {
        detail: `Expected files in ${src}`,
      })
    }
    fs.mkdirSync(dest, { recursive: true })
    for (const name of fs.readdirSync(src)) {
      if (!name.endsWith('.py') && name !== 'requirements.txt') continue
      fs.copyFileSync(path.join(src, name), path.join(dest, name))
    }
    const req = path.join(dest, 'requirements.txt')
    if (!fs.existsSync(req)) {
      throw new Error('requirements.txt was not bundled with the app.')
    }
  }

  async ensureVenv() {
    const py = this.venvPython()
    if (fs.existsSync(py)) return
    fs.mkdirSync(this.userData(), { recursive: true })
    await run(this.python.cmd, [...this.python.prefixArgs, '-m', 'venv', this.venvDir()], {
      cwd: this.userData(),
    }).catch((err) => {
      throw Object.assign(new Error('Could not create a Python virtual environment.'), {
        detail: `${err.message}\n${pythonVenvHint()}`,
      })
    })
    if (!fs.existsSync(py)) {
      throw new Error('Virtual environment was created but Python is missing inside it.')
    }
  }

  async ensureDeps() {
    const reqPath = path.join(this.runtimeDir(), 'requirements.txt')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex')
    if (fs.existsSync(this.stampFile()) && fs.readFileSync(this.stampFile(), 'utf8').trim() === hash) {
      return
    }
    const py = this.venvPython()
    await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: this.runtimeDir() }, (line) => {
      this._set('deps', 'Updating pip…', { detail: line })
    }).catch(() => {
      // Older embeddable Pythons can fail pip upgrade; continue with existing pip.
    })
    await run(
      py,
      ['-m', 'pip', 'install', '-r', reqPath],
      { cwd: this.runtimeDir() },
      (line) => this._set('deps', 'Installing backend packages…', { detail: lastLine(line) }),
    ).catch((err) => {
      throw Object.assign(new Error('Failed to install Python packages.'), {
        detail: err.message,
      })
    })
    fs.writeFileSync(this.stampFile(), hash)
  }

  async start() {
    if (this.child && !this.child.killed) return
    if (await this.isHealthy()) return

    const py = this.venvPython()
    const out = fs.createWriteStream(this.logFile(), { flags: 'a' })
    this.child = spawn(
      py,
      ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)],
      {
        cwd: this.runtimeDir(),
        env: this.backendEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.child.stdout.on('data', (d) => out.write(d))
    this.child.stderr.on('data', (d) => out.write(d))
    this.child.on('exit', (code) => {
      out.end()
      this.child = null
      if (this.state.stage === 'ready' || this.state.stage === 'start') {
        this._set('error', `Backend exited unexpectedly (code ${code}).`, {
          detail: `See log: ${this.logFile()}`,
        })
      }
    })

    const ok = await waitFor(() => this.isHealthy(), 60000, 250)
    if (!ok) {
      this.stop()
      throw Object.assign(new Error('Backend did not become healthy in time.'), {
        detail: `Check ${this.logFile()}`,
      })
    }
  }

  async startWithRetries(attempts = 4) {
    let lastErr = null
    for (let i = 0; i < attempts; i++) {
      try {
        await this.start()
        return
      } catch (err) {
        lastErr = err
        this._set('start', `Waiting for the backend after login (${i + 1}/${attempts})…`)
        await sleep(2500)
      }
    }
    throw lastErr
  }

  async ensureOllama() {
    const env = this.readMergedEnv()
    const url = String(env.OLLAMA_BASE_URL || '').trim()
    if (!url) return
    if (!/127\.0\.0\.1|localhost/i.test(url)) return
    if (await this.detectOllama()) return

    this._set('start', 'Starting local Ollama…')
    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      child.unref()
    } catch (err) {
      this._set('start', `Could not start Ollama automatically: ${err.message}`)
    }
    await waitFor(() => this.detectOllama().then(Boolean), 25000, 500)
  }

  stop() {
    const child = this.child
    this.child = null
    if (!child || child.killed) return
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }
}

function parseEnvFile(file) {
  const out = {}
  const text = fs.readFileSync(file, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function writeEnvFile(file, data) {
  const lines = Object.entries(data).map(([k, v]) => `${k}=${v}`)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

function lastLine(chunk) {
  const lines = String(chunk).trim().split(/\r?\n/)
  return lines[lines.length - 1] || ''
}

function pythonInstallHint() {
  if (process.platform === 'win32') {
    return 'Install Python 3.10+ from https://www.python.org/downloads/windows/ and tick "Add python.exe to PATH", then click Retry.'
  }
  if (process.platform === 'darwin') {
    return 'Install Python 3 from https://www.python.org/downloads/macos/ or `brew install python`, then click Retry.'
  }
  return 'Install Python 3 and venv, then click Retry:\n  sudo apt install python3 python3-venv python3-pip'
}

function pythonVenvHint() {
  if (process.platform === 'linux') {
    return 'On Debian/Ubuntu also install: sudo apt install python3-venv python3-pip'
  }
  return 'Reinstall Python from python.org and make sure pip/venv are included.'
}

function run(cmd, args, opts = {}, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const take = (buf) => {
      const s = buf.toString()
      out += s
      if (onData) onData(s)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(out.trim() || `${cmd} exited with code ${code}`))
    })
  })
}

function tryPython(cmd, prefixArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...prefixArgs, '--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const text = out.trim()
      const storeStub = /Microsoft Store|was not found|Python was not found/i.test(text)
      if (code === 0 && /Python 3\./i.test(text) && !storeStub) {
        resolve({ cmd, prefixArgs, label: text.split(/\r?\n/)[0] })
      } else {
        resolve(null)
      }
    })
  })
}

function windowsPythonPaths() {
  const paths = []
  const roots = []
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'))
  }
  if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles)
  if (process.env['ProgramFiles(x86)']) roots.push(process.env['ProgramFiles(x86)'])
  roots.push('C:\\')
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^Python3\d+$/i.test(name) && !/^python$/i.test(name)) continue
      const exe = path.join(root, name, 'python.exe')
      if (fs.existsSync(exe)) paths.push(exe)
    }
  }
  return paths
}

async function findPython() {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(['py', ['-3']], ['python', []], ['python3', []])
    for (const exe of windowsPythonPaths()) candidates.push([exe, []])
  } else {
    candidates.push(['python3', []], ['python', []])
  }
  for (const [cmd, prefixArgs] of candidates) {
    const found = await tryPython(cmd, prefixArgs)
    if (found) return found
  }
  return null
}

async function findPythonWithRetry(onProgress, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const found = await findPython()
    if (found) return found
    if (onProgress) onProgress(`Waiting for Python after login (${i + 1}/${attempts})…`)
    await sleep(2000)
  }
  return null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function httpFor(url) {
  return url.startsWith('https:') ? https : http
}

function httpOk(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = httpFor(url).get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Status code of an authenticated GET, or 0 on network error. */
function httpStatus(url, accessKey, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = httpFor(url).get(
      url,
      { timeout: timeoutMs, headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {} },
      (res) => {
        res.resume()
        resolve(res.statusCode || 0)
      },
    )
    req.on('error', () => resolve(0))
    req.on('timeout', () => {
      req.destroy()
      resolve(0)
    })
  })
}

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = httpFor(url).get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) {
          req.destroy()
          resolve(null)
        }
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

async function waitFor(fn, timeoutMs, intervalMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

module.exports = { BackendManager, BACKEND_PORT }
