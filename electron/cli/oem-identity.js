/* eslint-env node */
'use strict'

const path = require('path')

const DEFAULTS = {
  productName: 'SailFish',
  dataDirName: 'SailFish',
  cliName: 'sailfish',
  appId: 'com.sfterm.terminal',
}

function readOemIdentity() {
  try {
    try { require('tsx/cjs') } catch { /* 已注册，或当前环境没有 tsx */ }
    const { oemResolved } = require(path.join(__dirname, '../../shared/oem-resolve.ts'))
    const id = oemResolved && oemResolved.identity
    if (!id) return { ...DEFAULTS }
    return {
      productName: id.productName || DEFAULTS.productName,
      dataDirName: id.dataDirName || DEFAULTS.dataDirName,
      cliName: id.cliName || DEFAULTS.cliName,
      appId: id.appId || DEFAULTS.appId,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

module.exports = { readOemIdentity }
