// Cursor's chat cues as data URIs (~390 KB). Imported only via dynamic import from
// sample-sounds.ts, so the bytes ride a lazy chunk, never the main bundle, and the
// packaged file:// renderer decodes them from memory — no fetch, no disk read.
//
// done1 is Cursor's own agent-finished chime; the rest are VS Code's (MIT) chat
// accessibility signals that Cursor ships unchanged.
import fileEdited from '@/assets/sounds/cursor/chatEditModifiedFile.mp3?inline'
import done from '@/assets/sounds/cursor/done1.mp3?inline'
import editsKept from '@/assets/sounds/cursor/editsKept.mp3?inline'
import editsUndone from '@/assets/sounds/cursor/editsUndone.mp3?inline'
import progress from '@/assets/sounds/cursor/progress.mp3?inline'
import requestSent from '@/assets/sounds/cursor/requestSent.mp3?inline'
import response1 from '@/assets/sounds/cursor/responseReceived1.mp3?inline'
import response2 from '@/assets/sounds/cursor/responseReceived2.mp3?inline'
import response3 from '@/assets/sounds/cursor/responseReceived3.mp3?inline'
import response4 from '@/assets/sounds/cursor/responseReceived4.mp3?inline'

import type { SampleSoundId } from './sample-sounds'

export const SAMPLE_SOUND_DATA: Record<SampleSoundId, string> = {
  cursorDone: done,
  cursorEditsKept: editsKept,
  cursorEditsUndone: editsUndone,
  cursorFileEdited: fileEdited,
  cursorProgress: progress,
  cursorRequestSent: requestSent,
  cursorResponse1: response1,
  cursorResponse2: response2,
  cursorResponse3: response3,
  cursorResponse4: response4
}
