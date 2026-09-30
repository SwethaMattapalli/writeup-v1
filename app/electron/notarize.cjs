'use strict'

const path = require('path')
const { notarize } = require('@electron/notarize')

exports.default = async function notarizeApp(context) {
  if (process.platform !== 'darwin') {
    // Cross-compiling a mac build from Linux/Windows: no code signing happened
    // (electron-builder only signs on macOS), so there's nothing to notarize.
    return
  }

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  const missing = [
    ['APPLE_API_KEY', APPLE_API_KEY],
    ['APPLE_API_KEY_ID', APPLE_API_KEY_ID],
    ['APPLE_API_ISSUER', APPLE_API_ISSUER],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`Cannot notarize WriteUp: missing ${missing.join(', ')}`)
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  await notarize({
    appPath,
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  })
}
