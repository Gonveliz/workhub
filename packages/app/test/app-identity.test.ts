import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { windowsAppUserModelId } from '../src/main/app-identity'

describe('windowsAppUserModelId', () => {
  it('gives an installed Windows app the installer id, so it groups with its pinned taskbar icon', () => {
    expect(windowsAppUserModelId('win32', true, 'com.example.app')).toBe('com.example.app')
  })

  it('leaves a development build on Electron default id, apart from an installed app', () => {
    expect(windowsAppUserModelId('win32', false, 'com.example.app')).toBeUndefined()
  })

  it('does nothing on macOS and Linux', () => {
    expect(windowsAppUserModelId('darwin', true, 'com.example.app')).toBeUndefined()
    expect(windowsAppUserModelId('linux', true, 'com.example.app')).toBeUndefined()
  })

  it('builds the main process with the same app id electron-builder writes into the shortcuts', () => {
    const viteConfig = readFileSync(new URL('../electron.vite.config.ts', import.meta.url), 'utf8')
    const builderConfig = readFileSync(new URL('../electron-builder.config.mjs', import.meta.url), 'utf8')
    expect(viteConfig).toContain('__WORKHUB_APP_ID__: JSON.stringify(BRAND.appId)')
    expect(builderConfig).toContain('appId: BRAND.appId')
  })
})
