import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';
import { POLICY, UserError } from './config.js';
import type { TaskCommand } from './task-domain.js';

const nullableText = z.string().nullable();
export const intentSchema = z.object({
  action: z.enum(['create', 'update', 'cancel', 'list', 'clarify', 'task']),
  language: z.enum(['en', 'he']),
  question: nullableText,
  eventId: nullableText,
  targetSelection: z.enum(['none', 'title', 'date', 'next', 'context']).describe('How the user identified the target: title alone, explicit date, explicit next, or prior conversational selection. Never infer next for separate same-title events.'),
  title: nullableText,
  start: nullableText.describe('Local ISO datetime YYYY-MM-DDTHH:mm:ss without offset'),
  end: nullableText.describe('Local ISO datetime or null for 30-minute default'),
  timezone: nullableText,
  location: nullableText,
  scope: z.enum(['occurrence', 'future', 'series']),
  recurrence: z.object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(365),
    weekdays: z.array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])),
    until: nullableText,
  }).nullable(),
  queryStart: nullableText, queryEnd: nullableText,
});
export type Intent = z.infer<typeof intentSchema> & { voiceReply?: boolean; task?: TaskCommand | null };
export function executableIntent(value: unknown): Intent {
  const intent = intentSchema.parse(value);
  // A question and a mutation are contradictory. Asking always wins: never write while clarifying.
  return intent.question?.trim() ? { ...intent, action: 'clarify', eventId: null } : intent;
}
export interface GraphTime { dateTime: string; timeZone: string; }
export interface Recurrence {
  pattern: { type: string; interval: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number; firstDayOfWeek?: string };
  range: { type: string; startDate: string; endDate?: string; numberOfOccurrences?: number; recurrenceTimeZone?: string };
}
export interface CalendarEvent {
  id: string; subject: string; start: GraphTime; end: GraphTime; type?: string;
  seriesMasterId?: string; recurrence?: Recurrence | null; categories?: string[];
  location?: { displayName: string }; isCancelled?: boolean; originalStart?: string;
  organizer?: { emailAddress: { address: string } };
  attendees?: { emailAddress: { address: string; name?: string }; type: string }[];
  '@odata.etag'?: string; exceptionOccurrences?: CalendarEvent[]; cancelledOccurrences?: string[];
}
export function localTime(value: string, zone: string): DateTime {
  if (!IANAZone.isValidZone(zone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new UserError('Please specify a valid date, time, and time zone.', 'נא לציין תאריך, שעה ואזור זמן תקינים.');
  }
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16) || dt.getPossibleOffsets().length > 1) {
    throw new UserError('That local time is ambiguous or unavailable due to daylight saving. Please choose another time.', 'השעה אינה חד-משמעית או לא קיימת בגלל מעבר שעון. נא לבחור שעה אחרת.');
  }
  return dt;
}
export function graphTime(dt: DateTime): GraphTime { return { dateTime: dt.toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: dt.zoneName! }; }
export function eventTime(t: GraphTime, zone = POLICY.timezone as string): DateTime {
  return DateTime.fromISO(t.dateTime, { zone: t.timeZone === 'Israel Standard Time' ? POLICY.timezone : t.timeZone }).setZone(zone);
}
export function timeRange(intent: Intent, existing?: CalendarEvent): { start: GraphTime; end: GraphTime } {
  const zone = intent.timezone ?? POLICY.timezone;
  const start = intent.start ? localTime(intent.start, zone) : existing ? eventTime(existing.start, zone) : undefined;
  if (!start) throw new UserError('What date and time should I schedule?', 'באיזה תאריך ושעה לקבוע?');
  const duration = existing ? eventTime(existing.end).diff(eventTime(existing.start), 'minutes').minutes : POLICY.durationMinutes;
  const end = intent.end ? localTime(intent.end, zone) : start.plus({ minutes: duration });
  if (end <= start || end.diff(start, 'days').days > 7) throw new UserError('The end must be after the start, within seven days.', 'שעת הסיום צריכה להיות אחרי ההתחלה, בטווח של שבעה ימים.');
  return { start: graphTime(start), end: graphTime(end) };
}
export function recurrence(intent: Intent, start: GraphTime): Recurrence | undefined {
  const r = intent.recurrence;
  if (!r) return;
  const date = eventTime(start, start.timeZone);
  const type = { daily: 'daily', weekly: 'weekly', monthly: 'absoluteMonthly', yearly: 'absoluteYearly' }[r.frequency];
  const pattern: Recurrence['pattern'] = { type, interval: r.interval };
  if (r.frequency === 'weekly') {
    pattern.daysOfWeek = r.weekdays.length ? [...new Set(r.weekdays)] : [date.toFormat('cccc').toLowerCase()];
    pattern.firstDayOfWeek = 'sunday';
  }
  if (r.frequency === 'monthly' || r.frequency === 'yearly') pattern.dayOfMonth = date.day;
  if (r.frequency === 'yearly') pattern.month = date.month;
  const startDate = date.toISODate()!;
  if (r.until && (!/^\d{4}-\d{2}-\d{2}$/.test(r.until) || !DateTime.fromISO(r.until).isValid || r.until < startDate)) {
    throw new UserError('The recurrence end date must be on or after its start.', 'תאריך סיום החזרה חייב להיות ביום ההתחלה או אחריו.');
  }
  return { pattern, range: { type: r.until ? 'endDate' : 'noEnd', startDate,
    ...(r.until ? { endDate: r.until } : {}), recurrenceTimeZone: start.timeZone } };
}
export function describe(event: CalendarEvent, language: 'en' | 'he'): string {
  const start = eventTime(event.start), end = eventTime(event.end);
  return `${event.subject}\n${start.setLocale(language).toFormat('cccc, dd/LL/yyyy HH:mm')}–${end.toFormat(start.hasSame(end, 'day') ? 'HH:mm' : 'dd/LL/yyyy HH:mm')} (${POLICY.timezone})${event.location?.displayName ? `\n${event.location.displayName}` : ''}`;
}
