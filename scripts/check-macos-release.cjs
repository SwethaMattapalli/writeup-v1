'use strict'

if (process.platform !== 'darwin') {
  throw new Error(
    'macOS releases must be built on macOS so they can be Developer ID signed and notarized. ' +
    'Do not distribute cross-packed or ad-hoc-signed archives.'
  )
}

const required = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const missing = required.filter((name) => !process.env[name])
if (missing.length > 0) {
  throw new Error(
    `Missing notarization credentials: ${missing.join(', ')}. ` +
    'Set these Apple App Store Connect API key variables before building a macOS release.'
  )
}
