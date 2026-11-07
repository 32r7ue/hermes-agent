import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const COMPOSER_PASTES_DIRNAME = 'composer-pastes'

/**
 * Persist a large plain-text paste as a `.txt` file the composer can attach
 * as a chip instead of flooding the input. The renderer never chooses the
 * path: the file lands in a Desktop-managed directory with a generated name,
 * mirroring how `writeComposerImage` handles pasted images.
 *
 * `hermesHome` must be the HERMES_HOME root, not Electron's userData dir: the
 * backend admits `@file:` attachments outside the chat's cwd only from
 * `<HERMES_HOME>/composer-pastes` (agent/context_references.py::_resolve_path),
 * and on Linux/macOS userData is a different tree (#117149).
 */
export async function writeComposerPaste(hermesHome: string, text: string): Promise<string> {
  const dir = path.join(hermesHome, COMPOSER_PASTES_DIRNAME)
  await fs.promises.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const random = crypto.randomBytes(3).toString('hex')
  const filePath = path.join(dir, `pasted_content_${stamp}_${random}.txt`)
  await fs.promises.writeFile(filePath, text, 'utf8')

  return filePath
}

const PASTE_FILE_RE = /^pasted_content_[\w-]+\.txt$/

/**
 * A sent message names its paste the way the backend took it — often relative
 * (`.hermes/composer-pastes/pasted_content_….txt`, against the chat's cwd). Every
 * paste lives in `<HERMES_HOME>/composer-pastes`, so its file name alone finds it.
 * Null for anything that is not a paste file name.
 */
export function resolveComposerPastePath(hermesHome: string, filePath: string): null | string {
  const name = path.basename(filePath)

  return PASTE_FILE_RE.test(name) && !path.isAbsolute(filePath)
    ? path.join(hermesHome, COMPOSER_PASTES_DIRNAME, name)
    : null
}
