#!/usr/bin/env node
/**
 * SailFish CLI Entry Point
 * 
 * This file MUST be plain JavaScript (.js) because it needs to register
 * the Electron API shim via Module._resolveFilename BEFORE any TypeScript
 * imports are processed. TypeScript/ESM import hoisting would otherwise
 * cause service modules to load the real 'electron' package and fail.
 * 
 * Usage:
 *   node electron/cli/main.js <command> [options]
 *   npm run cli -- <command> [options]
 */
'use strict'

const Module = require('module')
const path = require('path')

// ==================== Step 1: Register Electron Shim ====================
// This MUST happen before any other require/import that might trigger
// a transitive import of 'electron' (e.g., electron-store, services)

const shimPath = path.join(__dirname, 'electron-shim.js')
const origResolve = Module._resolveFilename

Module._resolveFilename = function(request, parent, isMain, options) {
  // Intercept all electron-related imports
  if (request === 'electron') {
    return shimPath
  }
  // electron-updater is only used in main.ts, not in services,
  // but intercept it just in case for safety
  if (request === 'electron-updater') {
    return shimPath
  }
  return origResolve.call(this, request, parent, isMain, options)
}

// ==================== Step 2: Set CLI Environment ====================

process.env.SFT_CLI_MODE = '1'

// ==================== Step 3: Register TypeScript Support ====================

try {
  require('tsx/cjs')
} catch (e) {
  // Fallback: try ts-node
  try {
    require('ts-node/register/transpile-only')
  } catch (e2) {
    console.error(
      'Error: TypeScript support is required for CLI mode.\n' +
      'Please install tsx: npm install -D tsx\n' +
      'Or ts-node:       npm install -D ts-node'
    )
    process.exit(1)
  }
}

// ==================== Step 4: Run CLI ====================

require('./index.ts')
