import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { OTHER_SUBPAGES } from '../settings/other-subpages'
import { settingsPageEntries, settingsSubviewEntries, SUBPAGE_KEYWORDS } from '../settings/settings-pages'
import type { SettingsSearchEntry } from '../settings/settings-search'
import { settingsSubpageLabel } from '../settings/subpages'

import { rankGroups, type RankableItem } from './rank'

// Mirrors the palette's settings rows (command-palette/index.tsx): pages get
// PAGE_BOOST, sub-pages SUBPAGE_BOOST, and every row's keywords carry its
// context + description so labels, descriptions and synonyms all match.
interface Row extends RankableItem {
  id: string
}

const row = (entry: SettingsSearchEntry, boost?: number): Row => ({
  boost,
  id: entry.id,
  keywords: [entry.context, entry.description ?? '', ...entry.keywords],
  label: entry.label
})

const options = { localModelsEnabled: true, webAccessAvailable: true }

const subpageRows: Row[] = Object.entries(OTHER_SUBPAGES).flatMap(([view, pages]) =>
  pages.map(page => ({
    boost: 0.03,
    id: `settings-page:${view}:${page.id}`,
    keywords: [view, page.id, ...(SUBPAGE_KEYWORDS[page.labelKey] ?? [])],
    label: settingsSubpageLabel(page, en)
  }))
)

const groups = [
  { heading: 'Settings', items: settingsPageEntries(en, options).map(entry => row(entry, 0.06)) },
  {
    heading: 'Fields',
    items: [
      ...subpageRows,
      ...settingsSubviewEntries(en, options).map(entry => row(entry)),
      // A same-named field must not beat the page it lives on.
      { id: 'config-field:tts.provider', keywords: ['voice'], label: 'Provider' }
    ]
  }
]

const top = (query: string) => rankGroups(groups, query)[0]?.items[0]?.id

describe('settings search ranking (⌘K and the Settings-scoped palette)', () => {
  it('jumps to a page by its own name, exact/prefix title first', () => {
    expect(top('provider')).toBe('settings-view:providers')
    expect(top('providers')).toBe('settings-view:providers')
    expect(top('prov')).toBe('settings-view:providers')
    expect(top('appearance')).toBe('settings-view:config:appearance')
    expect(top('capabilities')).toBe('settings-view:capabilities')
  })

  it('finds pages by synonyms', () => {
    expect(top('api key')).toMatch(/^settings-view:providers/)
    expect(top('sound')).toMatch(/notification/i)
    expect(top('theme')).toMatch(/appearance/i)
  })

  it('indexes the moved Capabilities tabs', () => {
    expect(top('skills')).toBe('settings-page:capabilities:skills')
    expect(top('connectors')).toBe('settings-page:capabilities:connectors')
    expect(top('mcp')).toMatch(/capabilities/)
    expect(top('plugins')).toMatch(/plugins/)
  })
})
