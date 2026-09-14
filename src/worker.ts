import { POLICY, UserError, InterventionError } from './config.js';
import { Calendar, type CalendarPlan } from './calendar.js';
import type { CalendarEvent } from './domain.js';
import type { LanguagePort } from './language.js';
import { NotFoundError } from './microsoft.js';
import { Store, type Job } from './store.js';
import { replyChunks, speechText, type ReplyAudio, type SpeechPort } from './speech.js';

export interface Messenger {
  send(chat: string, text: string, id: string): Promise<void>;
  sendAudio?(chat: string, audio: ReplyAudio, id: string): Promise<void>;
}
export class Worker {
  private busy = false;
  private startedAt = 0;
  healthy(): boolean { return !this.busy || Date.now() - this.startedAt < 180000; }
  constructor(private store: Store, private calendar: Calendar, private language: LanguagePort,
    private messenger: Messenger, private alert: (jobId: string) => void, private speech?: SpeechPort) {}

  private async deliver(job: Job): Promise<void> {
    if (!job.delivery) {
      job.delivery = { speech: job.voiceReply ? 'started' : 'unavailable', textPartsSent: 0 };
      // Persist before a paid request: an interrupted attempt is not generated again.
      this.store.savePayload(job);
      if (job.voiceReply) {
        try {
          if (!this.speech || !this.messenger.sendAudio) throw new Error('Speech unavailable.');
          job.delivery.audio = await this.speech.synthesize(speechText(job.reply!, job.plan as CalendarPlan | undefined));
          job.delivery.speech = 'ready';
        } catch { job.delivery.speech = 'unavailable'; }
        this.store.savePayload(job);
      }
    } else if (job.delivery.speech === 'started') {
      job.delivery.speech = 'unavailable';
      this.store.savePayload(job);
    }
    const he = (job.plan as CalendarPlan | undefined)?.intent.language === 'he' ||
      (!(job.plan as CalendarPlan | undefined) && /[\u0590-\u05ff]/.test(job.reply!));
    const text = job.reply! + (job.voiceReply ? (he ? '\n\nהקול של מזכיר נוצר בבינה מלאכותית.' : '\n\nMazkir’s voice is AI-generated.') : '');
    const chunks = replyChunks(text);
    for (let i = job.delivery.textPartsSent; i < chunks.length; i++) {
      await this.messenger.send(job.chat, chunks[i]!, i === 0 ? job.id : `${job.id}:text:${i}`);
      job.delivery.textPartsSent = i + 1;
      this.store.savePayload(job);
    }
    if (job.delivery.speech === 'ready' && job.delivery.audio) {
      try { await this.messenger.sendAudio!(job.chat, job.delivery.audio, job.id); }
      catch (error) {
        if (job.attempts + 1 < POLICY.maxAttempts) throw error;
        // An optional voice upload must never block all later calendar work.
        job.delivery.speech = 'unavailable'; delete job.delivery.audio;
        this.store.savePayload(job);
      }
    }
    if (job.voiceReply && job.delivery.speech === 'unavailable') {
      await this.messenger.send(job.chat, he ? 'התשובה מופיעה בטקסט; השמע אינו זמין כרגע.' :
        'Your reply is in the text above; audio is unavailable right now.', `${job.id}:voice-unavailable`);
    }
    this.store.complete(job.id);
  }

  async tick(): Promise<void> {
    if (this.busy || this.store.hasBlocked()) return;
    const job = this.store.next();
    if (!job) return;
    this.busy = true;
    this.startedAt = Date.now();
    try {
      if (job.status === 'reply') {
        await this.deliver(job);
        return;
      }
      let plan = job.plan as CalendarPlan | undefined;
      if (!plan) {
        if (job.audio) {
          job.voiceReply = true;
          this.store.savePayload(job);
          job.text = await this.language.transcribe(job);
          delete job.audio;
          this.store.savePayload(job);
        }
        const recent = this.store.get<{ at: number; events: CalendarEvent[] }>('context:' + job.chat);
        const cached = recent && Date.now() - recent.at < POLICY.retentionDays * 86400000 ? recent.events : [];
        const fresh = await this.calendar.candidates(job);
        const candidates = [...new Map([...cached, ...fresh].map(e => [e.id, e])).values()].slice(-POLICY.maxEvents);
        const intent = await this.language.interpret(job, candidates);
        job.voiceReply = job.voiceReply || intent.voiceReply;
        this.store.savePayload(job);
        plan = await this.calendar.prepare(intent, job, candidates);
        this.store.plan(job.id, plan);
        job.plan = plan;
      }
      await this.calendar.execute(plan, () => this.store.plan(job.id, plan));
      const events = plan.list ?? plan.steps.flatMap(s => s.result ? [s.result] : []);
      if (events.length) this.store.set('context:' + job.chat, { at: Date.now(), events });
      this.store.readyReply(job, this.calendar.receipt(plan));
    } catch (error) {
      const plan = job.plan as CalendarPlan | undefined;
      // A partial multi-step operation must be resumed, never presented as an untouched calendar.
      const partial = plan?.steps.some(s => s.done);
      if ((error instanceof UserError || error instanceof NotFoundError) && !partial && job.status !== 'reply') {
        const he = /[\u0590-\u05ff]/.test(job.text);
        this.store.readyReply(job, error instanceof UserError ? (he ? error.hebrew : error.english) :
          (he ? 'האירוע כבר אינו קיים. לאיזה אירוע הכוונה?' : 'That event no longer exists. Which event do you mean?'));
      } else if (error instanceof InterventionError || job.attempts + 1 >= POLICY.maxAttempts) {
        this.store.block(job.id);
        this.alert(job.id);
      } else this.store.retry(job.id, job.attempts + 1);
    } finally { this.busy = false; }
  }
}
