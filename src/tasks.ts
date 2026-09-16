import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { POLICY, type Member } from './config.js';
import { Store, type Job } from './store.js';
import type { Messenger } from './worker.js';
import type { Intent } from './domain.js';
import { deadline, dueMillis, nextReminder, relativeTime, reminderTime, taskCommandSchema, taskError,
  type SharedTask, type TaskCommand, type TaskLanguage, type TaskNotice, type TaskReminder, type ReminderRecipient } from './task-domain.js';

export interface TaskPlan { kind: 'task'; intent: Intent; reply: string; }
interface TaskState { tasks: SharedTask[]; notices: TaskNotice[]; }
interface TaskList { at: number; ids: string[]; }
const stateKey = 'shared-tasks';
const idFor = (value: string) => createHash('sha256').update(value).digest('hex');
const choose = (he: boolean, en: string, hebrew: string) => he ? hebrew : en;

/** Task changes, notifications and the job's replay receipt commit together. */
export class Tasks {
  private nextPrune = 0;
  constructor(private store: Store, private members: Member[], private now: () => number = Date.now) {}
  private state(): TaskState { return this.store.get<TaskState>(stateKey) ?? { tasks: [], notices: [] }; }
  private save(state: TaskState): void { this.store.set(stateKey, state); }
  private member(phone: string): Member {
    const person = this.members.find(m => m.phone === phone);
    if (!person) return taskError('Only configured family members can use tasks.', 'רק בני המשפחה המוגדרים יכולים להשתמש במשימות.');
    return person;
  }
  private person(value: string, sender: string): string | null {
    if (value === 'unassigned') return null;
    if (value === 'self') return sender;
    return this.member(value).phone;
  }
  private name(phone: string | null, he: boolean): string {
    return phone ? this.member(phone).name : choose(he, 'Unassigned', 'ללא אחראי');
  }
  private stamp(ms: number, zone: string): string { return DateTime.fromMillis(ms, { zone }).toFormat('dd/LL/yyyy HH:mm') + ` (${zone})`; }
  private summary(task: SharedTask, he: boolean): string {
    const due = task.due ? `${task.status === 'active' && dueMillis(task.due) <= this.now() ? choose(he, 'overdue', 'באיחור') : choose(he, 'due', 'יעד')} ${task.due.value.replace('T', ' ')} (${task.due.zone})` : choose(he, 'no deadline', 'ללא מועד יעד');
    return `${task.title} — ${this.name(task.owner, he)} · ${due}`;
  }
  private schedules(task: SharedTask, he: boolean): string {
    const lines = task.reminders.flatMap(r => r.recipients.filter(p => p.sent < 2).map(p =>
      `${this.name(p.phone, he)}: ${p.sent === 0 ? this.stamp(p.first, r.zone) + '; ' : ''}${this.stamp(p.second, r.zone)}`));
    return lines.length ? `\n${choose(he, 'Reminders', 'תזכורות')}:\n${lines.join('\n')}` : '';
  }
  context(chat: string): object {
    this.member(chat);
    const tasks = this.state().tasks;
    const list = this.store.get<TaskList>('task-list:' + chat);
    const valid = list && this.now() - list.at < POLICY.retentionDays * 86400000;
    const focus = this.store.get<{ at: number; id: string }>('task-focus:' + chat);
    const currentFocus = focus && this.now() - focus.at < POLICY.retentionDays * 86400000 ? focus : undefined;
    const candidates = tasks.filter(t => t.status === 'active' || (valid && list.ids.includes(t.id)) || t.id === currentFocus?.id)
      .sort((x, y) => Number(y.id === currentFocus?.id) - Number(x.id === currentFocus?.id));
    const included: { id: string; title: string; owner: string | null; due: SharedTask['due']; status: SharedTask['status'] }[] = [];
    let bytes = 0;
    for (const t of candidates) {
      const item = { id: t.id, title: t.title, owner: t.owner, due: t.due, status: t.status };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > POLICY.taskContextBytes || included.length >= POLICY.taskContextLimit) break;
      included.push(item); bytes += size;
    }
    return {
      members: this.members.map(m => ({ name: m.name, phone: m.phone })), senderPhone: chat,
      tasks: included, omittedCount: candidates.length - included.length,
      latestList: valid ? list.ids.slice(0, POLICY.taskContextLimit).map((id, index) => ({ number: index + 1, id })) : [],
      latestTaskMention: currentFocus,
      resolveOtherTitlesInCode: true,
    };
  }
  private target(command: TaskCommand, state: TaskState, chat: string): SharedTask {
    let id = command.taskId;
    if (command.number !== null) {
      const list = this.store.get<TaskList>('task-list:' + chat);
      if (!list || this.now() - list.at >= POLICY.retentionDays * 86400000 || !list.ids[command.number - 1]) {
        return taskError('Please ask for a fresh task list and choose a number from it.', 'נא לבקש רשימת משימות חדשה ולבחור מספר מתוכה.');
      }
      id = list.ids[command.number - 1]!;
    }
    if (id && (!command.targetTitle || command.number !== null)) {
      const task = state.tasks.find(t => t.id === id);
      if (task) return task;
    } else if (command.targetTitle) {
      const normalized = this.normalize(command.targetTitle);
      const candidates = state.tasks.filter(t => command.operation === 'restore' || command.operation === 'details' ? true : t.status === 'active');
      const exact = candidates.filter(t => this.normalize(t.title) === normalized);
      const matches = exact.length ? exact : candidates.filter(t => this.normalize(t.title).includes(normalized));
      if (matches.length === 1) return matches[0]!;
    }
    return taskError('Which task do you mean? Ask for the task list and select its number.', 'לאיזו משימה הכוונה? אפשר לבקש רשימה ולבחור מספר.');
  }
  private normalize(text: string): string { return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim(); }
  private duplicate(a: string, b: string): boolean {
    const x = this.normalize(a), y = this.normalize(b);
    if (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)))) return true;
    const left = new Set(x.split(' ')), right = new Set(y.split(' '));
    const common = [...left].filter(word => right.has(word)).length;
    return common / Math.max(left.size, right.size) >= 0.8;
  }
  private notice(state: TaskState, task: SharedTask, job: Job, language: TaskLanguage, verb: string, hebrew: string): void {
    for (const member of this.members.filter(m => m.phone !== job.chat)) {
      const lang = this.store.get<TaskLanguage>('task-language:' + member.phone) ?? language;
      const text = `${this.member(job.chat).name} ${choose(lang === 'he', verb, hebrew)}:\n${this.summary(task, lang === 'he')}`;
      state.notices.push({ id: idFor(job.id + ':task-notice:' + member.phone), taskId: task.id, phone: member.phone, text, attempts: 0, retryAt: 0 });
    }
  }
  private setReminder(task: SharedTask, command: NonNullable<TaskCommand['reminder']>, job: Job, language: TaskLanguage, zone: string): void {
    let phones: string[];
    if (command.recipients === 'self') phones = [job.chat];
    else if (command.recipients === 'both') phones = this.members.map(m => m.phone);
    else if (command.recipients === 'person') phones = [this.member(command.person ?? '').phone];
    else phones = task.owner ? [task.owner] : this.members.map(m => m.phone);
    const relative = command.daysBeforeDue !== null ? { days: command.daysBeforeDue, time: command.time ?? `${String(POLICY.taskReminderHour).padStart(2, '0')}:00` } : undefined;
    if (relative && command.at) taskError('Choose a fixed reminder time or a deadline-relative reminder.', 'יש לבחור תזכורת בתאריך קבוע או יחסית למועד היעד.');
    const reminderZone = relative ? task.due?.zone ?? zone : zone;
    const first = relative ? relativeTime(task.due, relative.days, relative.time) : command.at ? reminderTime(command.at, reminderZone) :
      taskError('When should I remind you?', 'מתי להזכיר?');
    if (first < this.now()) taskError('That reminder time has passed. What future time should I use?', 'מועד התזכורת עבר. מתי להזכיר בעתיד?');
    for (const r of task.reminders) r.recipients = r.recipients.filter(p => !phones.includes(p.phone));
    task.reminders = task.reminders.filter(r => r.recipients.length);
    task.reminders.push({ id: idFor(job.id + ':reminder'), followOwner: command.recipients === 'default', language, zone: reminderZone, relative,
      recipients: phones.map(phone => ({ phone, first, second: nextReminder(first, reminderZone), sent: 0, attempts: 0, retryAt: 0 })) });
  }
  private reassign(task: SharedTask): void {
    const phones = task.owner ? [task.owner] : this.members.map(m => m.phone);
    for (const r of task.reminders.filter(r => r.followOwner)) {
      // Preserve consumed notifications; a reassignment is not a new request.
      const template = [...r.recipients].sort((a, b) => b.sent - a.sent || (b.lastSent ?? 0) - (a.lastSent ?? 0))[0];
      if (!template) continue;
      const explicit = new Set(task.reminders.filter(other => !other.followOwner).flatMap(other => other.recipients.map(p => p.phone)));
      r.recipients = phones.filter(phone => !explicit.has(phone)).map(phone => {
        const existing = r.recipients.find(p => p.phone === phone);
        if (existing) return existing;
        return { ...template, phone, delivery: undefined, attempts: 0, retryAt: 0, blocked: false };
      });
    }
    task.reminders = task.reminders.filter(r => r.recipients.length);
  }
  private moveRelative(task: SharedTask): void {
    for (const r of task.reminders.filter(r => r.relative)) {
      if (!task.due) { r.recipients = []; continue; }
      const first = relativeTime(task.due, r.relative!.days, r.relative!.time);
      r.zone = task.due.zone;
      for (const p of r.recipients.filter(p => p.sent < 2)) {
        p.first = first;
        p.second = Math.max(nextReminder(first, r.zone), (p.lastSent ?? -Infinity) + POLICY.taskReminderGapHours * 3600000);
        p.delivery = undefined; p.attempts = 0; p.retryAt = 0; p.blocked = false;
      }
    }
    task.reminders = task.reminders.filter(r => r.recipients.length);
  }
  apply(intent: Intent, job: Job): TaskPlan {
    this.member(job.chat);
    const command = taskCommandSchema.parse(intent.task);
    if (intent.question || intent.action !== 'task') taskError('Please clarify the task request.', 'נא להבהיר את בקשת המשימה.');
    if (command.repeating) taskError('Recurring tasks and repeating reminders are not supported yet. Each reminder request sends two notifications; snoozing is supported.', 'משימות ותזכורות חוזרות עדיין אינן נתמכות. כל בקשת תזכורת כוללת שתי הודעות; אפשר לדחות תזכורת.');
    const he = intent.language === 'he', now = this.now(), zone = command.timezone ?? POLICY.timezone;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.store.db.prepare('SELECT plan FROM jobs WHERE id=?').get(job.id);
      if (!existing) throw new Error('Task operations require a persisted inbound job.');
      if (existing?.plan) {
        const saved = this.store.decrypt<TaskPlan>(String(existing.plan));
        if (saved.kind === 'task') { this.store.db.exec('COMMIT'); return saved; }
      }
      const state = this.state();
      let reply: string;
      if (command.operation === 'list') {
        const sunday = DateTime.fromMillis(now, { zone }).startOf('day').minus({ days: DateTime.fromMillis(now, { zone }).weekday % 7 });
        const start = command.queryStart ? reminderTime(command.queryStart.length === 10 ? command.queryStart + 'T00:00:00' : command.queryStart, zone) : sunday.toMillis();
        const end = command.queryEnd ? reminderTime(command.queryEnd.length === 10 ? command.queryEnd + 'T00:00:00' : command.queryEnd, zone) : sunday.plus({ days: 7 }).toMillis();
        if (end <= start) taskError('The end of the range must follow its start.', 'סוף הטווח חייב להיות אחרי תחילתו.');
        const tasks = state.tasks.filter(t => {
          if (t.status !== (command.filter === 'completed' ? 'completed' : command.filter === 'canceled' ? 'canceled' : 'active')) return false;
          if (command.targetTitle && !this.normalize(t.title).includes(this.normalize(command.targetTitle))) return false;
          if (command.filter === 'mine') return t.owner === job.chat;
          if (command.filter === 'unassigned') return t.owner === null;
          if (command.filter === 'overdue') return !!t.due && dueMillis(t.due) <= now;
          if (command.filter === 'due') {
            const due = t.due ? DateTime.fromISO(t.due.value, { zone: t.due.zone }).toMillis() : NaN;
            return due >= start && due < end;
          }
          return true;
        }).sort((a, b) => (a.due ? dueMillis(a.due) : Infinity) - (b.due ? dueMillis(b.due) : Infinity) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        this.store.set('task-list:' + job.chat, { at: now, ids: tasks.map(t => t.id) });
        reply = `${choose(he, command.filter === 'completed' ? 'Completed tasks' : command.filter === 'canceled' ? 'Canceled tasks' : 'Open tasks', command.filter === 'completed' ? 'משימות שהושלמו' : command.filter === 'canceled' ? 'משימות שבוטלו' : 'משימות פעילות')} — ${tasks.length}`;
        if (tasks.length) reply += '\n' + tasks.map((t, i) => `${i + 1}. ${this.summary(t, he)}`).join('\n');
      } else {
        let task: SharedTask;
        if (command.operation === 'create') {
          if (!command.title?.trim() || command.title.length > POLICY.taskTitleChars) taskError('Please provide a short task title.', 'נא לציין כותרת קצרה למשימה.');
          const duplicate = state.tasks.find(t => t.status === 'active' && this.duplicate(t.title, command.title!));
          if (duplicate && !command.allowDuplicate) taskError(`There is already “${duplicate.title}”, assigned to ${this.name(duplicate.owner, false)}. Update it or add another?`, `כבר קיימת המשימה ״${duplicate.title}״, באחריות ${this.name(duplicate.owner, true)}. לעדכן אותה או להוסיף נוספת?`);
          task = { id: idFor(job.id + ':task'), title: command.title!.trim(), note: null,
            owner: command.owner ? this.person(command.owner, job.chat) : null, due: null,
            status: 'active', createdAt: now, updatedAt: now, closedAt: null, reminders: [] };
          state.tasks.push(task);
        } else task = this.target(command, state, job.chat);
        if (command.operation === 'details') {
          reply = `${this.summary(task, he)}\n${choose(he, 'Status', 'מצב')}: ${choose(he, task.status, { active: 'פעילה', completed: 'הושלמה', canceled: 'בוטלה' }[task.status])}${task.note ? '\n' + task.note : ''}${this.schedules(task, he)}`;
        } else {
          const creating = command.operation === 'create', editing = command.operation === 'edit';
          if (!creating && command.operation !== 'restore' && task.status !== 'active') taskError('That task is no longer active. Restore it before changing it.', 'המשימה אינה פעילה. יש לשחזר אותה לפני שינוי.');
          const oldOwner = task.owner, oldDue = JSON.stringify(task.due);
          if (creating || editing) {
            if (command.title !== null) {
              if (!command.title.trim() || command.title.length > POLICY.taskTitleChars) taskError('Please provide a short task title.', 'נא לציין כותרת קצרה למשימה.');
              task.title = command.title.trim();
            }
            if (command.note !== null && command.note.length > POLICY.taskNoteChars) taskError('Please shorten the task note.', 'נא לקצר את הערת המשימה.');
            if (command.clearNote) task.note = null; else if (command.note !== null) task.note = command.note;
            if (command.owner !== null) task.owner = this.person(command.owner, job.chat);
            if (command.clearDue) task.due = null; else if (command.due) task.due = deadline(command.due, zone);
            if (oldOwner !== task.owner) this.reassign(task);
            if (oldDue !== JSON.stringify(task.due)) this.moveRelative(task);
          }
          if (command.operation === 'complete' || command.operation === 'cancel') {
            task.status = command.operation === 'complete' ? 'completed' : 'canceled'; task.closedAt = now; task.reminders = [];
          } else if (command.operation === 'restore') {
            if (task.status === 'active') taskError('That task is already active.', 'המשימה כבר פעילה.');
            task.status = 'active'; task.closedAt = null; task.reminders = [];
          } else if (command.operation === 'snooze') {
            if (!command.reminder?.at) taskError('Until when should I snooze it?', 'עד מתי לדחות?');
            const time = reminderTime(command.reminder!.at!, zone);
            if (time <= now) taskError('Choose a future snooze time.', 'נא לבחור מועד עתידי לדחייה.');
            const pending = task.reminders.flatMap(r => r.recipients.map(p => ({ r, p }))).filter(({ p }) => p.phone === job.chat && p.sent < 2);
            if (!pending.length) taskError('No notifications remain for you. Create a new two-notification reminder?', 'לא נותרו עבורך תזכורות. ליצור תזכורת חדשה עם שתי הודעות?');
            for (const { r, p } of pending) {
              const scheduled = p.sent === 0 ? p.first : p.second;
              if (time < scheduled) taskError('Snoozing must postpone the pending notification. To choose an earlier time, request a new reminder.', 'דחייה חייבת להיות למועד מאוחר יותר. למועד מוקדם יותר, בקשו תזכורת חדשה.');
              if (p.sent === 0) { p.first = time; p.second = nextReminder(time, r.zone); }
              else p.second = Math.max(time, (p.lastSent ?? 0) + POLICY.taskReminderGapHours * 3600000);
              p.delivery = undefined; p.attempts = 0; p.retryAt = 0; p.blocked = false;
            }
          } else if (command.reminder) this.setReminder(task, command.reminder, job, intent.language, zone);
          else if (command.operation === 'remind') taskError('When should I remind you?', 'מתי להזכיר?');
          task.updatedAt = now;
          const verb = creating ? ['Created', 'נוצרה'] : command.operation === 'complete' ? ['Completed', 'הושלמה'] : command.operation === 'cancel' ? ['Canceled', 'בוטלה'] : command.operation === 'restore' ? ['Restored', 'שוחזרה'] : ['Updated', 'עודכנה'];
          reply = `${choose(he, verb[0]!, verb[1]!)}:\n${this.summary(task, he)}${this.schedules(task, he)}`;
          if (command.clearDue && oldDue !== 'null') reply += '\n' + choose(he, 'Deadline-relative reminders were removed; fixed-time reminders are unchanged.', 'תזכורות יחסיות למועד היעד הוסרו; תזכורות במועד קבוע לא השתנו.');
          if (creating && task.owner && task.owner !== job.chat) this.notice(state, task, job, intent.language, 'assigned a task', 'הקצה/תה משימה');
          else if (['complete', 'cancel', 'restore'].includes(command.operation)) this.notice(state, task, job, intent.language,
            command.operation === 'complete' ? 'completed a task' : command.operation === 'cancel' ? 'canceled a task' : 'restored a task',
            command.operation === 'complete' ? 'השלים/ה משימה' : command.operation === 'cancel' ? 'ביטל/ה משימה' : 'שחזר/ה משימה');
          else if (!creating && (oldOwner !== task.owner || oldDue !== JSON.stringify(task.due))) this.notice(state, task, job, intent.language, 'updated a task', 'עדכן/ה משימה');
        }
        this.store.set('task-focus:' + job.chat, { at: now, id: task.id });
      }
      const plan: TaskPlan = { kind: 'task', intent, reply };
      this.store.set('task-language:' + job.chat, intent.language);
      this.save(state); this.store.plan(job.id, plan);
      this.store.db.exec('COMMIT'); return plan;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  hasBlocked(): boolean {
    const state = this.state();
    return state.notices.some(n => n.blocked) || state.tasks.some(t => t.reminders.some(r => r.recipients.some(p => p.blocked)));
  }
  resume(id: string): boolean {
    const state = this.state();
    const notice = state.notices.find(n => n.id === id);
    if (notice) { notice.blocked = false; notice.attempts = 0; notice.retryAt = 0; this.save(state); return true; }
    for (const task of state.tasks) for (const r of task.reminders) if (r.id === id) {
      for (const p of r.recipients) { p.blocked = false; p.attempts = 0; p.retryAt = 0; }
      this.save(state); return true;
    }
    return false;
  }
  blockedIds(): string[] {
    const state = this.state();
    return [...state.notices.filter(n => n.blocked).map(n => n.id), ...state.tasks.flatMap(t => t.reminders.filter(r => r.recipients.some(p => p.blocked)).map(r => r.id))];
  }
  prune(): void {
    const state = this.state(), cutoff = this.now() - POLICY.taskRetentionDays * 86400000;
    const expired = new Set(state.tasks.filter(t => t.closedAt !== null && t.closedAt <= cutoff).map(t => t.id));
    state.tasks = state.tasks.filter(t => !expired.has(t.id));
    state.notices = state.notices.filter(n => !expired.has(n.taskId));
    this.save(state);
    for (const row of this.store.db.prepare("SELECT key,value FROM vault WHERE key LIKE 'task-list:%' OR key LIKE 'task-focus:%'").all()) {
      const list = this.store.decrypt<TaskList>(String(row.value));
      if (this.now() - list.at >= POLICY.retentionDays * 86400000) this.store.remove(String(row.key));
    }
  }
  maintain(): void {
    if (this.now() >= this.nextPrune) { this.prune(); this.nextPrune = this.now() + 3600000; }
  }
  /** Called under the same worker lock as inbound changes; sends at most one message. */
  async deliver(messenger: Messenger, alert: (id: string) => void): Promise<void> {
    this.maintain();
    const state = this.state(), now = this.now();
    const notice = state.notices.find(n => !n.blocked && n.retryAt <= now);
    if (notice) {
      try {
        this.member(notice.phone); await messenger.send(notice.phone, notice.text, notice.id);
      }
      catch {
        notice.attempts++; notice.retryAt = now + Math.min(300000, 1000 * 2 ** notice.attempts);
        if (notice.attempts >= POLICY.maxAttempts) { notice.blocked = true; alert(notice.id); }
        this.save(state); return;
      }
      state.notices = state.notices.filter(n => n.id !== notice.id);
      this.recordDelivery(state, notice.phone, notice.taskId, notice.text); return;
    }
    for (const task of state.tasks.filter(t => t.status === 'active')) for (const r of task.reminders) for (const p of r.recipients) {
      if (p.sent >= 2 || p.blocked || p.retryAt > now || (p.sent === 0 ? p.first : p.second) > now) continue;
      if (!p.delivery) {
        const lang = this.store.get<TaskLanguage>('task-language:' + p.phone) ?? r.language;
        p.delivery = { id: `${r.id}:${p.phone}:${p.sent}`, text: `${choose(lang === 'he', 'Reminder', 'תזכורת')}:\n${this.summary(task, lang === 'he')}`,
          consumed: p.sent === 0 && p.second <= now ? 2 : 1 };
        this.save(state);
      }
      try {
        this.member(p.phone); await messenger.send(p.phone, p.delivery.text, p.delivery.id);
      } catch {
        p.attempts++; p.retryAt = now + Math.min(300000, 1000 * 2 ** p.attempts);
        if (p.attempts >= POLICY.maxAttempts) { p.blocked = true; alert(r.id); }
        this.save(state); return;
      }
      p.sent += p.delivery.consumed; p.lastSent = this.now();
      if (p.sent === 1) p.second = nextReminder(p.lastSent, r.zone);
      const text = p.delivery.text;
      p.delivery = undefined; p.attempts = 0; p.retryAt = 0;
      this.recordDelivery(state, p.phone, task.id, text); return;
    }
  }
  private recordDelivery(state: TaskState, chat: string, taskId: string, text: string): void {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(state);
      this.store.addHistory(chat, 'assistant', text);
      this.store.set('task-focus:' + chat, { at: this.now(), id: taskId });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}
