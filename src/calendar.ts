import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { POLICY, UserError, invitationRecipients, type Config } from './config.js';
import { describe, eventTime, graphTime, localTime, recurrence, timeRange, type CalendarEvent, type Intent, type Recurrence } from './domain.js';
import { eventFields, eventPath, getEvent, NotFoundError, type GraphPort } from './microsoft.js';
import type { Job } from './store.js';

interface Step {
  kind: 'create' | 'patch' | 'cancel'; id?: string; useCreated?: boolean;
  body?: Record<string, unknown>; etag?: string; before?: CalendarEvent;
  operationId: string; result?: CalendarEvent | null; done?: boolean;
}
export interface CalendarPlan {
  intent: Intent; steps: Step[]; subject?: CalendarEvent; list?: CalendarEvent[];
  exceptionCopies?: { date: string; patch?: Record<string, unknown>; cancel?: boolean }[];
  exceptionsExpanded?: boolean;
}
export const operationId = (message: string, suffix = ''): string => createHash('sha256').update(message + ':' + suffix).digest('hex');
const transactionId = (id: string): string => `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;

export class Calendar {
  constructor(private graph: GraphPort, private cfg: Pick<Config, 'members' | 'organizerEmail'>) {}
  private owned(event: CalendarEvent): boolean {
    return !!event.categories?.includes(POLICY.category) && event.organizer?.emailAddress.address.toLowerCase() === this.cfg.organizerEmail;
  }
  async list(start: string, end: string): Promise<CalendarEvent[]> {
    const events = await this.graph.all<CalendarEvent>(`/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=${eventFields}&$top=1000&$orderby=start/dateTime`);
    return events.filter(e => this.owned(e) && !e.isCancelled);
  }
  async candidates(job: Job): Promise<CalendarEvent[]> {
    const now = DateTime.fromISO(job.at).setZone(POLICY.timezone);
    const events = await this.list(now.minus({ days: 1 }).toISO()!, now.plus({ days: 60 }).toISO()!);
    return events.slice(0, POLICY.maxEvents);
  }
  async prepare(intent: Intent, job: Job, candidates: CalendarEvent[]): Promise<CalendarPlan> {
    const plan: CalendarPlan = { intent, steps: [] };
    if (intent.action === 'clarify') return plan;
    if (intent.action === 'list') {
      const now = DateTime.now().setZone(intent.timezone ?? POLICY.timezone);
      const sunday = now.startOf('day').minus({ days: now.weekday % 7 });
      const start = intent.queryStart ? localTime(intent.queryStart, intent.timezone ?? POLICY.timezone) : sunday;
      const end = intent.queryEnd ? localTime(intent.queryEnd, intent.timezone ?? POLICY.timezone) : start.plus({ days: 7 });
      if (end <= start || end.diff(start, 'days').days > 366) throw new UserError('Please request a date range of up to one year.', 'נא לבקש טווח תאריכים של עד שנה.');
      plan.list = await this.list(start.toISO()!, end.toISO()!);
      return plan;
    }
    if (intent.action === 'create') {
      if (!intent.title?.trim() || intent.title.length > 200) throw new UserError('What should the event be called?', 'מה שם האירוע?');
      const range = timeRange(intent);
      if (eventTime(range.start).toMillis() < Date.now()) throw new UserError('That start time has passed. What future date and time should I use?', 'שעת ההתחלה כבר עברה. לאיזה תאריך ושעה עתידיים לקבוע?');
      const repeat = recurrence(intent, range.start);
      plan.steps.push({ kind: 'create', operationId: operationId(job.id), body: {
        subject: intent.title.trim(), ...range, location: { displayName: intent.location ?? '' },
        ...(repeat ? { recurrence: repeat } : {}), categories: [POLICY.category],
        attendees: invitationRecipients(this.cfg.members).map(emailAddress => ({ emailAddress, type: 'required' })),
      } });
      return plan;
    }
    if (!intent.eventId || !candidates.some(e => e.id === intent.eventId || e.seriesMasterId === intent.eventId)) {
      throw new UserError('Which event do you mean? Please include its name and date.', 'לאיזה אירוע הכוונה? נא לציין שם ותאריך.');
    }
    let selected = await getEvent(this.graph, intent.eventId);
    if (!this.owned(selected)) throw new UserError('I can change only events created by this agent.', 'אפשר לשנות רק אירועים שנוצרו על ידי הסוכן.');
    if (intent.targetSelection === 'title' || intent.targetSelection === 'none') {
      const sameTitle = candidates.filter(e => e.subject.trim().toLocaleLowerCase() === selected.subject.trim().toLocaleLowerCase());
      const distinct = new Set(sameTitle.map(e => e.seriesMasterId ?? e.id));
      if (distinct.size > 1) throw new UserError('There are multiple events with that name. Which date do you mean?', 'יש כמה אירועים בשם הזה. לאיזה תאריך הכוונה?');
    }
    if (selected.type === 'seriesMaster' && intent.scope !== 'series') {
      const next = candidates.filter(e => e.seriesMasterId === selected.id && eventTime(e.start).toMillis() >= Date.now())
        .sort((a, b) => eventTime(a.start).toMillis() - eventTime(b.start).toMillis())[0];
      if (!next) throw new UserError('Please specify the date of the occurrence.', 'נא לציין את תאריך המופע.');
      selected = await getEvent(this.graph, next.id);
    }
    plan.subject = selected;
    const masterId = selected.seriesMasterId ?? (selected.type === 'seriesMaster' ? selected.id : undefined);
    if (masterId && intent.scope === 'future') return this.splitFuture(plan, selected, masterId, job);
    let target = selected;
    if (masterId && intent.scope === 'series') target = await getEvent(this.graph, masterId);
    if (intent.action === 'cancel') {
      plan.steps.push({ kind: 'cancel', id: target.id, before: target, operationId: operationId(job.id) });
      return plan;
    }
    const patch = this.patch(intent, selected);
    if (target.id !== selected.id && patch.start) {
      // Whole-series time changes retain the series' historical anchor date.
      const newStart = eventTime(patch.start as CalendarEvent['start'], (patch.start as CalendarEvent['start']).timeZone);
      if (newStart.toISODate() !== eventTime(selected.start, newStart.zoneName!).toISODate()) {
        throw new UserError('To move recurring dates, use “from this occurrence onward” and specify the new repetition.', 'כדי להזיז תאריכים חוזרים, יש לציין ״ממופע זה והלאה״ ואת החזרה החדשה.');
      }
      const anchor = eventTime(target.start, newStart.zoneName!);
      const dt = localTime(anchor.toISODate()! + 'T' + newStart.toFormat('HH:mm:ss'), newStart.zoneName!);
      const duration = eventTime(patch.end as CalendarEvent['end']).diff(eventTime(patch.start as CalendarEvent['start']), 'minutes').minutes;
      patch.start = graphTime(dt); patch.end = graphTime(dt.plus({ minutes: duration }));
      if (intent.recurrence) patch.recurrence = recurrence(intent, patch.start as CalendarEvent['start']);
    }
    if (intent.recurrence && target.type !== 'seriesMaster' && masterId) throw new UserError('To change repetition, say “the whole series” or “from now on”.', 'כדי לשנות חזרה, יש לציין ״כל הסדרה״ או ״מעתה״.');
    plan.steps.push({ kind: 'patch', id: target.id, body: patch, etag: target['@odata.etag'], before: target, operationId: operationId(job.id) });
    return plan;
  }
  private patch(intent: Intent, selected: CalendarEvent): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (intent.title !== null) {
      if (!intent.title.trim() || intent.title.length > 200) throw new UserError('Please provide a short event title.', 'נא לציין שם קצר לאירוע.');
      patch.subject = intent.title.trim();
    }
    if (intent.location !== null) patch.location = { displayName: intent.location };
    if (intent.start || intent.end) Object.assign(patch, timeRange(intent, selected));
    if (intent.recurrence) patch.recurrence = recurrence(intent, (patch.start ?? selected.start) as CalendarEvent['start']);
    if (Object.keys(patch).length === 0) throw new UserError('What should I change about the event?', 'מה לשנות באירוע?');
    return patch;
  }
  private async splitFuture(plan: CalendarPlan, selected: CalendarEvent, masterId: string, job: Job): Promise<CalendarPlan> {
    const master = await this.graph.request<CalendarEvent>('GET', `${eventPath(masterId)}?$select=${eventFields},exceptionOccurrences,cancelledOccurrences&$expand=exceptionOccurrences`);
    if (!master.recurrence) throw new UserError('This event is not recurring.', 'האירוע אינו חוזר.');
    const original = selected.originalStart ? DateTime.fromISO(selected.originalStart).setZone(master.start.timeZone) : eventTime(selected.start, master.start.timeZone);
    const cutoff = original.toISODate()!;
    const range = master.recurrence.range;
    if (cutoff <= range.startDate) {
      return this.prepare({ ...plan.intent, scope: 'series', eventId: masterId }, job, [selected, master]);
    }
    const truncate: Recurrence = { pattern: master.recurrence.pattern,
      range: { type: 'endDate', startDate: range.startDate, endDate: original.minus({ days: 1 }).toISODate()!, recurrenceTimeZone: range.recurrenceTimeZone ?? master.start.timeZone } };
    plan.steps.push({ kind: 'patch', id: masterId, body: { recurrence: truncate }, before: master,
      etag: master['@odata.etag'], operationId: operationId(job.id, 'truncate') });
    if (plan.intent.action === 'cancel') return plan;
    const replacement = { subject: master.subject, start: selected.start, end: selected.end, location: master.location,
      attendees: master.attendees, categories: [POLICY.category], ...this.patch(plan.intent, selected) } as Record<string, unknown>;
    let newRecurrence = replacement.recurrence as Recurrence | undefined;
    if (!newRecurrence) {
      const newStart = eventTime(replacement.start as CalendarEvent['start'], (replacement.start as CalendarEvent['start']).timeZone).toISODate()!;
      if (newStart !== cutoff) throw new UserError('Please specify the new repetition when moving future recurring dates.', 'נא לציין את החזרה החדשה כשמזיזים תאריכים של סדרה מעתה.');
      newRecurrence = { pattern: { ...master.recurrence.pattern }, range: { ...range, startDate: newStart } };
      if (range.type === 'numbered') {
        const earlier = await this.graph.all<CalendarEvent>(`${eventPath(masterId)}/instances?startDateTime=${encodeURIComponent(DateTime.fromISO(range.startDate, { zone: master.start.timeZone }).toISO()!)}&endDateTime=${encodeURIComponent(original.startOf('day').toISO()!)}&$top=1000`);
        const canceledEarlier = (master.cancelledOccurrences ?? []).filter(id => id.slice(-10) < cutoff).length;
        newRecurrence.range.numberOfOccurrences = Math.max(1, (range.numberOfOccurrences ?? 1) - earlier.length - canceledEarlier);
      }
    }
    replacement.recurrence = newRecurrence;
    plan.steps.push({ kind: 'create', body: replacement, operationId: operationId(job.id, 'replacement') });
    plan.exceptionCopies = [];
    // Save exception state before truncating; provider removes future instances of the old series.
    for (const exception of master.exceptionOccurrences ?? []) {
      const full = await getEvent(this.graph, exception.id);
      const date = full.originalStart ? DateTime.fromISO(full.originalStart).setZone(master.start.timeZone).toISODate()! : eventTime(full.start).toISODate()!;
      if (date >= cutoff) plan.exceptionCopies.push({ date, patch: { subject: full.subject, start: full.start, end: full.end, location: full.location ?? { displayName: '' } } });
    }
    for (const id of master.cancelledOccurrences ?? []) {
      const date = id.slice(-10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError('This series has cancellation data I cannot safely transfer. Please edit individual occurrences.', 'לא ניתן להעביר בבטחה את הביטולים בסדרה. נא לערוך מופעים בודדים.');
      if (date >= cutoff) plan.exceptionCopies.push({ date, cancel: true });
    }
    // A changed recurrence pattern can eliminate dates carrying explicit exceptions.
    if (plan.exceptionCopies.length && (plan.intent.recurrence || eventTime(replacement.start as CalendarEvent['start']).toISODate() !== cutoff)) {
      throw new UserError('This series has individual exceptions. Please change its time without changing its dates, or edit individual occurrences.', 'בסדרה יש חריגות למופעים בודדים. נא לשנות שעה בלי לשנות תאריכים, או לערוך מופעים בודדים.');
    }
    return plan;
  }
  private async findOperation(id: string): Promise<CalendarEvent | undefined> {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${POLICY.propertyId}' and ep/value eq '${id}')`;
    return (await this.graph.all<CalendarEvent>(`/me/events?$filter=${encodeURIComponent(filter)}&$select=${eventFields}`))[0];
  }
  async execute(plan: CalendarPlan, save: () => void): Promise<void> {
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index]!;
      if (step.done) continue;
      if (step.kind === 'create') {
        step.result = await this.findOperation(step.operationId) ?? await this.graph.request<CalendarEvent>('POST', '/me/events', {
          ...step.body, transactionId: transactionId(step.operationId),
          singleValueExtendedProperties: [{ id: POLICY.propertyId, value: step.operationId }],
        });
      } else if (step.kind === 'patch') {
        const current = await getEvent(this.graph, step.id!);
        if (this.matches(current, step.body!)) step.result = current;
        else {
          if (step.etag && current['@odata.etag'] !== step.etag) throw new UserError('The event was changed elsewhere. Please send the request again.', 'האירוע השתנה במקום אחר. נא לשלוח את הבקשה שוב.');
          step.result = await this.graph.request<CalendarEvent>('PATCH', eventPath(step.id!), step.body, current['@odata.etag']);
        }
      } else {
        try {
          const current = await getEvent(this.graph, step.id!);
          if (!current.isCancelled) await this.graph.request('POST', `${eventPath(step.id!)}/cancel`, { comment: plan.intent.language === 'he' ? 'בוטל לפי בקשת המשפחה.' : 'Canceled at the family’s request.' });
        } catch (e) { if (!(e instanceof NotFoundError)) throw e; }
        step.result = null;
      }
      step.done = true; save();
    }
    if (plan.exceptionCopies?.length && !plan.exceptionsExpanded) {
      const created = plan.steps.find(s => s.kind === 'create')?.result;
      if (!created) throw new Error('Missing replacement series.');
      const copies: Step[] = [];
      for (const [i, copy] of plan.exceptionCopies.entries()) {
        const day = DateTime.fromISO(copy.date, { zone: created.start.timeZone });
        const instances = await this.graph.all<CalendarEvent>(`${eventPath(created.id)}/instances?startDateTime=${encodeURIComponent(day.toISO()!)}&endDateTime=${encodeURIComponent(day.plus({ days: 1 }).toISO()!)}&$top=1000`);
        const instance = instances.find(e => eventTime(e.start, created.start.timeZone).toISODate() === copy.date);
        if (!instance) throw new Error('Replacement occurrence missing; exception transfer needs intervention.');
        copies.push({ kind: copy.cancel ? 'cancel' : 'patch', id: instance.id,
          body: copy.patch, etag: instance['@odata.etag'], before: instance, operationId: operationId(created.id, String(i)) });
      }
      plan.steps.push(...copies);
      plan.exceptionsExpanded = true; save();
      await this.execute(plan, save);
    }
  }
  private matches(event: CalendarEvent, patch: Record<string, unknown>): boolean {
    return Object.entries(patch).every(([key, value]) => {
      if (key === 'start' || key === 'end') return eventTime(event[key]).toMillis() === eventTime(value as CalendarEvent['start']).toMillis();
      if (key === 'location') return event.location?.displayName === (value as { displayName: string }).displayName;
      if (key === 'recurrence') {
        const r = value as Recurrence, actual = event.recurrence;
        return !!actual && Object.entries(r.pattern).every(([k, v]) => JSON.stringify(actual.pattern[k as keyof Recurrence['pattern']]) === JSON.stringify(v)) &&
          Object.entries(r.range).every(([k, v]) => actual.range[k as keyof Recurrence['range']] === v);
      }
      return event[key as keyof CalendarEvent] === value;
    });
  }
  receipt(plan: CalendarPlan): string {
    const he = plan.intent.language === 'he';
    if (plan.intent.action === 'clarify') return plan.intent.question || (he ? 'אפשר לפרט את האירוע והתאריך?' : 'Please provide the event and date.');
    if (plan.list) {
      if (!plan.list.length) return he ? 'אין אירועים בניהול הסוכן בטווח הזה.' : 'No agent-managed events in that date range.';
      const shown = plan.list;
      return (he ? 'אירועי המשפחה בניהול הסוכן:\n\n' : 'Family events managed by the agent:\n\n') +
        shown.map((e, i) => `${i + 1}. ${describe(e, plan.intent.language)}`).join('\n\n');
    }
    const event = plan.intent.action === 'cancel' ? plan.subject : plan.steps.find(s => s.kind === 'create')?.result ?? plan.steps.find(s => s.kind === 'patch')?.result ?? plan.subject;
    const verb = plan.intent.action === 'cancel' ? (he ? 'נשלחה הודעת ביטול לשניכם.' : 'Cancellation sent to both of you.') :
      plan.intent.action === 'create' ? (he ? 'נשלחו הזמנות לשניכם.' : 'Invitations sent to both of you.') : (he ? 'נשלח עדכון לשניכם.' : 'Update sent to both of you.');
    const scope = plan.intent.scope === 'series' ? (he ? 'כל הסדרה' : 'Entire series') : plan.intent.scope === 'future' ? (he ? 'ממופע זה והלאה' : 'This occurrence and following ones') : (he ? 'מופע זה בלבד' : 'This occurrence only');
    const repeat = event?.recurrence;
    const units: Record<string, [string, string]> = { daily: ['days', 'ימים'], weekly: ['weeks', 'שבועות'], absoluteMonthly: ['months', 'חודשים'], absoluteYearly: ['years', 'שנים'] };
    const repetition = repeat ? `${he ? 'כל' : 'Every'} ${repeat.pattern.interval} ${units[repeat.pattern.type]?.[he ? 1 : 0] ?? (he ? 'מחזורים' : 'cycles')}${repeat.range.endDate ? ` ${he ? 'עד' : 'until'} ${repeat.range.endDate}` : repeat.range.numberOfOccurrences ? ` (${repeat.range.numberOfOccurrences} ${he ? 'מופעים' : 'occurrences'})` : (he ? ' — ללא תאריך סיום' : ' — no end date')}` : '';
    return `${verb}\n${event ? describe(event, plan.intent.language) : ''}\n${event?.attendees?.map(a => a.emailAddress.address).join(', ') ?? ''}${plan.intent.action !== 'create' ? `\n${scope}` : ''}${repetition ? `\n${repetition}` : ''}`;
  }
}
