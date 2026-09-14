import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY, UserError } from './config.js';

export interface Incoming {
  id: string; chat: string; actor: string; at: string; text: string;
  audio?: { data: string; mime: string; seconds: number };
  voiceReply?: boolean;
  delivery?: {
    speech: 'started' | 'ready' | 'unavailable';
    audio?: { data: string; mime: string; seconds: number };
    textPartsSent: number;
  };
}
export interface Job extends Incoming { status: string; attempts: number; nextAt: number; plan?: unknown; reply?: string; }

export class Store {
  db: DatabaseSync;
  private key: Buffer;
  constructor(dir: string, key: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = Buffer.from(key, 'hex');
    this.db = new DatabaseSync(join(dir, 'mazkir.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS vault (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, plan TEXT, reply TEXT);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, chat TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, usd REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (jid TEXT PRIMARY KEY, phone TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, next_at, created_at);
      CREATE INDEX IF NOT EXISTS history_chat ON history(chat, at);`);
    if (process.platform !== 'win32') chmodSync(join(dir, 'mazkir.sqlite'), 0o600);
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  decrypt<T>(value: string): T {
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as T;
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM vault WHERE key=?').get(key);
    return row ? this.decrypt<T>(String(row.value)) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO vault VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, this.encrypt(value));
  }
  remove(key: string): void { this.db.prepare('DELETE FROM vault WHERE key=?').run(key); }
  putAlias(jid: string, phone: string): void {
    const existing = this.phone(jid);
    if (existing && existing !== phone) throw new Error('WhatsApp identity mapping changed.');
    this.db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)').run(jid, phone);
  }
  phone(jid: string): string | undefined { return this.db.prepare('SELECT phone FROM aliases WHERE jid=?').get(jid)?.phone as string | undefined; }
  enqueue(message: Incoming): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO jobs(id,chat,payload,created_at) VALUES (?,?,?,?)')
      .run(message.id, message.chat, this.encrypt(message), Date.now());
    return result.changes === 1;
  }
  next(now = Date.now()): Job | undefined {
    // Strict FIFO across calendar mutations, including retries and unfinished replies.
    const row = this.db.prepare("SELECT * FROM jobs WHERE status IN ('pending','reply') ORDER BY created_at,rowid LIMIT 1").get();
    if (!row || Number(row.next_at) > now) return;
    return { ...this.decrypt<Incoming>(String(row.payload)), status: String(row.status), attempts: Number(row.attempts),
      nextAt: Number(row.next_at), plan: row.plan ? this.decrypt(String(row.plan)) : undefined,
      reply: row.reply ? this.decrypt<string>(String(row.reply)) : undefined };
  }
  savePayload(job: Incoming): void { this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(this.encrypt(job), job.id); }
  plan(id: string, plan: unknown): void { this.db.prepare('UPDATE jobs SET plan=? WHERE id=?').run(this.encrypt(plan), id); }
  readyReply(job: Job, reply: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE jobs SET status='reply',reply=?,attempts=0,next_at=0 WHERE id=?").run(this.encrypt(reply), job.id);
      this.addHistory(job.chat, 'user', job.text);
      this.addHistory(job.chat, 'assistant', reply);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  complete(id: string): void {
    // Retain the message id as a dedup tombstone, not its private content.
    this.db.prepare("UPDATE jobs SET status='done',payload=?,plan=NULL,reply=NULL WHERE id=?").run(this.encrypt({}), id);
  }
  retry(id: string, attempts: number): void {
    this.db.prepare('UPDATE jobs SET attempts=?,next_at=? WHERE id=?').run(attempts, Date.now() + Math.min(300000, 1000 * 2 ** attempts), id);
  }
  block(id: string): void { this.db.prepare("UPDATE jobs SET status='blocked' WHERE id=?").run(id); }
  hasBlocked(): boolean { return !!this.db.prepare("SELECT id FROM jobs WHERE status='blocked' LIMIT 1").get(); }
  resume(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status=CASE WHEN reply IS NULL THEN 'pending' ELSE 'reply' END,attempts=0,next_at=0 WHERE id=? AND status='blocked'").run(id).changes === 1;
  }
  addHistory(chat: string, role: string, text: string): void {
    this.db.prepare('INSERT INTO history(chat,at,payload) VALUES (?,?,?)').run(chat, Date.now(), this.encrypt({ role, content: text }));
  }
  history(chat: string): { role: 'user' | 'assistant'; content: string }[] {
    const rows = this.db.prepare('SELECT payload FROM history WHERE chat=? AND at>? ORDER BY id DESC LIMIT 12')
      .all(chat, Date.now() - POLICY.retentionDays * 86400000);
    let remaining = POLICY.maxInputChars as number;
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const row of rows) {
      if (remaining < 100) break;
      const message = this.decrypt<{ role: 'user' | 'assistant'; content: string }>(String(row.payload));
      const limit = Math.min(6000, remaining);
      if (message.content.length > limit) message.content = message.content.slice(0, limit - 50) + '\n[Earlier message shortened for context]';
      remaining -= message.content.length;
      messages.push(message);
    }
    return messages.reverse();
  }
  reserve(id: string, maximumUsd: number, cap: number): void {
    const month = new Date().toISOString().slice(0, 7);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const used = Number(this.db.prepare('SELECT COALESCE(SUM(usd),0) AS total FROM usage WHERE month=?').get(month)?.total);
      if (used + maximumUsd > cap) throw new UserError('The monthly AI budget is exhausted. No event was changed.', 'תקציב הבינה המלאכותית החודשי נוצל. לא שונה אירוע.');
      this.db.prepare('INSERT INTO usage VALUES (?,?,?)').run(id, month, maximumUsd);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  settle(id: string, usd: number): void { this.db.prepare('UPDATE usage SET usd=? WHERE id=?').run(usd, id); }
  spend(): number { return Number(this.db.prepare('SELECT COALESCE(SUM(usd),0) AS total FROM usage WHERE month=?').get(new Date().toISOString().slice(0, 7))?.total); }
  acquire(owner: string): boolean {
    return this.db.prepare("INSERT INTO locks VALUES ('worker',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<? OR locks.owner=excluded.owner")
      .run(owner, Date.now() + 120000, Date.now()).changes === 1;
  }
  release(owner: string): void { this.db.prepare('DELETE FROM locks WHERE owner=?').run(owner); }
  prune(): void {
    const cutoff = Date.now() - POLICY.retentionDays * 86400000;
    this.db.prepare('DELETE FROM history WHERE at<?').run(cutoff);
    for (const row of this.db.prepare("SELECT id,payload FROM jobs WHERE status!='done' AND created_at<?").all(cutoff)) {
      const payload = this.decrypt<Incoming>(String(row.payload));
      payload.text = ''; delete payload.audio; delete payload.delivery;
      this.db.prepare("UPDATE jobs SET payload=?,status='blocked' WHERE id=?").run(this.encrypt(payload), String(row.id));
    }
    for (const row of this.db.prepare("SELECT key,value FROM vault WHERE key LIKE 'context:%' OR key LIKE 'wa:out:%'").all()) {
      const value = this.decrypt<unknown>(String(row.value));
      const record = typeof value === 'string' ? JSON.parse(value) : value;
      if (record.at < Date.now() - POLICY.retentionDays * 86400000) this.remove(String(row.key));
    }
  }
  close(): void { this.db.close(); }
}
