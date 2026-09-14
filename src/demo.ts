import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Calendar } from './calendar.js';
import { Worker } from './worker.js';
import type { GraphPort } from './microsoft.js';
import type { Intent, CalendarEvent } from './domain.js';

export async function demo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mazkir-demo-'));
  const store = new Store(dir, randomBytes(32).toString('hex'));
  const graph: GraphPort = {
    all: async <T>() => [] as T[],
    request: async <T>(_method: string, _path: string, body?: unknown) => ({ id: 'demo-event', ...body as object } as T),
  };
  const intent: Intent = { action: 'create', language: 'en', title: 'Pick up son for judo',
    start: '2099-09-09T16:00:00', end: null, timezone: null, location: null, eventId: null,
    scope: 'occurrence', targetSelection: 'none', recurrence: null, question: null, queryStart: null, queryEnd: null };
  const calendar = new Calendar(graph, { organizerEmail: 'agent@example.com', members: [
    { name: 'Parent 1', phone: '15550000001', email: 'parent1@example.com' },
    { name: 'Parent 2', phone: '15550000002', email: 'parent2@example.com' },
  ] });
  const worker = new Worker(store, calendar, {
    interpret: async () => intent, transcribe: async job => job.text,
  }, { send: async (_chat, text) => console.log(text) }, () => { throw new Error('Demo blocked'); });
  console.log('OFFLINE DEMO — scripted interpretation and simulated Microsoft/WhatsApp. No invitations sent.');
  store.enqueue({ id: 'demo', chat: 'parent1', actor: 'Parent 1', at: new Date().toISOString(), text: 'Schedule judo pickup September 9, 2099 at 16:00.' });
  await worker.tick(); await worker.tick();
  if (store.next() || store.hasBlocked()) throw new Error('Demo did not complete.');
  store.close();
}
