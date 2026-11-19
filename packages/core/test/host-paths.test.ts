import { describe, expect, it } from 'vitest'
import {
  basenameFlavorPath,
  dirnameFlavorPath,
  isAbsoluteFlavorPath,
  joinFlavorPath,
  normalizeFlavorPath,
  posixToWslUnc,
  wslUncToPosix
} from '../src'

describe('posix paths', () => {
  it('joins and normalizes', () => {
    expect(joinFlavorPath('posix', '/home/user', 'work', 'acme')).toBe('/home/user/work/acme')
    expect(joinFlavorPath('posix', '/home/user/', '/work//acme/')).toBe('/home/user/work/acme')
    expect(joinFlavorPath('posix', 'work', '../acme', './api')).toBe('acme/api')
    expect(joinFlavorPath('posix')).toBe('.')
    expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d')
    expect(normalizePath('/../../etc')).toBe('/etc')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('../a/../../b')).toBe('../../b')
    expect(normalizePath('a/..')).toBe('.')
    expect(normalizePath('')).toBe('.')
  })

  it('treats backslashes as ordinary characters', () => {
    expect(normalizePath('/a\\b/c')).toBe('/a\\b/c')
    expect(basenameFlavorPath('posix', '/a\\b')).toBe('a\\b')
  })

  it('tells absolute from relative', () => {
    expect(isAbsoluteFlavorPath('posix', '/home/user')).toBe(true)
    expect(isAbsoluteFlavorPath('posix', 'home/user')).toBe(false)
    expect(isAbsoluteFlavorPath('posix', 'C:\\Users')).toBe(false)
  })

  it('takes dirname and basename', () => {
    expect(dirnameFlavorPath('posix', '/home/user/work/acme')).toBe('/home/user/work')
    expect(dirnameFlavorPath('posix', '/home/user/work/acme/')).toBe('/home/user/work')
    expect(dirnameFlavorPath('posix', '/home')).toBe('/')
    expect(dirnameFlavorPath('posix', '/')).toBe('/')
    expect(dirnameFlavorPath('posix', 'acme')).toBe('.')
    expect(basenameFlavorPath('posix', '/home/user/work/acme/')).toBe('acme')
    expect(basenameFlavorPath('posix', '/')).toBe('')
  })

  it('gives an empty path no basename, in either flavor', () => {
    expect(basenameFlavorPath('posix', '')).toBe('')
    expect(basenameFlavorPath('win32', '')).toBe('')
    expect(dirnameFlavorPath('posix', '')).toBe('.')
    expect(dirnameFlavorPath('win32', '')).toBe('.')
  })

  const normalizePath = (p: string) => normalizeFlavorPath('posix', p)
})

describe('win32 paths', () => {
  it('joins with backslashes and accepts either separator', () => {
    expect(joinFlavorPath('win32', 'C:\\Users\\user', 'work/acme')).toBe('C:\\Users\\user\\work\\acme')
    expect(joinFlavorPath('win32', 'C:/Users/', '\\user\\\\work')).toBe('C:\\Users\\user\\work')
  })

  it('normalizes without escaping the drive or share root', () => {
    expect(normalizeFlavorPath('win32', 'C:\\a\\..\\..\\b')).toBe('C:\\b')
    expect(normalizeFlavorPath('win32', 'c:/')).toBe('c:\\')
    expect(normalizeFlavorPath('win32', '\\\\server\\share\\a\\..\\..\\b')).toBe('\\\\server\\share\\b')
    expect(normalizeFlavorPath('win32', '//server/share')).toBe('\\\\server\\share\\')
    expect(normalizeFlavorPath('win32', 'a\\.\\b\\..')).toBe('a')
  })

  it('tells absolute from relative', () => {
    expect(isAbsoluteFlavorPath('win32', 'C:\\Users')).toBe(true)
    expect(isAbsoluteFlavorPath('win32', 'c:/Users')).toBe(true)
    expect(isAbsoluteFlavorPath('win32', '\\\\wsl.localhost\\Ubuntu')).toBe(true)
    expect(isAbsoluteFlavorPath('win32', '\\Users')).toBe(true)
    expect(isAbsoluteFlavorPath('win32', 'C:Users')).toBe(false)
    expect(isAbsoluteFlavorPath('win32', 'Users\\user')).toBe(false)
  })

  it('takes dirname and basename', () => {
    expect(dirnameFlavorPath('win32', 'C:\\Users\\user\\acme')).toBe('C:\\Users\\user')
    expect(dirnameFlavorPath('win32', 'C:\\Users')).toBe('C:\\')
    expect(dirnameFlavorPath('win32', 'C:\\')).toBe('C:\\')
    expect(dirnameFlavorPath('win32', '\\\\server\\share\\a')).toBe('\\\\server\\share\\')
    expect(basenameFlavorPath('win32', 'C:\\Users\\user\\acme.txt')).toBe('acme.txt')
    expect(basenameFlavorPath('win32', 'C:/Users/user/')).toBe('user')
  })
})

describe('WSL UNC paths', () => {
  it('maps both host spellings, either separator and any case to the distro path', () => {
    const want = { distro: 'Ubuntu', path: '/home/user/work/acme' }
    expect(wslUncToPosix('\\\\wsl.localhost\\Ubuntu\\home\\user\\work\\acme')).toEqual(want)
    expect(wslUncToPosix('\\\\wsl$\\Ubuntu\\home\\user\\work\\acme')).toEqual(want)
    expect(wslUncToPosix('//wsl.localhost/Ubuntu/home/user/work/acme')).toEqual(want)
    expect(wslUncToPosix('\\\\WSL.LocalHost\\Ubuntu\\home\\user\\work\\acme\\')).toEqual(want)
    expect(wslUncToPosix('\\\\WSL$/Ubuntu/home//user/./work/acme')).toEqual(want)
  })

  it('maps the distro root to /', () => {
    expect(wslUncToPosix('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' })
    expect(wslUncToPosix('\\\\wsl.localhost\\Ubuntu\\')).toEqual({ distro: 'Ubuntu', path: '/' })
  })

  it('keeps distro names with dots and dashes', () => {
    expect(wslUncToPosix('\\\\wsl.localhost\\Ubuntu-24.04\\tmp')).toEqual({ distro: 'Ubuntu-24.04', path: '/tmp' })
  })

  it('returns null for anything that is not a WSL UNC path', () => {
    for (const p of ['\\\\server\\share\\a', '\\\\wsl.localhost', '\\\\wsl.localhost\\', 'C:\\Users', '/home/user', '\\\\wsl.localhostx\\Ubuntu', '\\\\wsl.localhost\\Ubuntu\\..\\Other']) {
      expect(wslUncToPosix(p), p).toBeNull()
    }
  })

  it('builds a UNC path from a distro and an absolute posix path', () => {
    expect(posixToWslUnc('Ubuntu', '/home/user/work/acme')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\work\\acme')
    expect(posixToWslUnc('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
    expect(posixToWslUnc('Ubuntu-24.04', '/a//b/../c')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\a\\c')
  })

  it('rejects relative posix paths and bad distro names', () => {
    expect(() => posixToWslUnc('Ubuntu', 'home/user')).toThrow(/absolute/)
    expect(() => posixToWslUnc('', '/home')).toThrow(/distro/)
    expect(() => posixToWslUnc('a\\b', '/home')).toThrow(/distro/)
  })

  it('round-trips', () => {
    for (const path of ['/', '/home/user', '/home/user/work/acme/api']) {
      expect(wslUncToPosix(posixToWslUnc('Ubuntu', path))).toEqual({ distro: 'Ubuntu', path })
    }
  })
})
