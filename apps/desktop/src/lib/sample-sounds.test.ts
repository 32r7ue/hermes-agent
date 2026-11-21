// Recorded-cue decode path: lead-in trimming and late play before warm-up.
import { afterEach, expect, it, vi } from 'vitest'

import { getAudioContext } from '@/lib/audio-context'

import { _resetSampleSoundsForTest, playSample, trimLeadingSilence } from './sample-sounds'

vi.mock('@/lib/audio-context', () => ({ getAudioContext: vi.fn(() => null) }))
vi.mock('./cursor-sound-data', () => ({
  SAMPLE_SOUND_DATA: { cursorRequestSent: 'data:audio/mpeg;base64,AAAA' }
}))

class FakeBuffer {
  readonly data: Float32Array[]

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }

  getChannelData(c: number) {
    return this.data[c]
  }
}

const fakeContext = () => {
  const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn() }

  return {
    source,
    ctx: {
      createBuffer: (ch: number, len: number, sr: number) => new FakeBuffer(ch, len, sr),
      createBufferSource: vi.fn(() => source),
      decodeAudioData: vi.fn(async () => {
        const b = new FakeBuffer(1, 48_000, 48_000)
        b.data[0].fill(0.4, 4_800)

        return b
      }),
      destination: {}
    }
  }
}

afterEach(() => {
  _resetSampleSoundsForTest()
  vi.mocked(getAudioContext).mockReturnValue(null)
})

it('cuts lead-in silence down to a short faded pre-roll and keeps the transient', () => {
  const { ctx } = fakeContext()
  const buffer = new FakeBuffer(2, 48_000, 48_000)
  // 100 ms of hiss at −60 dB, then the cue starts on the right channel.
  buffer.data[0].fill(0.0004, 0, 4_800)
  buffer.data[1].fill(0.5, 4_800)

  const trimmed = trimLeadingSilence(ctx as never, buffer as never) as unknown as FakeBuffer
  const preRoll = Math.round(48_000 * 0.003)

  expect(trimmed.length).toBe(48_000 - 4_800 + preRoll)
  expect(trimmed.data[1][0]).toBe(0)
  expect(trimmed.data[1][preRoll]).toBe(0.5)
  expect(trimmed.data[1][trimmed.length - 1]).toBe(0.5)
})

it('leaves a clip that starts on its transient untouched', () => {
  const { ctx } = fakeContext()
  const buffer = new FakeBuffer(1, 1_000, 48_000)
  buffer.data[0].fill(0.3)

  expect(trimLeadingSilence(ctx as never, buffer as never)).toBe(buffer)
})

it('plays a cue requested before warm-up once it decodes, then instantly from memory', async () => {
  const { ctx, source } = fakeContext()
  vi.mocked(getAudioContext).mockReturnValue(ctx as never)

  playSample('cursorRequestSent')
  expect(source.start).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(source.start).toHaveBeenCalledTimes(1))
  expect((source.buffer as FakeBuffer).length).toBe(48_000 - 4_800 + Math.round(48_000 * 0.003))

  playSample('cursorRequestSent')
  expect(source.start).toHaveBeenCalledTimes(2)
  expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1)
})
