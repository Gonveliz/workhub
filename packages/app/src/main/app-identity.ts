declare const __WORKHUB_APP_ID__: string | undefined

/** electron-builder's appId, from scripts/brand.mjs; tests run unbundled, without the build-time value. */
export const APP_ID = typeof __WORKHUB_APP_ID__ === 'string' ? __WORKHUB_APP_ID__ : 'com.example.workhub'

/**
 * The AppUserModelID the process should take on Windows, or undefined to keep Electron's default.
 *
 * Windows groups taskbar buttons by this id. The installer writes the appId into the shortcuts it
 * creates, so a pinned icon carries it; without the same id on the process, Electron makes one up
 * (`electron.app.<productName>`) and the app opens its own taskbar button next to the pin, which
 * shows most after an update relaunches it. A development build keeps Electron's id so it never
 * groups with an installed Workhub.
 */
export function windowsAppUserModelId(platform: NodeJS.Platform, packaged: boolean, appId: string = APP_ID): string | undefined {
  return platform === 'win32' && packaged ? appId : undefined
}
