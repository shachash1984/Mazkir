import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

export const POLICY = {
  timezone: 'Asia/Jerusalem', durationMinutes: 30, retentionDays: 30,
  taskRetentionDays: 90, taskReminderHour: 9, taskReminderGapHours: 24,
  taskTitleChars: 200, taskNoteChars: 4000, taskContextLimit: 100, taskContextBytes: 16000,
  textModel: 'gpt-4.1-mini-2025-04-14', transcriptionModel: 'gpt-4o-mini-transcribe',
  inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6,
  // Reserve the audio token maximum using the API's documented token rates.
  audioInputUsdPerMillion: 3, audioOutputUsdPerMillion: 5,
  // Character-priced speech permits an exact reservation before each request.
  speechModel: 'tts-1', speechVoice: 'nova', speechUsdPerMillionChars: 15,
  maxSpeechChars: 650, maxSpeechSeconds: 60, speechBudgetHeadroomUsd: 1,
  maxReplyChunkChars: 3500,
  maxInputChars: 24000, maxOutputTokens: 1200, maxVoiceSeconds: 180,
  maxVoiceBytes: 8 * 1024 * 1024, maxAttempts: 4, maxEvents: 100,
  category: 'Mazkir', graphBase: 'https://graph.microsoft.com/v1.0',
  propertyId: 'String {0d1041e1-a2cb-41ca-86c7-cab2419f0b82} Name MazkirOperation',
  scopes: ['https://graph.microsoft.com/Calendars.ReadWrite'],
} as const;

export const memberSchema = z.object({
  name: z.string().min(1).max(80), phone: z.string().regex(/^[1-9]\d{7,14}$/),
  email: z.email(),
  additionalEmails: z.array(z.email()).optional(),
});
export type Member = z.infer<typeof memberSchema>;
export function invitationRecipients(members: Member[]): { address: string; name: string }[] {
  const recipients = new Map<string, { address: string; name: string }>();
  for (const member of members) for (const address of [member.email, ...(member.additionalEmails ?? [])]) {
    const normalized = address.toLowerCase();
    if (!recipients.has(normalized)) recipients.set(normalized, { address: normalized, name: member.name });
  }
  return [...recipients.values()];
}
export interface Config {
  dataDir: string; encryptionKey: string; openaiKey: string; msClientId: string;
  organizerEmail: string; members: Member[]; healthcheckUrl: string; aiCap: number;
  speechVoice?: string;
}
export const speechVoices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;
export function familyConfigured(cfg: Pick<Config, 'members'>): boolean {
  return cfg.members.length === 2 && cfg.members.every(m => !m.email.toLowerCase().endsWith('@example.com') && !['972500000001', '972500000002'].includes(m.phone));
}
export function config(): Config {
  const members = z.array(memberSchema).length(2).parse(JSON.parse(process.env.FAMILY_MEMBERS ?? '[]'));
  if (new Set(members.map(m => m.phone)).size !== 2 || new Set(members.map(m => m.email.toLowerCase())).size !== 2) {
    throw new Error('Configure two distinct family phone numbers and email addresses.');
  }
  const encryptionKey = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error('Run setup to generate ENCRYPTION_KEY.');
  const aiCap = z.coerce.number().positive().max(8).parse(process.env.AI_MONTHLY_USD_CAP ?? '8');
  const healthcheckUrl = process.env.HEALTHCHECK_URL ?? '';
  if (healthcheckUrl && !/^https:\/\/hc-ping\.com\/[a-f0-9-]+$/.test(healthcheckUrl)) throw new Error('Use the Healthchecks.io HTTPS ping URL.');
  return {
    dataDir: resolve(process.env.DATA_DIR ?? './data'), encryptionKey,
    openaiKey: process.env.OPENAI_API_KEY ?? '', msClientId: process.env.MS_CLIENT_ID ?? '',
    organizerEmail: process.env.ORGANIZER_EMAIL?.toLowerCase() ?? '',
    members, healthcheckUrl, aiCap,
    speechVoice: z.enum(speechVoices).parse(process.env.SPEECH_VOICE ?? POLICY.speechVoice),
  };
}

export class UserError extends Error {
  constructor(public english: string, public hebrew: string) { super(english); }
}
export class RetryableError extends Error {}
export class InterventionError extends Error {}
