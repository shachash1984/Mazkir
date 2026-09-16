import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import qr from 'qrcode-terminal';
import { config, familyConfigured } from './config.js';
import { Store } from './store.js';
import { MicrosoftAuth, GraphClient } from './microsoft.js';
import { Calendar } from './calendar.js';
import { Language } from './language.js';
import { WhatsApp } from './whatsapp.js';
import { Worker } from './worker.js';
import { Speech } from './speech.js';
import { Tasks } from './tasks.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'doctor';
  if (command === 'setup') {
    if (existsSync('.env')) { console.log('.env already exists; existing settings preserved.'); return; }
    const example = readFileSync('.env.example', 'utf8');
    writeFileSync('.env', example.replace('ENCRYPTION_KEY=', 'ENCRYPTION_KEY=' + randomBytes(32).toString('hex')), { flag: 'wx', mode: 0o600 });
    console.log('Created .env with a new encryption key. Fill the account settings locally; keep the key with your private backups.');
    return;
  }
  if (command === 'demo') { await (await import('./demo.js')).demo(); return; }
  const cfg = config(), store = new Store(cfg.dataDir, cfg.encryptionKey);
  const tasks = new Tasks(store, cfg.members);
  const owner = randomUUID();
  if (!store.acquire(owner)) { store.close(); throw new Error('Another Mazkir process is using this database. Stop it before pairing, login, backup, or recovery.'); }
  const lease = setInterval(() => {
    if (!store.acquire(owner)) { console.error('Database ownership lost. Stopping.'); process.exit(1); }
  }, 10000);
  lease.unref();
  let wa: WhatsApp | undefined;
  const cleanup = () => { wa?.stop(); clearInterval(lease); store.release(owner); store.close(); };
  if (command !== 'start' && command !== 'pair-whatsapp') {
    try {
      if (command === 'doctor') {
        const checks = {
          'Family contacts configured': familyConfigured(cfg),
          'OpenAI key configured': !!cfg.openaiKey,
          'Microsoft app configured': !!cfg.msClientId && !!cfg.organizerEmail,
          'Organizer signed in': !!store.get('ms-account'),
          'WhatsApp session saved': !!store.get('wa:creds'),
          'External email monitor configured': !!cfg.healthcheckUrl,
          'No blocked jobs': !store.hasBlocked() && !tasks.hasBlocked(),
          'No inbound storage fault': !store.get('inbound-fault'),
        };
        for (const [label, ok] of Object.entries(checks)) console.log(`${ok ? 'OK' : 'NEEDS SETUP'} ${label}`);
        console.log(`Account configuration only; no provider connectivity tested. Recorded AI spend: $${store.spend().toFixed(4)}.`);
        for (const row of store.db.prepare("SELECT id,status,attempts FROM jobs WHERE status!='done'").all()) console.log(row);
        for (const id of tasks.blockedIds()) console.log({ id, status: 'blocked task notification' });
        if (Object.values(checks).some(v => !v)) process.exitCode = 1;
      } else if (command === 'login-microsoft') {
        await new MicrosoftAuth(cfg, store).login(console.log);
        console.log('Organizer login saved encrypted.');
      } else if (command === 'resume') {
        if (!process.argv[3] || !(store.resume(process.argv[3]) || tasks.resume(process.argv[3]))) throw new Error('Supply a blocked job or task notification ID from doctor.');
        console.log('Job queued for reconciliation and retry.');
      } else if (command === 'clear-inbound-fault') {
        store.remove('inbound-fault');
        console.log('Inbound alert cleared. Ask the sender to resend any unacknowledged request.');
      } else if (command === 'backup') {
        mkdirSync('backups', { recursive: true, mode: 0o700 });
        const path = resolve('backups', `mazkir-${Date.now()}.sqlite`);
        store.db.prepare('VACUUM INTO ?').run(path);
        console.log(`Consistent database backup: ${path}. Store the encryption key separately.`);
      } else throw new Error('Commands: setup, doctor, login-microsoft, pair-whatsapp, start, resume JOB_ID, clear-inbound-fault, backup, demo');
    } finally { cleanup(); }
    return;
  }
  const stop = () => { cleanup(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  wa = new WhatsApp(cfg, store, console.log, command === 'pair-whatsapp' ? value => qr.generate(value, { small: true }) : undefined);
  if (command === 'pair-whatsapp') {
    wa.connect();
    console.log('Use the dedicated agent phone: WhatsApp → Linked devices → Link a device. Wait for “connected”, then Ctrl+C.');
    return;
  }
  if (!cfg.healthcheckUrl) throw new Error('Configure HEALTHCHECK_URL with an email alert before running the unattended service.');
  if (!familyConfigured(cfg)) throw new Error('Replace the example FAMILY_MEMBERS phone numbers and email addresses before starting the service.');
  // Arm a newly configured check even if startup never reaches a healthy connection.
  await fetch(cfg.healthcheckUrl + '/start', { signal: AbortSignal.timeout(10000), redirect: 'error' }).catch(() => {});
  const graph = new GraphClient(new MicrosoftAuth(cfg, store));
  const language = new Language(cfg, store);
  const worker = new Worker(store, new Calendar(graph, cfg), language, wa,
    id => console.error(`Job ${id} needs intervention. Inspect with doctor; fix the connection/account, then resume this job.`), new Speech(cfg, store), tasks);
  wa.connect();
  let checking = false;
  async function health(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      if (!wa?.ready || !worker.healthy() || store.hasBlocked() || store.get('inbound-fault')) return;
      await graph.request('GET', '/me/calendar?$select=id');
      await fetch(cfg.healthcheckUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    } catch { /* Independent monitor emails after the grace period; recovery stays quiet. */ }
    finally { checking = false; }
  }
  setInterval(() => { void worker.tick().catch(() => { console.error('Worker storage failure. Stopping.'); process.exit(1); }); }, 1000);
  setInterval(() => { void health(); }, 60000);
  setInterval(() => store.prune(), 3600000);
  console.log('Mazkir service started. The external monitor detects outages and jobs needing intervention.');
}

main().catch(error => {
  // SDK errors may embed HTTP headers or tokens. Only expose our expected setup errors.
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Setup or service failed. Check configuration and account authorization.';
  console.error(message);
  process.exit(1);
});
