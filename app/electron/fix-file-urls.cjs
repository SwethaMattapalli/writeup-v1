'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '../build')

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(html|js|css)$/.test(ent.name)) continue
    const original = fs.readFileSync(full, 'utf8')
    const next = original
      .replace(/(["'`])\/_app\//g, '$1./_app/')
      .replace(/(["'`])\/favicon\.png/g, '$1./favicon.png')
    if (next !== original) {
      fs.writeFileSync(full, next)
      console.log('[WriteUp] relative URLs:', path.relative(root, full))
    }
  }
}

if (fs.existsSync(root)) walk(root)
