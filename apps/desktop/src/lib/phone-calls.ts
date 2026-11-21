import { hermesApi } from '@/hermes'

export type PhoneCallStatus = 'dialing' | 'ended' | 'in_progress' | 'pending_approval'
export type PhoneCallCalleeKind = 'person' | 'storefront'

export interface PhoneCallTranscriptTurn {
  speaker: 'assistant' | 'callee' | 'system'
  text: string
  timestamp_ms: number
}

export interface PhoneCallQuestion {
  question_id: string
  tool_call_id: string
  question: string
  options: string[]
  answer: null | string
  asked_at_ms: number
  answered_at_ms: null | number
}

export interface PhoneCallRecord {
  call_id: string
  callee_name: string
  callee_number: string
  callee_kind: PhoneCallCalleeKind
  goal: string
  instructions: string
  agent_profile: string
  session_id: string
  voice: string
  model: string
  transport: 'loopback' | 'sip' | 'twilio_media_stream'
  status: PhoneCallStatus
  outcome: null | string
  end_reason: null | string
  summary: null | string
  created_at_ms: number
  started_at_ms: null | number
  ended_at_ms: null | number
  duration_ms: null | number
  transcript: PhoneCallTranscriptTurn[]
  questions: PhoneCallQuestion[]
  injected_context: string[]
}

export async function listPhoneCalls(sessionId?: string): Promise<PhoneCallRecord[]> {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''

  const res = await hermesApi<{ ok: boolean; calls: PhoneCallRecord[] }>({
    path: `/api/phone-calls${query}`
  })

  return res?.calls ?? []
}

export async function createPhoneCall(params: {
  callee_number: string
  goal: string
  callee_name?: string
  callee_kind?: PhoneCallCalleeKind
  instructions?: string
  transport?: 'loopback' | 'sip' | 'twilio_media_stream'
  session_id?: string
  auto_approve?: boolean
}): Promise<PhoneCallRecord> {
  const res = await hermesApi<{ ok: boolean; call: PhoneCallRecord }>({
    body: params,
    method: 'POST',
    path: '/api/phone-calls'
  })

  return res.call
}

export async function approvePhoneCall(callId: string): Promise<PhoneCallRecord> {
  const res = await hermesApi<{ ok: boolean; call: PhoneCallRecord }>({
    method: 'POST',
    path: `/api/phone-calls/${encodeURIComponent(callId)}/approve`
  })

  return res.call
}

export async function rejectPhoneCall(callId: string): Promise<PhoneCallRecord> {
  const res = await hermesApi<{ ok: boolean; call: PhoneCallRecord }>({
    method: 'POST',
    path: `/api/phone-calls/${encodeURIComponent(callId)}/reject`
  })

  return res.call
}

export async function injectPhoneCallContext(callId: string, text: string): Promise<PhoneCallRecord> {
  const res = await hermesApi<{ ok: boolean; call: PhoneCallRecord }>({
    body: { text },
    method: 'POST',
    path: `/api/phone-calls/${encodeURIComponent(callId)}/context`
  })

  return res.call
}

export async function answerPhoneCallQuestion(
  callId: string,
  questionId: string,
  answer: string
): Promise<PhoneCallQuestion> {
  const res = await hermesApi<{ ok: boolean; question: PhoneCallQuestion }>({
    body: { answer },
    method: 'POST',
    path: `/api/phone-calls/${encodeURIComponent(callId)}/questions/${encodeURIComponent(questionId)}/answer`
  })

  return res.question
}

export async function hangupPhoneCall(callId: string): Promise<PhoneCallRecord> {
  const res = await hermesApi<{ ok: boolean; call: PhoneCallRecord }>({
    method: 'POST',
    path: `/api/phone-calls/${encodeURIComponent(callId)}/hangup`
  })

  return res.call
}
