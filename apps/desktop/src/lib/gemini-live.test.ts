import { describe, expect, it } from 'vitest'

import { selectedVoiceChatMode } from '@/store/voice-live'

import { decodePcm16Base64ToFloat32, downsampleFloat32ToPcm16 } from './gemini-live'

describe('gemini-live audio helpers', () => {
  it('downsamples Float32 PCM from 48kHz to 16kHz Int16', () => {
    const input = new Float32Array(480)
    input.fill(0.5)
    const pcm = downsampleFloat32ToPcm16(input, 48_000, 16_000)
    expect(pcm.length).toBe(160)
    expect(pcm[0]).toBeGreaterThan(15_000)
    expect(pcm[0]).toBeLessThan(17_000)
  })

  it('decodes base64 Int16 PCM to Float32', () => {
    const buf = new ArrayBuffer(4)
    const view = new DataView(buf)
    view.setInt16(0, 16_384, true)
    view.setInt16(2, -16_384, true)
    const bytes = new Uint8Array(buf)
    let bin = ''

    for (const b of bytes) {
      bin += String.fromCharCode(b)
    }

    const decoded = decodePcm16Base64ToFloat32(btoa(bin))
    expect(decoded.length).toBe(2)
    expect(decoded[0]).toBeCloseTo(0.5, 3)
    expect(decoded[1]).toBeCloseTo(-0.5, 3)
  })
})

describe('selectedVoiceChatMode', () => {
  it('recognizes gemini-live, gpt-live, and chained', () => {
    const base = { available: false, model: 'gpt-live-1', reason: null, voice: 'marin' }
    expect(selectedVoiceChatMode({ ...base, mode: 'gemini-live', geminiAvailable: true })).toBe('gemini-live')
    expect(selectedVoiceChatMode({ ...base, mode: 'gpt-live' })).toBe('gpt-live')
    expect(selectedVoiceChatMode({ ...base, mode: 'chained' })).toBe('chained')
    expect(selectedVoiceChatMode(null)).toBe('chained')
  })
})
