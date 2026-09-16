// Explicit paid model evaluation with synthetic identities/content and an isolated ledger.
// No WhatsApp or Microsoft clients are constructed.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { Store, type Job } from './store.js';
import { Tasks } from './tasks.js';
import { Language } from './language.js';
import type { Intent } from './domain.js';
import { taskCommandSchema } from './task-domain.js';

const members = [
  { name: 'Alex', phone: '15550000001', email: 'a@example.com' },
  { name: 'Dana', phone: '15550000002', email: 'b@example.com' },
];
const cfg = { ...config(), members, aiCap: 0.50 };
const store = new Store(mkdtempSync(join(tmpdir(), 'mazkir-task-eval-')), randomBytes(32).toString('hex'));
const language = new Language(cfg, store), tasks = new Tasks(store, members);
const cases: { text: string; check(i: Intent): void; apply?: boolean }[] = [
  { text: 'Add a shared task: submit the school form by September 18, 2099.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'create'); assert.ok(i.task.owner === null || i.task.owner === 'unassigned'); assert.equal(i.task.due, '2099-09-18'); assert.equal(i.task.reminder, null); } },
  { text: 'תוסיף משימה לדנה: להזמין תור לרופא שיניים.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.language, 'he'); assert.equal(i.task?.operation, 'create'); assert.equal(i.task.owner, members[1]!.phone); } },
  { text: 'Show our tasks.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'list'); assert.equal(i.task.filter, 'all'); } },
  { text: 'Remind me about task 1 on September 17, 2099.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'remind'); assert.equal(i.task.number, 1); assert.equal(i.task.reminder?.recipients, 'self'); assert.ok(i.task.reminder.at?.startsWith('2099-09-17')); assert.equal(i.task.owner, null); } },
  { text: 'Remind both of us about task 1 the day before it is due at 8 PM.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.reminder?.daysBeforeDue, 1); assert.equal(i.task.reminder.time, '20:00'); assert.equal(i.task.reminder.recipients, 'both'); } },
  { text: 'For task 1, תשנה את ה-note ל: bring the signed form.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'edit'); assert.match(i.task.note ?? '', /bring the signed form/i); } },
  { text: 'סמן את משימה 2 כבוצעה.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'complete'); assert.equal(i.task.number, 2); } },
  { text: 'Reopen task 2.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'restore'); } },
  { text: 'Delete task 2.', apply: true,
    check: i => { assert.equal(i.action, 'task'); assert.equal(i.task?.operation, 'cancel'); } },
  { text: 'Add a recurring task to clean filters every month.',
    check: i => { assert.ok(i.action === 'clarify' || (i.action === 'task' && i.task?.repeating)); } },
  { text: 'Schedule a dentist appointment on September 20, 2099 at 10 AM.',
    check: i => { assert.equal(i.action, 'create'); assert.equal(i.task, null); assert.ok(i.start?.startsWith('2099-09-20T10:00')); } },
];
let last: Intent | undefined;
try {
  for (const [index, item] of cases.entries()) {
    const job: Job = { id: `task-eval-${index}`, chat: members[0]!.phone, actor: members[0]!.name,
      text: item.text, at: new Date().toISOString(), status: 'pending', attempts: 0, nextAt: 0 };
    last = await language.interpretInitial(job);
    item.check(last);
    if (item.apply) {
      taskCommandSchema.parse(last.task);
      store.enqueue(job);
      const plan = tasks.apply(last, job);
      store.readyReply(job, plan.reply); store.complete(job.id);
    }
    console.log(`PASS shared-task scenario ${index + 1}`);
  }
  console.log(`PASS ${cases.length}/${cases.length} synthetic shared-task scenarios.`);
} catch (error) {
  const e = error as { name?: string; status?: number };
  console.error(`Task evaluation failed: ${e.name ?? 'error'}${e.status ? ` (HTTP ${e.status})` : ''}.`);
  if (error instanceof assert.AssertionError) console.error('Synthetic result:', JSON.stringify(last));
  process.exitCode = 1;
} finally {
  console.log(`Recorded evaluation spend $${store.spend().toFixed(4)}; per-run ceiling $0.50. No calendar or WhatsApp writes.`);
  store.close();
}
