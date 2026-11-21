// Recorded UI cues (Cursor's chat sounds), tuned for the lowest trigger-to-ear
// latency WebAudio allows:
//
// - Decoded once, ahead of time, into AudioBuffers held in memory. Playing is one
//   AudioBufferSourceNode started at `currentTime` — no fetch, no decode, no
//   scheduling offset on the hot path.
// - Leading silence is cut at decode time. VS Code's MP3s open with 56–200 ms of
//   near-silence before the transient; trimming it is the single largest latency
//   win and leaves every audible sample untouched.
// - The source goes straight to the destination at unity gain: no filter, no
//   reverb, no resampling beyond the one decodeAudioData already does.
// - warmSampleSounds() also creates the shared AudioContext early, so the output
//   device is already open when the first cue fires.

import { getAudioContext } from '@/lib/audio-context'

export type SampleSoundId =
  | 'cursorDone'
  | 'cursorEditsKept'
  | 'cursorEditsUndone'
  | 'cursorFileEdited'
  | 'cursorProgress'
  | 'cursorRequestSent'
  | 'cursorResponse1'
  | 'cursorResponse2'
  | 'cursorResponse3'
  | 'cursorResponse4'

// Anything under 0.5% of the clip's peak (≈ −46 dB) before the first transient is
// treated as lead-in silence. A short pre-roll with a linear fade keeps the
// attack intact and the cut click-free.
const SILENCE_RATIO = 0.005
const PRE_ROLL_SECONDS = 0.003

const buffers = new Map<SampleSoundId, AudioBuffer>()
let loading: Promise<void> | null = null

export function trimLeadingSilence(ac: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  let peak = 0

  for (const data of channels) {
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i])

      if (v > peak) {
        peak = v
      }
    }
  }

  if (peak === 0) {
    return buffer
  }

  const threshold = peak * SILENCE_RATIO
  let first = buffer.length

  for (const data of channels) {
    for (let i = 0; i < first; i += 1) {
      if (Math.abs(data[i]) > threshold) {
        first = i

        break
      }
    }
  }

  const preRoll = Math.round(buffer.sampleRate * PRE_ROLL_SECONDS)
  const start = Math.max(0, first - preRoll)

  // Under ~1.5 ms of lead-in isn't worth a copy.
  if (start < 64) {
    return buffer
  }

  const out = ac.createBuffer(buffer.numberOfChannels, buffer.length - start, buffer.sampleRate)
  const fade = Math.min(preRoll, out.length)

  channels.forEach((data, c) => {
    const target = out.getChannelData(c)
    target.set(data.subarray(start))

    for (let i = 0; i < fade; i += 1) {
      target[i] *= i / fade
    }
  })

  return out
}

function dataUriBytes(uri: string): ArrayBuffer {
  const binary = atob(uri.slice(uri.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes.buffer
}

/** Decode every sample into memory (idempotent). Opens the shared AudioContext. */
export function warmSampleSounds(): Promise<void> {
  if (loading) {
    return loading
  }

  const ac = getAudioContext()

  if (!ac) {
    return Promise.resolve()
  }

  loading = import('./cursor-sound-data')
    .then(({ SAMPLE_SOUND_DATA }) =>
      Promise.all(
        (Object.entries(SAMPLE_SOUND_DATA) as [SampleSoundId, string][]).map(async ([id, uri]) => {
          try {
            buffers.set(id, trimLeadingSilence(ac, await ac.decodeAudioData(dataUriBytes(uri))))
          } catch {
            // One undecodable clip must not take the others down.
          }
        })
      )
    )
    .then(() => undefined)
    .catch(() => {
      loading = null
    })

  return loading
}

function start(ac: AudioContext, buffer: AudioBuffer) {
  try {
    const source = ac.createBufferSource()
    source.buffer = buffer
    source.connect(ac.destination)
    source.start()
  } catch {
    // A dead context must never break the caller (submit, stream handling).
  }
}

/** A decoded sample's length (after trimming); 1 s until it has decoded. */
export function sampleDurationMs(id: SampleSoundId): number {
  const buffer = buffers.get(id)

  return buffer ? buffer.duration * 1000 : 1000
}

/** Play a sample now. Before the first warm-up finishes, plays as soon as it decodes. */
export function playSample(id: SampleSoundId) {
  const ac = getAudioContext()

  if (!ac) {
    return
  }

  const buffer = buffers.get(id)

  if (buffer) {
    return start(ac, buffer)
  }

  void warmSampleSounds().then(() => {
    const late = buffers.get(id)

    if (late) {
      start(ac, late)
    }
  })
}

export function _resetSampleSoundsForTest() {
  buffers.clear()
  loading = null
}
