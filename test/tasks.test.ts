import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { Store, type Job } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { deadline, dueMillis, nextReminder, reminderTime, type SharedTask, type TaskCommand, type TaskNotice } from '../src/task-domain.js';
import { type Intent } from '../src/domain.js';
import { POLICY, UserError } from '../src/config.js';
import { Worker } from '../src/worker.js';
import { Calendar } from '../src/calendar.js';
import { Language, responseSchema } from '../src/language.js';
import type OpenAI from 'openai';
import type { Config } from '../src/config.js';
import { zodResponseFormat } from 'openai/helpers/zod';

const members = [{ name: 'Alex', phone: '15550000001', email: 'a@example.com' }, { name: 'Dana', phone: '15550000002', email: 'b@example.com' }];
const a = members[0]!.phone, b = members[1]!.phone;
const ms = (value: string) => DateTime.fromISO(value, { zone: POLICY.timezone }).toMillis();
const command = (patch: Partial<TaskCommand> = {}): TaskCommand => ({ operation: 'create', taskId: null, number: null, targetTitle: null,
  title: 'Book dentist', note: null, clearNote: false, owner: null, due: null, clearDue: false, timezone: null,
  reminder: null, filter: 'all', queryStart: null, queryEnd: null, allowDuplicate: false, repeating: false, ...patch });
const reminder = (at: string, recipients: 'default' | 'self' | 'both' = 'default') => ({ at, recipients, person: null, daysBeforeDue: null, time: null });
const intent = (task: TaskCommand, language: 'en' | 'he' = 'en'): Intent => ({ action: 'task', task, language, question: null,
  eventId: null, targetSelection: 'none', title: null, start: null, end: null, timezone: null, location: null,
  scope: 'occurrence', recurrence: null, queryStart: null, queryEnd: null });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mazkir-tasks-')), key = randomBytes(32).toString('hex');
  const store = new Store(dir, key);
  let now = ms('2026-09-15T08:00:00'), count = 0;
  const tasks = new Tasks(store, members, () => now);
  t.after(() => {
    store.close();
    const path = resolve(dir), parent = resolve(tmpdir());
    if (!path.startsWith(parent + sep) || !path.slice(parent.length + 1).startsWith('mazkir-tasks-')) throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true });
  });
  const state = () => store.get<{ tasks: SharedTask[]; notices: TaskNotice[] }>('shared-tasks') ?? { tasks: [], notices: [] };
  const makeJob = (chat = a): Job => ({ id: `task-job-${++count}`, chat, actor: chat === a ? 'Alex' : 'Dana', at: new Date(now).toISOString(),
    text: 'Synthetic task request', status: 'pending', attempts: 0, nextAt: 0 });
  const apply = (patch: Partial<TaskCommand>, chat = a, language: 'en' | 'he' = 'en') => {
    const job = makeJob(chat); store.enqueue(job);
    return tasks.apply(intent(command(patch), language), job);
  };
  const sent: { chat: string; text: string; id: string }[] = [];
  const messenger = { send: async (chat: string, text: string, id: string) => { sent.push({ chat, text, id }); } };
  return { dir, key, store, tasks, state, apply, makeJob, sent, messenger, setTime: (value: string) => { now = ms(value); },
    deliver: () => tasks.deliver(messenger, id => { throw new Error('Unexpected blocked delivery ' + id); }) };
}

test('task creation defaults, encryption, authorization and deadline-only behavior', t => {
  const f = fixture(t);
  const result = f.apply({ due: '2026-09-18', note: 'Referral number 12345' });
  assert.match(result.reply, /Unassigned/);
  assert.equal(f.state().tasks[0]!.owner, null);
  assert.equal(f.state().tasks[0]!.reminders.length, 0);
  assert.equal(f.state().notices.length, 0);
  assert.ok(!String(f.store.db.prepare("SELECT value FROM vault WHERE key='shared-tasks'").get()!.value).includes('Referral'));
  assert.throws(() => f.apply({ title: 'Unauthorized' }, '15559999999'), UserError);
  assert.throws(() => f.apply({ title: 'Bad owner', owner: '15559999999' }), UserError);
  assert.equal(f.state().tasks.length, 1);
});

test('assignment, edits, completion and restoration have the specified notification policy', async t => {
  const f = fixture(t);
  f.apply({ owner: b, due: '2026-09-18' });
  assert.equal(f.state().notices.length, 1);
  await f.deliver(); assert.equal(f.sent[0]!.chat, b); assert.match(f.sent[0]!.text, /Alex assigned/);
  const id = f.state().tasks[0]!.id;
  f.apply({ operation: 'edit', taskId: id, title: 'Call dental clinic', note: 'Bring referral' });
  assert.equal(f.state().notices.length, 0);
  f.apply({ operation: 'edit', taskId: id, title: null, owner: 'unassigned', due: '2026-09-19' });
  assert.equal(f.state().notices.length, 1);
  f.apply({ operation: 'complete', taskId: id }, b);
  assert.equal(f.state().tasks[0]!.status, 'completed');
  assert.equal(f.state().notices.at(-1)!.phone, a);
  f.apply({ operation: 'restore', taskId: id });
  assert.equal(f.state().tasks[0]!.note, 'Bring referral');
  assert.equal(f.state().tasks[0]!.due!.value, '2026-09-19');
  assert.equal(f.state().tasks[0]!.reminders.length, 0);
  f.apply({ operation: 'cancel', taskId: id });
  f.apply({ operation: 'restore', taskId: id }, b);
  assert.equal(f.state().tasks[0]!.status, 'active');
});

test('date-only deadlines expire at midnight; reminders default to 09:00 and span DST safely', () => {
  assert.equal(dueMillis(deadline('2026-09-18', POLICY.timezone)), ms('2026-09-19T00:00:00'));
  assert.equal(reminderTime('2026-09-18', POLICY.timezone), ms('2026-09-18T09:00:00'));
  const spring = ms('2027-03-25T09:00:00');
  assert.equal(nextReminder(spring, POLICY.timezone), ms('2027-03-27T09:00:00'));
  const fall = ms('2026-10-24T09:00:00');
  assert.equal(nextReminder(fall, POLICY.timezone), ms('2026-10-25T09:00:00'));
  assert.throws(() => deadline('2026-02-30', POLICY.timezone), UserError);
});

test('two notifications per recipient, no third, and overdue messages', async t => {
  const f = fixture(t);
  f.apply({ due: '2026-09-15', reminder: reminder('2026-09-15') });
  f.setTime('2026-09-15T09:00:00'); await f.deliver(); await f.deliver();
  assert.deepEqual(f.sent.map(s => s.chat), [a, b]);
  f.setTime('2026-09-16T08:59:59'); await f.deliver(); assert.equal(f.sent.length, 2);
  f.setTime('2026-09-16T09:00:00'); await f.deliver(); await f.deliver();
  assert.equal(f.sent.length, 4); assert.match(f.sent.at(-1)!.text, /overdue/);
  f.setTime('2026-09-20T09:00:00'); await f.deliver(); assert.equal(f.sent.length, 4);
  assert.equal(new Set(f.sent.map(s => s.id)).size, 4);
  assert.match(f.store.history(a).at(-1)!.content, /Reminder/);
});

test('downtime collapses two missed notifications and delays the remaining one from actual delivery', async t => {
  const f = fixture(t);
  f.apply({ owner: 'self', reminder: reminder('2026-09-15T09:00:00') });
  f.setTime('2026-09-15T12:00:00'); await f.deliver();
  assert.equal(f.state().tasks[0]!.reminders[0]!.recipients[0]!.second, ms('2026-09-16T12:00:00'));
  f.setTime('2026-09-16T11:00:00'); await f.deliver(); assert.equal(f.sent.length, 1);
  f.setTime('2026-09-16T12:00:00'); await f.deliver(); assert.equal(f.sent.length, 2);
  f.apply({ title: 'Other task', reminder: reminder('2026-09-17T09:00:00', 'self') });
  f.setTime('2026-09-20T12:00:00'); await f.deliver(); await f.deliver();
  assert.equal(f.sent.length, 3);
  assert.equal(f.state().tasks[1]!.reminders[0]!.recipients[0]!.sent, 2);
});

test('snoozing only changes the sender; exhausted schedules require a new request', async t => {
  const f = fixture(t);
  f.apply({ reminder: reminder('2026-09-15') });
  const id = f.state().tasks[0]!.id;
  f.setTime('2026-09-15T09:00:00'); await f.deliver(); await f.deliver();
  f.apply({ operation: 'snooze', taskId: id, reminder: reminder('2026-09-17T10:00:00') });
  const recipients = f.state().tasks[0]!.reminders[0]!.recipients;
  assert.equal(recipients.find(p => p.phone === a)!.second, ms('2026-09-17T10:00:00'));
  assert.equal(recipients.find(p => p.phone === b)!.second, ms('2026-09-16T09:00:00'));
  f.setTime('2026-09-17T10:00:00'); await f.deliver(); await f.deliver();
  assert.throws(() => f.apply({ operation: 'snooze', taskId: id, reminder: reminder('2026-09-18T10:00:00') }), /No notifications remain/);
  assert.equal(f.state().tasks[0]!.reminders[0]!.recipients[0]!.sent, 2);
});

test('new reminder request replaces only intended recipients with a fresh pair', t => {
  const f = fixture(t);
  f.apply({ reminder: reminder('2026-09-16') });
  const id = f.state().tasks[0]!.id;
  f.apply({ operation: 'remind', taskId: id, reminder: reminder('2026-09-17', 'self') });
  const entries = f.state().tasks[0]!.reminders.flatMap(r => r.recipients);
  assert.equal(entries.length, 2);
  assert.equal(entries.find(p => p.phone === a)!.first, ms('2026-09-17T09:00:00'));
  assert.equal(entries.find(p => p.phone === b)!.first, ms('2026-09-16T09:00:00'));
  f.apply({ operation: 'remind', taskId: id, reminder: reminder('2026-09-18', 'both') });
  assert.equal(f.state().tasks[0]!.reminders.length, 1);
});

test('reassignment preserves consumed count and explicit recipient selection', async t => {
  const f = fixture(t);
  f.apply({ owner: 'self', reminder: reminder('2026-09-15') });
  const id = f.state().tasks[0]!.id;
  f.setTime('2026-09-15T09:00:00'); await f.deliver();
  f.apply({ operation: 'edit', taskId: id, title: null, owner: b });
  const p = f.state().tasks[0]!.reminders[0]!.recipients[0]!;
  assert.equal(p.phone, b); assert.equal(p.sent, 1); assert.equal(p.second, ms('2026-09-16T09:00:00'));
  f.apply({ operation: 'remind', taskId: id, reminder: reminder('2026-09-17', 'self') });
  f.apply({ operation: 'edit', taskId: id, title: null, owner: 'unassigned' });
  assert.equal(f.state().tasks[0]!.reminders.find(r => !r.followOwner)!.recipients[0]!.phone, a);
  assert.equal(f.state().tasks[0]!.reminders.flatMap(r => r.recipients).filter(p => p.phone === a).length, 1);
});

test('relative deadline edits move only unsent notifications; fixed reminders stay put', async t => {
  const f = fixture(t);
  f.apply({ owner: 'self', due: '2026-09-17', reminder: { at: null, daysBeforeDue: 1, time: '09:00', recipients: 'default', person: null } });
  const id = f.state().tasks[0]!.id;
  f.apply({ operation: 'remind', taskId: id, reminder: { ...reminder('2026-09-20'), recipients: 'person', person: b } });
  f.setTime('2026-09-16T09:00:00'); await f.deliver();
  f.apply({ operation: 'edit', taskId: id, title: null, due: '2026-09-15' });
  const task = f.state().tasks[0]!;
  assert.equal(task.reminders[0]!.recipients[0]!.sent, 1);
  assert.equal(task.reminders[0]!.recipients[0]!.second, ms('2026-09-17T09:00:00'));
  assert.equal(task.reminders[1]!.recipients[0]!.first, ms('2026-09-20T09:00:00'));
  f.apply({ operation: 'edit', taskId: id, title: null, clearDue: true });
  assert.equal(f.state().tasks[0]!.reminders.length, 1);
  assert.equal(f.state().tasks[0]!.reminders[0]!.relative, undefined);
});

test('completion and cancellation stop pending deliveries; restore never restarts them', async t => {
  const f = fixture(t);
  f.apply({ reminder: reminder('2026-09-15', 'self') });
  const id = f.state().tasks[0]!.id;
  f.setTime('2026-09-15T09:00:00'); await f.deliver();
  f.apply({ operation: 'complete', taskId: id }, b);
  assert.equal(f.state().tasks[0]!.reminders.length, 0);
  await f.deliver();
  f.apply({ operation: 'restore', taskId: id }); await f.deliver();
  f.setTime('2026-09-18T09:00:00'); await f.deliver();
  assert.equal(f.sent.filter(s => s.text.startsWith('Reminder')).length, 1);
  f.apply({ operation: 'remind', taskId: id, reminder: reminder('2026-09-19') });
  f.apply({ operation: 'cancel', taskId: id });
  assert.equal(f.state().tasks[0]!.reminders.length, 0);
});

test('numbered lists are per-chat, filter correctly, and recheck current task status', t => {
  const f = fixture(t);
  f.apply({ title: 'Undated', owner: 'self' });
  f.apply({ title: 'Due soon', owner: b, due: '2026-09-17' });
  f.apply({ title: 'Overdue', due: '2026-09-14' });
  const all = f.apply({ operation: 'list' });
  assert.match(all.reply, /1\. Overdue[\s\S]*2\. Due soon[\s\S]*3\. Undated/);
  f.apply({ operation: 'list', filter: 'mine' }, b);
  f.apply({ operation: 'complete', number: 1 }, b);
  assert.equal(f.state().tasks.find(task => task.title === 'Due soon')!.status, 'completed');
  f.apply({ operation: 'complete', number: 1 });
  assert.equal(f.state().tasks.find(task => task.title === 'Overdue')!.status, 'completed');
  assert.throws(() => f.apply({ operation: 'complete', number: 2 }), /no longer active/);
  assert.match(f.apply({ operation: 'list', filter: 'completed' }).reply, /Completed tasks — 2/);
});

test('duplicates, ambiguity, invalid reminders and deferred recurrence never partially create tasks', t => {
  const f = fixture(t);
  f.apply({});
  assert.throws(() => f.apply({}), /already/);
  assert.throws(() => f.apply({ title: 'Invalid', due: '2026-02-30' }), UserError);
  assert.throws(() => f.apply({ title: 'Repeating', repeating: true }), /not supported/);
  assert.throws(() => f.apply({ title: 'Past reminder', reminder: reminder('2026-09-14') }), /passed/);
  assert.equal(f.state().tasks.length, 1);
  f.apply({ allowDuplicate: true });
  assert.throws(() => f.apply({ operation: 'complete', targetTitle: 'Book dentist' }), /Which task/);
  f.apply({ operation: 'complete', taskId: f.state().tasks[0]!.id });
  f.apply({ operation: 'complete', taskId: f.state().tasks[1]!.id });
  f.apply({}); assert.equal(f.state().tasks.length, 3);
});

test('atomic task receipt survives reprocessing and store reopen without another assignment notification', t => {
  const f = fixture(t), job = f.makeJob(); f.store.enqueue(job);
  const first = f.tasks.apply(intent(command({ owner: b })), job);
  const reopened = new Store(f.dir, f.key);
  try {
    const tasks = new Tasks(reopened, members);
    assert.deepEqual(tasks.apply(intent(command({ owner: b })), job), first);
    assert.equal(f.state().tasks.length, 1); assert.equal(f.state().notices.length, 1);
  } finally { reopened.close(); }
});

test('uncertain notification delivery retries one stable ID, blocks and can resume', async t => {
  const f = fixture(t);
  f.apply({ owner: b });
  const ids: string[] = [], alerts: string[] = [];
  const broken = { send: async (_chat: string, _text: string, id: string) => { ids.push(id); throw new Error('uncertain transport'); } };
  for (let i = 0; i < POLICY.maxAttempts; i++) {
    f.setTime(`2026-09-15T${String(9 + i).padStart(2, '0')}:00:00`);
    await f.tasks.deliver(broken, id => alerts.push(id));
  }
  assert.equal(new Set(ids).size, 1); assert.equal(alerts.length, 1); assert.equal(f.tasks.hasBlocked(), true);
  assert.equal(f.tasks.resume(alerts[0]!), true);
  await f.deliver(); assert.equal(f.sent[0]!.id, ids[0]); assert.equal(f.tasks.hasBlocked(), false);
  assert.equal(f.state().tasks.length, 1);
});

test('active tasks outlive chat history; terminal content expires after 90 days', t => {
  const f = fixture(t);
  f.apply({ title: 'Keep active' }); f.apply({ title: 'Erase later', note: 'Private terminal note' });
  const id = f.state().tasks[1]!.id;
  f.apply({ operation: 'cancel', taskId: id });
  f.setTime('2026-12-13T08:00:00'); f.tasks.prune(); assert.equal(f.state().tasks.length, 2);
  f.setTime('2026-12-14T08:00:00'); f.tasks.prune();
  assert.deepEqual(f.state().tasks.map(task => task.title), ['Keep active']);
  assert.equal(f.state().notices.length, 0);
});

test('worker routes tasks without Outlook, handles voice, and resumes receipts without repeating mutations', async t => {
  const f = fixture(t), job = f.makeJob(); job.voiceReply = true; f.store.enqueue(job);
  const graph = { all: async <T>(): Promise<T[]> => { throw new Error('Tasks must not read Outlook'); }, request: async <T>(): Promise<T> => { throw new Error('Tasks must not write Outlook'); } };
  let interpretations = 0, spoken = '';
  const language = { interpretInitial: async () => { interpretations++; return intent(command({ title: 'לקבוע תור', owner: 'self' }), 'he'); },
    interpret: async () => { throw new Error('Unexpected second pass'); }, transcribe: async () => '' };
  const messenger = { ...f.messenger, sendAudio: async () => {} };
  const speech = { synthesize: async (text: string) => { spoken = text; return { data: 'synthetic', mime: 'audio/ogg', seconds: 1 }; } };
  const worker = new Worker(f.store, new Calendar(graph, { members, organizerEmail: 'agent@example.com' }), language, messenger, () => {}, speech, f.tasks);
  await worker.tick(); assert.equal(f.state().tasks.length, 1);
  await worker.tick(); assert.equal(interpretations, 1); assert.match(spoken, /לקבוע תור/);
  assert.equal(f.store.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)!.status, 'done');
});

test('structured response includes task schema and task context, preserving task commands after parse', async t => {
  const f = fixture(t);
  const schema = zodResponseFormat(responseSchema, 'request');
  assert.ok(JSON.stringify(schema).includes('daysBeforeDue'));
  let prompt = '';
  const parsed = { ...intent(command({ title: 'Book dentist', owner: 'self', reminder: reminder('2099-09-16', 'self') })), voiceReply: false };
  const client = { chat: { completions: { parse: async (request: { messages: { content: string }[] }) => {
    prompt = request.messages[0]!.content;
    return { choices: [{ message: { parsed } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
  } } } } as unknown as OpenAI;
  const cfg = { members, openaiKey: 'synthetic', aiCap: 8 } as Config;
  const result = await new Language(cfg, f.store, client).interpretInitial(f.makeJob());
  assert.equal(result.task!.owner, 'self'); assert.equal(result.action, 'task');
  assert.match(prompt, /deadline NEVER implies a reminder/); assert.match(prompt, /INITIAL PASS/);
  assert.ok(prompt.includes(a));
});

test('delivery commit failure preserves notification for stable-ID retry instead of silently dropping it', async t => {
  const f = fixture(t);
  f.apply({ owner: b });
  const original = f.store.addHistory.bind(f.store);
  f.store.addHistory = () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(f.deliver(), /synthetic disk failure/);
  assert.equal(f.state().notices.length, 1);
  f.store.addHistory = original;
  await f.deliver();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0]!.id, f.sent[1]!.id);
  assert.equal(f.state().notices.length, 0);
});

test('reminder commit failure retries the same delivery without consuming another notification', async t => {
  const f = fixture(t);
  f.apply({ owner: 'self', reminder: reminder('2026-09-15') });
  f.setTime('2026-09-15T09:00:00');
  const original = f.store.addHistory.bind(f.store);
  f.store.addHistory = () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(f.deliver(), /synthetic disk failure/);
  assert.equal(f.state().tasks[0]!.reminders[0]!.recipients[0]!.sent, 0);
  f.store.addHistory = original; await f.deliver();
  assert.equal(f.sent[0]!.id, f.sent[1]!.id);
  assert.equal(f.state().tasks[0]!.reminders[0]!.recipients[0]!.sent, 1);
});

test('worker resumes a committed task receipt after restart without model or calendar access', async t => {
  const f = fixture(t), job = f.makeJob(); f.store.enqueue(job);
  f.tasks.apply(intent(command({ owner: b })), job);
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected external request'); };
  const worker = new Worker(f.store, new Calendar({ all: unavailable, request: unavailable }, { members, organizerEmail: 'agent@example.com' }),
    { interpretInitial: unavailable, interpret: unavailable, transcribe: unavailable }, f.messenger, () => {}, undefined, f.tasks);
  await worker.tick(); await worker.tick();
  assert.equal(f.state().tasks.length, 1); assert.equal(f.state().notices.length, 1);
  await worker.tick(); assert.equal(f.state().notices.length, 0);
  assert.equal(f.sent.length, 2);
});

test('due-week and details views include notes, owner, schedules and terminal status', t => {
  const f = fixture(t);
  f.apply({ title: 'This week', due: '2026-09-18', note: 'Bring documents', reminder: reminder('2026-09-16', 'self') });
  f.apply({ title: 'Next week', due: '2026-09-21' });
  assert.match(f.apply({ operation: 'list', filter: 'due' }).reply, /Open tasks — 1\n1\. This week/);
  const details = f.apply({ operation: 'details', number: 1 }).reply;
  assert.match(details, /Bring documents/); assert.match(details, /16\/09\/2026 09:00/);
  f.apply({ operation: 'cancel', number: 1 });
  assert.match(f.apply({ operation: 'details', number: 1 }).reply, /Status: canceled/);
});

test('calendar updates still obtain candidates after the initial routing pass', async t => {
  const f = fixture(t), job = f.makeJob(); f.store.enqueue(job);
  let reads = 0, interpretations = 0;
  const graph = { all: async <T>(): Promise<T[]> => { reads++; return []; }, request: async <T>(): Promise<T> => { throw new Error('No mutation expected'); } };
  const language = { interpretInitial: async (): Promise<Intent> => ({ ...intent(command()), action: 'update', task: null }),
    interpret: async (): Promise<Intent> => { interpretations++; return { ...intent(command()), action: 'clarify', task: null, question: 'Which event?' }; }, transcribe: async () => '' };
  const worker = new Worker(f.store, new Calendar(graph, { members, organizerEmail: 'agent@example.com' }), language, f.messenger, () => {}, undefined, f.tasks);
  await worker.tick(); await worker.tick();
  assert.equal(reads, 1); assert.equal(interpretations, 1); assert.match(f.sent[0]!.text, /Which event/);
});
