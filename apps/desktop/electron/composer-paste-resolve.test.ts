import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveComposerPastePath } from './composer-paste'

describe('resolveComposerPastePath', () => {
  const home = '/home/u/.hermes'

  it('finds a relatively-named paste in HERMES_HOME/composer-pastes', () => {
    expect(resolveComposerPastePath(home, '.hermes/composer-pastes/pasted_content_2026-11-07_19-57-07-688_b7a286.txt')).toBe(
      path.join(home, 'composer-pastes', 'pasted_content_2026-11-07_19-57-07-688_b7a286.txt')
    )
  })

  it('leaves absolute paths and ordinary files alone', () => {
    expect(resolveComposerPastePath(home, '/tmp/pasted_content_x.txt')).toBeNull()
    expect(resolveComposerPastePath(home, 'notes/readme.txt')).toBeNull()
  })
})
