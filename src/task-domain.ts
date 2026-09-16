import { z } from 'zod';
import { DateTime } from 'luxon';
import { POLICY, UserError } from './config.js';
import { localTime } from './domain.js';

export const taskCommandSchema = z.object({
  operation: z.enum(['create', 'edit', 'complete', 'cancel', 'restore', 'list', 'details', 'remind', 'snooze']),
  taskId: z.string().nullable(),
  number: z.number().int().positive().nullable().describe('Number from the latest task list in this chat'),
  targetTitle: z.string().nullable().describe('Existing task title used to identify the target'),
  title: z.string().nullable(), note: z.string().nullable(), clearNote: z.boolean(),
  owner: z.string().nullable().describe('Configured phone, self, unassigned; null means unchanged/default'),
  due: z.string().nullable().describe('YYYY-MM-DD or local ISO datetime'), clearDue: z.boolean(),
  timezone: z.string().nullable(),
  reminder: z.object({
    at: z.string().nullable().describe('Local ISO date or datetime. Date alone uses 09:00.'),
    daysBeforeDue: z.number().int().min(0).max(365).nullable(),
    time: z.string().nullable().describe('HH:mm for deadline-relative reminders; default 09:00'),
    recipients: z.enum(['default', 'self', 'both', 'person']), person: z.string().nullable(),
  }).nullable(),
  filter: z.enum(['all', 'mine', 'unassigned', 'overdue', 'due', 'completed', 'canceled']),
  queryStart: z.string().nullable(), queryEnd: z.string().nullable(),
  allowDuplicate: z.boolean().describe('True only after the user explicitly chose to add another task'),
  repeating: z.boolean().describe('True if recurring tasks or repeating reminders are requested'),
});
export type TaskCommand = z.infer<typeof taskCommandSchema>;
export type TaskLanguage = 'en' | 'he';
export interface TaskDeadline { value: string; zone: string; }
export interface ReminderRecipient {
  phone: string; sent: number; first: number; second: number; lastSent?: number;
  attempts: number; retryAt: number; blocked?: boolean;
  delivery?: { id: string; text: string; consumed: number };
}
export interface TaskReminder {
  id: string; followOwner: boolean; language: TaskLanguage; zone: string;
  relative?: { days: number; time: string };
  recipients: ReminderRecipient[];
}
export interface SharedTask {
  id: string; title: string; note: string | null; owner: string | null;
  due: TaskDeadline | null; status: 'active' | 'completed' | 'canceled';
  createdAt: number; updatedAt: number; closedAt: number | null;
  reminders: TaskReminder[];
}
export interface TaskNotice {
  id: string; taskId: string; phone: string; text: string;
  attempts: number; retryAt: number; blocked?: boolean;
}
export const taskError = (en: string, he: string): never => { throw new UserError(en, he); };
export function deadline(value: string, zone: string): TaskDeadline {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) localTime(value + 'T12:00:00', zone);
  else localTime(value, zone);
  return { value, zone };
}
export function dueMillis(due: TaskDeadline): number {
  return due.value.length === 10 ? DateTime.fromISO(due.value, { zone: due.zone }).plus({ days: 1 }).startOf('day').toMillis() : localTime(due.value, due.zone).toMillis();
}
export function reminderTime(value: string, zone: string): number {
  return localTime(value.length === 10 ? `${value}T${String(POLICY.taskReminderHour).padStart(2, '0')}:00:00` : value, zone).toMillis();
}
export function nextReminder(first: number, zone: string): number {
  const dt = DateTime.fromMillis(first, { zone });
  let next = dt.plus({ days: 1 });
  if (next.toMillis() - first < POLICY.taskReminderGapHours * 3600000) next = dt.plus({ days: 2 });
  return next.toMillis();
}
export function relativeTime(due: TaskDeadline | null, days: number, time: string): number {
  if (!due) return taskError('Set a deadline before a deadline-relative reminder.', 'יש לקבוע מועד יעד לפני תזכורת יחסית אליו.');
  if (!/^\d{2}:\d{2}$/.test(time)) return taskError('Please specify a valid reminder time.', 'נא לציין שעה תקינה לתזכורת.');
  const day = DateTime.fromISO(due.value.slice(0, 10), { zone: due.zone }).minus({ days });
  return localTime(`${day.toISODate()}T${time}:00`, due.zone).toMillis();
}
