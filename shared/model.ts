import { z } from 'zod'

export const googleVoice = 'https://voice.google.com/'
export const defaultInstructions = `You are an AI assistant authorized to assist the user during customer service conversations.
At the beginning, identify yourself as an AI assistant acting on the user's behalf. Explain the user's issue clearly and professionally. Listen carefully, ask follow-up questions, and work toward the stated objective.
Never invent account information, order numbers, product details, or previous interactions. Never claim to be the account holder. Never share passwords, verification codes, payment information, or other sensitive credentials.
If authentication is required, ask for a moment and call request_human_approval with action "authentication". Wait for human takeover.
Explain any refund, replacement, return, credit, or other proposal. Before making a purchase, accepting charges, or authorizing account changes, call request_human_approval with the exact proposal. Only communicate acceptance after receiving explicit approval for those exact terms. Otherwise decline or defer.
Remain calm, concise, and professional. Do not repeatedly call, harass anyone, or continue after a request to stop. Summarize the outcome and follow-up actions at the end.`

export const templates = [
  { name: 'Customer support', text: defaultInstructions },
  { name: 'Returns and refunds', text: defaultInstructions + '\nAsk about eligibility, amounts, deadlines, and written confirmation.' },
  { name: 'Appointment inquiries', text: defaultInstructions + '\nAsk for available times, location, cost, and cancellation policy. Get approval before booking.' },
  { name: 'General information', text: defaultInstructions + '\nGather and repeat back the requested information. Avoid commitments.' },
  { name: 'Personal assistant', text: defaultInstructions + '\nClarify the purpose and collect next steps. Defer commitments to the user.' },
]

const device = z.string().max(300)
export const agentId = z.string().regex(/^[A-Za-z0-9_-]{5,100}$/, 'Enter a valid ElevenLabs agent ID.')
export const audioSchema = z.object({
  input: device.default(''), output: device.default(''), monitor: device.default(''), microphone: device.default(''),
  inputGain: z.number().min(0).max(2).default(1),
  outputGain: z.number().min(0).max(2).default(1),
  monitorGain: z.number().min(0).max(1).default(0.45),
  echoGuard: z.boolean().default(true),
})
const agentSchema = z.object({ id: agentId, name: z.string().trim().min(1).max(100), private: z.boolean() })
const templateSchema = z.object({ name: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(16000) })
export const settingsSchema = z.object({
  agents: z.array(agentSchema).max(50).refine(items => new Set(items.map(agent => agent.id)).size === items.length, 'Agent IDs must be unique.').default([]),
  selectedAgent: z.union([agentId, z.literal('')]).default(''),
  instructions: z.string().trim().max(16000).default(defaultInstructions),
  greeting: z.string().trim().max(1000).default('Hello, I’m an AI assistant calling on behalf of the person on this line.'),
  overrides: z.boolean().default(true),
  templates: z.array(templateSchema).max(50).default(templates),
  audio: audioSchema.default(audioSchema.parse({})),
  theme: z.enum(['dark', 'light']).default('dark'),
  port: z.number().int().min(1024).max(65535).default(3000),
  retentionDays: z.number().int().min(0).max(3650).default(30),
  transcriptStorage: z.boolean().default(false),
  debug: z.boolean().default(false),
  startup: z.enum(['dashboard', 'incoming']).default('dashboard'),
  setupComplete: z.boolean().default(false),
}).refine(value => !value.selectedAgent || value.agents.some(agent => agent.id === value.selectedAgent), {
  path: ['selectedAgent'], message: 'Select a saved agent.',
})

export const planSchema = z.object({
  direction: z.enum(['incoming', 'outgoing']),
  label: z.string().trim().max(120),
  phone: z.string().trim().max(40).regex(/^[+\d(). -]*$/),
  objective: z.string().trim().max(4000),
  instructions: z.string().trim().max(16000),
  context: z.string().trim().max(8000),
  agentId,
  confirmed: z.literal(true),
  consent: z.literal(true),
  saveTranscript: z.boolean(),
})
export const transcriptSchema = z.object({
  id: z.string().min(1).max(130),
  role: z.enum(['agent', 'user']),
  text: z.string().trim().min(1).max(24000),
  at: z.number().int().nonnegative(),
})
export const updateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), conversationId: z.string().regex(/^[\w-]{1,130}$/) }),
  z.object({ type: z.enum(['paused', 'takeover', 'active', 'ended']), reason: z.string().max(160).optional() }),
  z.object({ type: z.literal('transcript'), row: transcriptSchema }),
])
export type Settings = z.infer<typeof settingsSchema>
export type AudioSettings = Settings['audio']
export type Plan = z.infer<typeof planSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type SessionUpdate = z.infer<typeof updateSchema>
export type SessionStatus = 'connecting' | 'active' | 'paused' | 'takeover' | 'ended'
export type Summary = {
  reason: string
  mainPoints: string[]
  outcome: string
  refund: string
  reference: string
  commitments: string[]
  followUp: string[]
  unresolved: string
}
export type CallRecord = {
  id: string
  direction: Plan['direction']
  label: string
  phone: string
  objective: string
  agentId: string
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  conversationId: string | null
  duration: number
  status: SessionStatus
  endReason: string
  saveTranscript: boolean
  notes: string
  summary: Summary | null
  providerSummary: string
  transcript: Transcript[]
}
