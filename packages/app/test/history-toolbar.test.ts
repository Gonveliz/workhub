import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { HistoryToolbar, type HistoryToolbarProps } from '../src/renderer/screens/HistoryScreen'

const noop = () => {}
const base: HistoryToolbarProps = {
  query: '',
  onQuery: noop,
  agent: '*',
  onAgent: noop,
  agents: [{ id: 'claude', name: 'Claude Code' }],
  profile: '*',
  onProfile: noop,
  profiles: [{ id: 'work', name: 'Work' }],
  account: '*',
  onAccount: noop,
  accounts: [{ id: 'a', name: 'Main' }],
  automations: false,
  hideAutomations: false,
  onHideAutomations: noop,
  loading: false,
  onRefresh: noop
}
const toolbar = (props: Partial<HistoryToolbarProps> = {}) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(HistoryToolbar, { ...base, ...props })))
const searchBox = (html: string) => /<div class="([^"]*)" data-testid="history-search-box">/.exec(html)?.[1] ?? ''

describe('the History search box and its filters', () => {
  it('shares its line with Refresh while there is nothing to filter by', () => {
    const html = toolbar()
    expect(searchBox(html)).toContain('flex-1')
    expect(searchBox(html)).not.toContain('basis-full')
    expect(html).not.toContain('history-hide-automations')
    for (const label of ['Agent', 'Profile', 'Account']) expect(html).not.toContain(`aria-label="${label}"`)
  })

  it('takes a line of its own as soon as one filter shows, so the filters never squeeze it', () => {
    for (const props of [
      { agents: [...base.agents, { id: 'codex', name: 'Codex' }] },
      { profiles: [...base.profiles, { id: 'home', name: 'Home' }] },
      { accounts: [...base.accounts, { id: 'b', name: 'Second' }] },
      { automations: true }
    ] satisfies Partial<HistoryToolbarProps>[]) {
      expect(searchBox(toolbar(props))).toContain('basis-full')
    }
  })

  it('keeps every filter with all of them showing, on a toolbar that wraps', () => {
    const html = toolbar({
      agents: [...base.agents, { id: 'codex', name: 'Codex' }],
      profiles: [...base.profiles, { id: 'home', name: 'Home' }],
      accounts: [...base.accounts, { id: 'b', name: 'Second' }],
      automations: true,
      hideAutomations: true
    })
    expect(html).toContain('flex-wrap')
    expect(searchBox(html)).toContain('basis-full')
    for (const label of ['Agent', 'Profile', 'Account']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('data-testid="history-hide-automations"')
    expect(html).toContain('aria-pressed="true"')
  })
})
