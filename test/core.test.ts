import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, type Job } from '../src/store.js';
import { Calendar } from '../src/calendar.js';
import { Worker } from '../src/worker.js';
import { executableIntent, localTime, recurrence, timeRange, type Intent, type CalendarEvent } from '../src/domain.js';
import { type GraphPort, NotFoundError } from '../src/microsoft.js';
import { POLICY, UserError, RetryableError, InterventionError } from '../src/config.js';
import { encryptedAuth, memberForJid, WhatsApp } from '../src/whatsapp.js';
import { Speech, replyChunks, speechText } from '../src/speech.js';
import { Language } from '../src/language.js';
import OpenAI from 'openai';
import type { Config } from '../src/config.js';
import type { proto, WASocket } from '@whiskeysockets/baileys';

const members = [{ name: 'A', phone: '15550000001', email: 'a@example.com' }, { name: 'B', phone: '15550000002', email: 'b@example.com' }];
const cfg = { members, organizerEmail: 'agent@example.com' };
const intent = (patch: Partial<Intent> = {}): Intent => ({ action: 'create', language: 'en', title: 'Judo pickup',
  start: '2099-09-09T16:00:00', end: null, timezone: null, location: null, eventId: null, scope: 'occurrence',
  targetSelection: 'none', recurrence: null, question: null, queryStart: null, queryEnd: null, ...patch });
const job = (id = 'job1', chat = members[0]!.phone): Job => ({ id, chat, actor: 'A', text: 'Judo pickup',
  at: new Date().toISOString(), status: 'pending', attempts: 0, nextAt: 0 });
function storeFor(t: { after: (fn: () => void) => void }): Store {
  const dir = mkdtempSync(join(tmpdir(), 'mazkir-test-'));
  const store = new Store(dir, randomBytes(32).toString('hex'));
  t.after(() => {
    store.close();
    const path = resolve(dir), parent = resolve(tmpdir());
    if (!path.startsWith(parent + sep) || !path.slice(parent.length + 1).startsWith('mazkir-test-')) throw new Error('Unsafe test cleanup');
    rmSync(path, { recursive: true });
  });
  return store;
}
class Graph implements GraphPort {
  events = new Map<string, CalendarEvent>();
  operations = new Map<string, string>();
  creates = 0; patches = 0; cancels = 0; loseCreate = false; losePatch = false;
  async all<T>(path: string): Promise<T[]> {
    if (path.includes('$filter=')) {
      const decoded = decodeURIComponent(path);
      const found = [...this.operations].find(([op]) => decoded.includes(op));
      return (found ? [this.events.get(found[1])] : []) as T[];
    }
    return [...this.events.values()] as T[];
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const data = body as Record<string, unknown>;
    if (method === 'POST' && path === '/me/events') {
      this.creates++;
      const e = { ...data, id: 'e' + this.creates, type: 'singleInstance', '@odata.etag': 'v1', organizer: { emailAddress: { address: cfg.organizerEmail } } } as unknown as CalendarEvent;
      this.events.set(e.id, e);
      const op = (data.singleValueExtendedProperties as { value: string }[])[0]!.value;
      this.operations.set(op, e.id);
      if (this.loseCreate) { this.loseCreate = false; throw new RetryableError('Response lost after creating'); }
      return e as T;
    }
    const id = decodeURIComponent(path.split('/')[3]!.split('?')[0]!);
    const e = this.events.get(id);
    if (!e) throw new NotFoundError();
    if (method === 'GET') return structuredClone(e) as T;
    if (method === 'PATCH') {
      this.patches++;
      Object.assign(e, data, { '@odata.etag': 'v' + (this.patches + 1) });
      if (this.losePatch) { this.losePatch = false; throw new RetryableError('Response lost after updating'); }
      return structuredClone(e) as T;
    }
    if (path.endsWith('/cancel')) { this.cancels++; this.events.delete(id); return undefined as T; }
    throw new Error('Unexpected request');
  }
}
const readyNow = (s: Store) => s.db.exec('UPDATE jobs SET next_at=0');

test('Israel default duration, weekly recurrence, and DST validation', () => {
  const range = timeRange(intent());
  assert.equal(range.end.dateTime, '2099-09-09T16:30:00');
  assert.equal(range.start.timeZone, POLICY.timezone);
  assert.throws(() => localTime('2027-03-26T02:30:00', POLICY.timezone), UserError);
  assert.throws(() => localTime('2026-10-25T01:30:00', POLICY.timezone), UserError);
  const r = recurrence(intent({ recurrence: { frequency: 'weekly', interval: 1, weekdays: ['wednesday'], until: null } }), range.start)!;
  assert.deepEqual(r.pattern.daysOfWeek, ['wednesday']);
  assert.equal(r.range.type, 'noEnd');
});
test('invalid dates and reversed ranges are rejected', () => {
  assert.throws(() => localTime('2099-02-30T16:00:00', POLICY.timezone), UserError);
  assert.throws(() => timeRange(intent({ end: '2099-09-09T15:00:00' })), UserError);
});
test('encrypted store hides content, authenticates ciphertext, and isolates conversations', t => {
  const s = storeFor(t); s.set('secret', { value: 'private title' });
  const raw = String(s.db.prepare('SELECT value FROM vault').get()!.value);
  assert.ok(!raw.includes('private title'));
  const corrupt = Buffer.from(raw, 'base64'); corrupt[15] = corrupt[15]! ^ 1;
  assert.throws(() => s.decrypt(corrupt.toString('base64')));
  s.addHistory('a', 'user', 'only a'); s.addHistory('b', 'user', 'only b');
  assert.deepEqual(s.history('a').map(h => h.content), ['only a']);
});
test('inbox deduplicates and preserves FIFO while earlier message retries', t => {
  const s = storeFor(t); assert.ok(s.enqueue(job())); assert.equal(s.enqueue(job()), false);
  s.enqueue(job('second')); s.retry('job1', 1); assert.equal(s.next(), undefined);
  readyNow(s); assert.equal(s.next()!.id, 'job1');
  s.complete('job1'); assert.equal(s.enqueue(job()), false); assert.equal(s.next()!.id, 'second');
});
test('budget reservations retain uncertain API costs and prevent overspending', t => {
  const s = storeFor(t); s.reserve('a', 0.7, 1); assert.throws(() => s.reserve('b', 0.4, 1), UserError);
  assert.equal(s.spend(), 0.7); s.settle('a', 0.2); s.reserve('c', 0.5, 1); assert.equal(s.spend(), 0.7);
});
test('only one database owner can run until release', t => {
  const s = storeFor(t); assert.ok(s.acquire('a')); assert.ok(!s.acquire('b')); assert.ok(s.acquire('a'));
  s.release('a'); assert.ok(s.acquire('b'));
});
test('WhatsApp authorization rejects groups, unknown contacts, and unmapped LIDs', () => {
  assert.equal(memberForJid('15550000001@s.whatsapp.net', members)?.name, 'A');
  assert.equal(memberForJid('123@lid', members, '15550000002')?.name, 'B');
  assert.equal(memberForJid('123@lid', members), undefined);
  assert.equal(memberForJid('15550000001@g.us', members, '15550000001'), undefined);
  assert.equal(memberForJid('19999999999@s.whatsapp.net', members), undefined);
});
test('WhatsApp encryption keys round-trip as binary values', async t => {
  const s = storeFor(t); const auth = encryptedAuth(s); auth.save();
  await auth.state.keys.set({ session: { peer: new Uint8Array([1, 2, 3]) } });
  const second = encryptedAuth(s);
  assert.deepEqual([...((await second.state.keys.get('session', ['peer'])).peer!)], [1, 2, 3]);
  assert.deepEqual(second.state.creds.noiseKey, auth.state.creds.noiseKey);
});
test('lost create response and subsequent worker restart do not duplicate invitations', async t => {
  const s = storeFor(t), g = new Graph(); g.loseCreate = true;
  let interpretations = 0, replies = 0;
  const build = () => new Worker(s, new Calendar(g, cfg), { interpret: async () => { interpretations++; return intent(); }, transcribe: async j => j.text },
    { send: async () => { replies++; } }, () => assert.fail('blocked'));
  s.enqueue(job()); await build().tick(); readyNow(s);
  const restarted = build(); await restarted.tick(); await restarted.tick();
  assert.equal(g.creates, 1); assert.equal(interpretations, 1); assert.equal(replies, 1); assert.equal(s.next(), undefined);
  assert.deepEqual(g.events.get('e1')!.attendees!.map(a => a.emailAddress.address), members.map(m => m.email));
});
test('additional member emails receive invitations once and persist through updates', async () => {
  const g = new Graph(), c = new Calendar(g, { ...cfg, members: [
    { ...members[0]!, additionalEmails: ['extra@example.com', 'A@example.com'] }, members[1]!,
  ] });
  const create = await c.prepare(intent(), job(), []); await c.execute(create, () => {});
  const event = g.events.get('e1')!;
  assert.deepEqual(event.attendees!.map(a => a.emailAddress.address), ['a@example.com', 'extra@example.com', 'b@example.com']);
  const edit = await c.prepare(intent({ action: 'update', eventId: 'e1', title: 'Edited', start: null }), job('edit'), [event]);
  await c.execute(edit, () => {});
  assert.equal(g.events.get('e1')!.attendees!.length, 3);
});
test('reply retry never repeats a successful calendar mutation', async t => {
  const s = storeFor(t), g = new Graph(); let sends = 0;
  const w = new Worker(s, new Calendar(g, cfg), { interpret: async () => intent(), transcribe: async j => j.text },
    { send: async () => { if (++sends === 1) throw new RetryableError(); } }, () => assert.fail('blocked'));
  s.enqueue(job()); await w.tick(); await w.tick(); readyNow(s); await w.tick();
  assert.equal(g.creates, 1); assert.equal(sends, 2); assert.equal(s.next(), undefined);
});
test('update reconciles a lost response without resending invitations', async () => {
  const g = new Graph(), c = new Calendar(g, cfg);
  const create = await c.prepare(intent(), job(), []); await c.execute(create, () => {});
  const event = g.events.get('e1')!;
  const update = await c.prepare(intent({ action: 'update', eventId: 'e1', title: 'New title', start: null }), job('edit'), [event]);
  g.losePatch = true; await assert.rejects(c.execute(update, () => {}), RetryableError);
  await c.execute(update, () => {}); assert.equal(g.patches, 1); assert.equal(event.subject, 'New title');
});
test('stale mutation is rejected and unrelated organizer events cannot be edited', async () => {
  const g = new Graph(), c = new Calendar(g, cfg);
  const create = await c.prepare(intent(), job(), []); await c.execute(create, () => {});
  const event = g.events.get('e1')!;
  const update = await c.prepare(intent({ action: 'update', eventId: 'e1', title: 'New title', start: null }), job('edit'), [event]);
  event['@odata.etag'] = 'external'; await assert.rejects(c.execute(update, () => {}), UserError);
  event.categories = []; await assert.rejects(c.prepare(intent({ action: 'cancel', eventId: 'e1' }), job(), [event]), UserError);
});
test('cancel reconciliation treats an already deleted event as complete', async () => {
  const g = new Graph(), c = new Calendar(g, cfg);
  const create = await c.prepare(intent(), job(), []); await c.execute(create, () => {});
  const cancel = await c.prepare(intent({ action: 'cancel', eventId: 'e1' }), job('cancel'), [g.events.get('e1')!]);
  await c.execute(cancel, () => {}); cancel.steps[0]!.done = false;
  await c.execute(cancel, () => {}); assert.equal(g.cancels, 1);
});
test('blocked authentication halts later mutations until explicit recovery', async t => {
  const s = storeFor(t), g = new Graph(); let alerts = 0;
  const w = new Worker(s, new Calendar(g, cfg), { interpret: async () => { throw new InterventionError(); }, transcribe: async j => j.text },
    { send: async () => {} }, () => { alerts++; });
  s.enqueue(job()); s.enqueue(job('second')); await w.tick(); await w.tick();
  assert.ok(s.hasBlocked()); assert.equal(alerts, 1); assert.equal(g.creates, 0); assert.ok(s.resume('job1'));
});
test('past-due create is clarified without writing to Microsoft', async () => {
  const g = new Graph(), c = new Calendar(g, cfg);
  await assert.rejects(c.prepare(intent({ start: '2020-01-01T16:00:00' }), job(), []), UserError);
  assert.equal(g.creates, 0);
});

function recurringGraph(): { g: Graph; c: Calendar; occurrence: CalendarEvent } {
  const g = new Graph(), c = new Calendar(g, cfg);
  const master: CalendarEvent = { id: 'master', subject: 'Weekly judo', categories: [POLICY.category],
    organizer: { emailAddress: { address: cfg.organizerEmail } }, '@odata.etag': 'v1', type: 'seriesMaster',
    start: { dateTime: '2099-09-02T16:00:00', timeZone: POLICY.timezone },
    end: { dateTime: '2099-09-02T16:30:00', timeZone: POLICY.timezone },
    attendees: members.map(m => ({ emailAddress: { address: m.email }, type: 'required' })),
    recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'], firstDayOfWeek: 'sunday' },
      range: { type: 'noEnd', startDate: '2099-09-02', recurrenceTimeZone: POLICY.timezone } } };
  const occurrence: CalendarEvent = { ...structuredClone(master), id: 'occurrence', type: 'occurrence', seriesMasterId: 'master', recurrence: null,
    start: { dateTime: '2099-09-09T16:00:00', timeZone: POLICY.timezone },
    end: { dateTime: '2099-09-09T16:30:00', timeZone: POLICY.timezone }, originalStart: '2099-09-09T13:00:00Z' };
  g.events.set('master', master); g.events.set('occurrence', occurrence);
  return { g, c, occurrence };
}
test('future series changes truncate at the preceding day and resume lost replacement creation', async () => {
  const { g, c, occurrence } = recurringGraph();
  const plan = await c.prepare(intent({ action: 'update', scope: 'future', eventId: 'occurrence', title: null, start: '2099-09-09T17:00:00' }), job(), [occurrence]);
  g.loseCreate = true; await assert.rejects(c.execute(plan, () => {}), RetryableError);
  assert.equal(g.events.get('master')!.recurrence!.range.endDate, '2099-09-08');
  await c.execute(plan, () => {});
  assert.equal(g.creates, 1); assert.equal(g.patches, 1);
  assert.equal(g.events.get('e1')!.start.dateTime, '2099-09-09T17:00:00');
  assert.deepEqual(g.events.get('e1')!.recurrence!.pattern.daysOfWeek, ['wednesday']);
});
test('future cancel does not create a replacement or cancel historical occurrences', async () => {
  const { g, c, occurrence } = recurringGraph();
  const plan = await c.prepare(intent({ action: 'cancel', scope: 'future', eventId: 'occurrence' }), job(), [occurrence]);
  await c.execute(plan, () => {});
  assert.equal(g.creates, 0); assert.equal(g.cancels, 0);
  assert.equal(g.events.get('master')!.recurrence!.range.endDate, '2099-09-08');
  assert.match(c.receipt(plan), /09\/09\/2099/);
});
test('whole-series time edit preserves anchor and refuses silent date changes', async () => {
  const { c, occurrence } = recurringGraph();
  const plan = await c.prepare(intent({ action: 'update', scope: 'series', eventId: 'occurrence', title: null, start: '2099-09-09T17:00:00' }), job(), [occurrence]);
  assert.equal((plan.steps[0]!.body!.start as { dateTime: string }).dateTime, '2099-09-02T17:00:00');
  await assert.rejects(c.prepare(intent({ action: 'update', scope: 'series', eventId: 'occurrence', start: '2099-09-10T17:00:00' }), job(), [occurrence]), UserError);
});
test('recurrence pattern changes with exceptions are rejected before mutation', async () => {
  const { g, c, occurrence } = recurringGraph();
  g.events.get('master')!.cancelledOccurrences = ['OID.master.2099-09-16'];
  await assert.rejects(c.prepare(intent({ action: 'update', scope: 'future', eventId: 'occurrence', title: null,
    recurrence: { frequency: 'daily', interval: 1, weekdays: [], until: null } }), job(), [occurrence]), UserError);
  assert.equal(g.patches, 0); assert.equal(g.creates, 0);
});
test('retention erases old transcripts and blocks unresolved work', t => {
  const s = storeFor(t); s.enqueue({ ...job(), audio: { data: 'private audio', mime: 'audio/ogg', seconds: 1 } });
  s.db.exec('UPDATE jobs SET created_at=0'); s.addHistory('a', 'user', 'expired'); s.db.exec('UPDATE history SET at=0');
  s.prune(); assert.ok(s.hasBlocked()); assert.deepEqual(s.history('a'), []);
  const row = s.db.prepare('SELECT payload FROM jobs').get()!;
  const saved = s.decrypt<Job>(String(row.payload)); assert.equal(saved.text, ''); assert.equal(saved.audio, undefined);
});

test('title-only mutations cannot choose between distinct same-title events', async () => {
  const g = new Graph(), c = new Calendar(g, cfg);
  const create = await c.prepare(intent(), job(), []); await c.execute(create, () => {});
  const original = g.events.get('e1')!;
  const other = { ...structuredClone(original), id: 'other' };
  g.events.set('other', other);
  await assert.rejects(c.prepare(intent({ action: 'cancel', eventId: 'e1', targetSelection: 'title' }), job(), [original, other]), UserError);
  assert.equal(g.cancels, 0);
});

test('a model clarification question cannot also execute a mutation', () => {
  const result = executableIntent(intent({ action: 'cancel', eventId: 'e1', question: 'Which Judo event do you mean?' }));
  assert.equal(result.action, 'clarify'); assert.equal(result.eventId, null);
});

const fakeAudio = { data: Buffer.from('private generated voice').toString('base64'), mime: 'audio/ogg; codecs=opus', seconds: 5 };
const fullCfg: Config = { ...cfg, dataDir: '', encryptionKey: '', openaiKey: 'test-only', msClientId: '', healthcheckUrl: '', aiCap: 8 };

test('voice input survives transcription and restart; audio retry never repeats text or calendar work', async t => {
  const s = storeFor(t), g = new Graph(); let transcriptions = 0, generations = 0, texts = 0, voices = 0;
  const w = () => new Worker(s, new Calendar(g, cfg), {
    transcribe: async () => { transcriptions++; return 'תקבע חוג'; }, interpret: async () => intent({ language: 'he' }),
  }, { send: async () => { texts++; }, sendAudio: async () => { if (++voices === 1) throw new RetryableError(); } },
  () => assert.fail('blocked'), { synthesize: async text => { generations++; assert.match(text, /נשלחו הזמנות/); return fakeAudio; } });
  s.enqueue({ ...job(), text: '', audio: fakeAudio });
  await w().tick();
  assert.equal(s.next()!.voiceReply, true); assert.equal(s.next()!.audio, undefined);
  await w().tick();
  assert.deepEqual(s.next(Date.now() + 60000)!.delivery?.audio, fakeAudio);
  const raw = String(s.db.prepare('SELECT payload FROM jobs').get()!.payload);
  assert.ok(!raw.includes(fakeAudio.data));
  readyNow(s); await w().tick();
  assert.equal(g.creates, 1); assert.equal(transcriptions, 1); assert.equal(generations, 1);
  assert.equal(texts, 1); assert.equal(voices, 2); assert.equal(s.next(), undefined);
  const finished = s.db.prepare('SELECT payload,reply,plan FROM jobs').get()!;
  assert.deepEqual(s.decrypt(String(finished.payload)), {}); assert.equal(finished.reply, null);
});

for (const explicit of [false, true]) test(`typed request ${explicit ? 'with' : 'without'} explicit speech preference`, async t => {
  const s = storeFor(t), g = new Graph(); let generations = 0, voices = 0;
  const w = new Worker(s, new Calendar(g, cfg), { transcribe: async () => assert.fail('text was transcribed'),
    interpret: async () => intent({ voiceReply: explicit }) }, { send: async () => {}, sendAudio: async () => { voices++; } },
  () => assert.fail('blocked'), { synthesize: async () => { generations++; return fakeAudio; } });
  s.enqueue(job()); await w.tick(); await w.tick();
  assert.equal(generations, Number(explicit)); assert.equal(voices, Number(explicit)); assert.equal(g.creates, 1);
});

test('failed speech sends a successful text receipt and never claims the calendar was unchanged', async t => {
  const s = storeFor(t), g = new Graph(), messages: string[] = [];
  const w = new Worker(s, new Calendar(g, cfg), { transcribe: async () => 'Schedule Judo', interpret: async () => intent() },
    { send: async (_chat, text) => { messages.push(text); }, sendAudio: async () => assert.fail('no audio exists') },
    () => assert.fail('blocked'), { synthesize: async () => { throw new UserError('No event was changed.', 'לא שונה אירוע.'); } });
  s.enqueue({ ...job(), audio: fakeAudio }); await w.tick(); await w.tick();
  assert.equal(g.creates, 1); assert.match(messages[0]!, /Invitations sent/);
  assert.match(messages[1]!, /audio is unavailable/); assert.doesNotMatch(messages.join(''), /No event was changed/);
  assert.equal(s.next(), undefined);
});

test('interrupted speech generation falls back to text without a second paid request', async t => {
  const s = storeFor(t), g = new Graph(); const pending = { ...job(), voiceReply: true };
  s.enqueue(pending); s.readyReply(pending, 'Invitations sent.');
  const saved = s.next()!; saved.delivery = { speech: 'started', textPartsSent: 0 }; s.savePayload(saved);
  let messages = 0;
  await new Worker(s, new Calendar(g, cfg), { interpret: async () => assert.fail('must not interpret'), transcribe: async () => '' },
    { send: async () => { messages++; }, sendAudio: async () => assert.fail('no audio') }, () => assert.fail('blocked'),
    { synthesize: async () => assert.fail('must not regenerate') }).tick();
  assert.equal(messages, 2); assert.equal(g.creates, 0); assert.equal(s.next(), undefined);
});

test('permanent audio delivery failure does not block following calendar requests', async t => {
  const s = storeFor(t), g = new Graph(); let generations = 0, voices = 0;
  const messages: string[] = [];
  const w = new Worker(s, new Calendar(g, cfg), { transcribe: async () => 'Judo', interpret: async () => intent() },
    { send: async (_c, text) => { messages.push(text); }, sendAudio: async () => { voices++; throw new RetryableError(); } },
    () => assert.fail('blocked'), { synthesize: async () => { generations++; return fakeAudio; } });
  s.enqueue({ ...job(), audio: fakeAudio }); s.enqueue(job('next'));
  await w.tick();
  for (let i = 0; i < POLICY.maxAttempts; i++) { readyNow(s); await w.tick(); }
  assert.equal(s.hasBlocked(), false); assert.equal(s.next()!.id, 'next');
  await w.tick(); await w.tick();
  assert.equal(g.creates, 2); assert.equal(generations, 1); assert.equal(voices, POLICY.maxAttempts);
  assert.equal(messages.filter(m => /audio is unavailable/.test(m)).length, 1);
});

test('voice clarification changes no events and uses the same spoken question', async t => {
  const s = storeFor(t), g = new Graph(); const question = 'לאיזה יום התכוונת?';
  const w = new Worker(s, new Calendar(g, cfg), { transcribe: async () => 'תבטל חוג',
    interpret: async () => intent({ action: 'clarify', language: 'he', question }) },
  { send: async () => {}, sendAudio: async () => {} }, () => assert.fail('blocked'),
  { synthesize: async text => { assert.equal(text, question); return fakeAudio; } });
  s.enqueue({ ...job(), audio: fakeAudio }); await w.tick(); await w.tick(); assert.equal(g.creates, 0);
});

test('long agendas preserve all text, summarize calendar facts, and resume at the unsent chunk', async t => {
  const s = storeFor(t), g = new Graph(), c = new Calendar(g, cfg);
  const base = await c.prepare(intent(), job(), []); await c.execute(base, () => {});
  const template = g.events.get('e1')!;
  const events = Array.from({ length: 45 }, (_, i) => ({ ...template, id: `event-${i}`, subject: `Event ${i + 1} פגישה` }));
  const plan = { intent: intent({ action: 'list', language: 'he' }), steps: [], list: events };
  const reply = c.receipt(plan), summary = speechText(reply, plan);
  assert.match(reply, /Event 45/); assert.ok(summary.length <= POLICY.maxSpeechChars);
  assert.match(summary, /45 אירועים/); assert.match(summary, /הרשימה המלאה/);
  assert.equal(replyChunks(reply).join(''), reply);
  const long = { ...job('long'), voiceReply: true }; s.enqueue(long); s.plan(long.id, plan); s.readyReply(long, reply);
  const sent: string[] = []; let failed = false;
  const worker = () => new Worker(s, c, { interpret: async () => assert.fail('already replied'), transcribe: async () => '' },
    { send: async (_c, _text, id) => { if (id.endsWith(':text:1') && !failed) { failed = true; throw new RetryableError(); } sent.push(id); }, sendAudio: async () => {} },
    () => assert.fail('blocked'), { synthesize: async text => { assert.equal(text, summary); return fakeAudio; } });
  await worker().tick(); readyNow(s); await worker().tick();
  assert.equal(sent.filter(id => id === 'long').length, 1); assert.equal(s.next(), undefined);
});

test('retention deletes unfinished generated audio', t => {
  const s = storeFor(t), pending = job();
  s.enqueue({ ...pending, delivery: { speech: 'ready', audio: fakeAudio, textPartsSent: 0 } });
  s.db.prepare('UPDATE jobs SET created_at=?').run(Date.now() - 31 * 86400000); s.prune();
  const row = s.db.prepare('SELECT payload,status FROM jobs').get()!;
  assert.equal(s.decrypt<Job>(String(row.payload)).delivery, undefined); assert.equal(row.status, 'blocked');
});

test('speech budget leaves core-request headroom and failed calls retain their reservation', async t => {
  const s = storeFor(t); let requests = 0;
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async () => { requests++; throw new Error('network'); } });
  s.reserve('existing', 7, 8);
  await assert.rejects(new Speech(fullCfg, s, client).synthesize('Hello'), UserError); assert.equal(requests, 0);
  s.settle('existing', 0);
  await assert.rejects(new Speech(fullCfg, s, client).synthesize('Hello'));
  assert.equal(requests, 1); assert.equal(s.spend(), 5 * POLICY.speechUsdPerMillionChars / 1e6);
});

const recordedVoice = () => readFileSync(new URL('./fixtures/synthetic-voice.ogg', import.meta.url));

test('speech provider returns validated mono Opus and charges by input characters', async t => {
  const s = storeFor(t); let requests = 0;
  const bytes = recordedVoice();
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (_url, options) => {
    requests++; const payload = JSON.parse(String(options?.body));
    assert.equal(payload.response_format, 'opus'); assert.equal(payload.model, POLICY.speechModel);
    return new Response(bytes, { headers: { 'content-type': 'audio/ogg' } });
  } });
  const result = await new Speech(fullCfg, s, client).synthesize('שלום, English.');
  assert.equal(result.data, bytes.toString('base64')); assert.ok(result.seconds > 0 && result.seconds < 60);
  assert.equal(requests, 1); assert.equal(s.spend(), 'שלום, English.'.length * POLICY.speechUsdPerMillionChars / 1e6);
});

test('unreadable, stereo, and overlong generated audio never reach WhatsApp', async t => {
  const s = storeFor(t), stereo = recordedVoice(), long = recordedVoice();
  stereo[stereo.indexOf('OpusHead') + 9] = 2;
  long.writeBigUInt64LE(181n * 48000n, long.lastIndexOf('OggS') + 6);
  for (const bytes of [Buffer.from('broken'), stereo, long]) {
    const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async () => new Response(bytes) });
    await assert.rejects(new Speech(fullCfg, s, client).synthesize('Hello'));
  }
});

test('incoming audio is validated before paid transcription and blank transcripts ask for a resend', async t => {
  const s = storeFor(t); let requests = 0;
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async url => {
    if (String(url).startsWith('data:')) return new Response(''); // SDK's local FormData capability probe.
    requests++;
    return new Response(JSON.stringify({ text: '', usage: { type: 'tokens', input_tokens: 10, output_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } });
  } });
  const language = new Language(fullCfg, s, client);
  await assert.rejects(language.transcribe({ ...job(), audio: fakeAudio }), UserError);
  await assert.rejects(language.transcribe({ ...job(), audio: { ...fakeAudio, seconds: 181 } }), UserError);
  const long = recordedVoice(); long.writeBigUInt64LE(181n * 48000n, long.lastIndexOf('OggS') + 6);
  await assert.rejects(language.transcribe({ ...job(), audio: { ...fakeAudio, data: long.toString('base64') } }), UserError);
  assert.equal(requests, 0); assert.equal(s.spend(), 0);
  await assert.rejects(language.transcribe({ ...job(), audio: { ...fakeAudio, data: recordedVoice().toString('base64') } }),
    (e: unknown) => e instanceof UserError && e.english.includes('could not hear'));
  assert.equal(requests, 1);
});

test('WhatsApp voice upload persists encrypted media and retries with one distinct stable message ID', async t => {
  const s = storeFor(t); let uploads = 0, relays = 0;
  const messages: proto.IMessage[] = [], ids: string[] = [];
  const fakeSocket = {
    waUploadToServer: async (path: string) => {
      uploads++; const encrypted = readFileSync(path);
      assert.notDeepEqual(encrypted.subarray(0, 4), Buffer.from('OggS'));
      return { mediaUrl: 'https://example.invalid/encrypted-audio', directPath: '/encrypted-audio' };
    },
    relayMessage: async (jid: string, message: proto.IMessage, options: { messageId: string }) => {
      assert.equal(jid, '123@lid'); messages.push(message); ids.push(options.messageId);
      if (++relays === 1) throw new RetryableError('lost acknowledgement');
      return options.messageId;
    },
  } as unknown as WASocket;
  const wa = new WhatsApp(fullCfg, s, () => {});
  (wa as unknown as { socket: WASocket }).socket = fakeSocket; wa.ready = true;
  s.set('route:' + members[0]!.phone, '123@lid');
  const audio = { ...fakeAudio, data: recordedVoice().toString('base64') };
  await assert.rejects(wa.sendAudio(members[0]!.phone, audio, 'one'), RetryableError);
  await wa.sendAudio(members[0]!.phone, audio, 'one');
  assert.equal(uploads, 1); assert.equal(ids[0], ids[1]);
  assert.equal(messages[1]!.audioMessage?.ptt, true);
  assert.equal(messages[1]!.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
  assert.deepEqual(messages[0]!.audioMessage?.mediaKey, messages[1]!.audioMessage?.mediaKey);
  const raw = String(s.db.prepare("SELECT value FROM vault WHERE key LIKE 'wa:out:%'").get()!.value);
  assert.ok(!raw.includes('/encrypted-audio'));
});

test('a long agenda cannot make subsequent model context exceed its character budget', t => {
  const s = storeFor(t);
  for (let i = 0; i < 12; i++) s.addHistory('a', 'assistant', 'x'.repeat(20000));
  const history = s.history('a');
  assert.ok(history.reduce((n, message) => n + message.content.length, 0) <= POLICY.maxInputChars);
  assert.ok(history.length > 1); assert.match(history[0]!.content, /shortened/);
});
