import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { POLICY, type Config } from './config.js';
import type { CalendarPlan } from './calendar.js';
import { describe, eventTime } from './domain.js';
import type { Incoming, Store } from './store.js';

export type ReplyAudio = NonNullable<Incoming['audio']>;
export interface SpeechPort { synthesize(text: string): Promise<ReplyAudio>; }

// Summaries use returned events, never another model's account of what happened.
export function speechText(reply: string, plan?: CalendarPlan): string {
  if (reply.length <= POLICY.maxSpeechChars) return reply;
  if (!plan?.list?.length) throw new Error('Reply too long for speech.');
  const language = plan.intent.language, he = language === 'he';
  const events = [...plan.list].sort((a, b) => eventTime(a.start).toMillis() - eventTime(b.start).toMillis());
  const days = new Map<string, number>();
  for (const event of events) {
    const day = eventTime(event.start).setLocale(language).toFormat('cccc, dd/LL/yyyy');
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const busiest = [...days].sort((a, b) => b[1] - a[1])[0]!;
  const opening = he ? `בטווח שביקשת יש ${events.length} אירועים. היום העמוס ביותר הוא ${busiest[0]}, עם ${busiest[1]} אירועים.` :
    `There are ${events.length} events in your requested range. The busiest day is ${busiest[0]}, with ${busiest[1]} events.`;
  const ending = he ? 'הרשימה המלאה מופיעה בהודעת הטקסט.' : 'The full agenda is in the text message.';
  let summary = opening;
  const upcoming = events.filter(event => eventTime(event.start).toMillis() >= Date.now()).slice(0, 2);
  for (const event of upcoming) {
    const detail = ` ${he ? 'אירוע קרוב:' : 'Upcoming:'} ${describe(event, language)}.`;
    if ((summary + detail + ' ' + ending).length <= POLICY.maxSpeechChars) summary += detail;
  }
  return summary + ' ' + ending;
}

export function replyChunks(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > POLICY.maxReplyChunkChars) {
    let end = text.lastIndexOf('\n', POLICY.maxReplyChunkChars);
    if (end < POLICY.maxReplyChunkChars / 2) end = POLICY.maxReplyChunkChars;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

export class Speech implements SpeechPort {
  private client: OpenAI;
  constructor(private cfg: Pick<Config, 'openaiKey' | 'aiCap' | 'speechVoice'>, private store: Store,
    client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: cfg.openaiKey, maxRetries: 0, timeout: 30000 });
  }
  async synthesize(text: string): Promise<ReplyAudio> {
    if (!text.trim() || text.length > POLICY.maxSpeechChars) throw new Error('Invalid speech length.');
    const id = randomUUID();
    // Reserve against a lower ceiling so optional speech leaves room for core requests.
    // Keep reservations on uncertain outcomes. UTF-16 length conservatively counts characters.
    this.store.reserve(id, text.length * POLICY.speechUsdPerMillionChars / 1e6,
      Math.max(0, this.cfg.aiCap - POLICY.speechBudgetHeadroomUsd));
    const response = await this.client.audio.speech.create({ model: POLICY.speechModel,
      voice: this.cfg.speechVoice ?? POLICY.speechVoice, input: text, response_format: 'opus', speed: 1.1 },
      { signal: AbortSignal.timeout(30000) });
    if (!response.body) throw new Error('Empty speech response.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > POLICY.maxVoiceBytes) throw new Error('Speech response too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const metadata = await parseBuffer(bytes, { mimeType: 'audio/ogg' }, { duration: true, skipCovers: true });
    const seconds = metadata.format.duration;
    if (metadata.format.codec !== 'Opus' || metadata.format.numberOfChannels !== 1 ||
        !seconds || !Number.isFinite(seconds) || seconds > POLICY.maxSpeechSeconds) {
      throw new Error(`Speech must be mono Opus and at most one minute; received ${metadata.format.codec}, ${metadata.format.numberOfChannels} channels, ${seconds} seconds.`);
    }
    return { data: bytes.toString('base64'), mime: 'audio/ogg; codecs=opus', seconds };
  }
}
