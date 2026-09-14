// Run on the Droplet through stdin with PAIR_PHONE set to international digits.
import makeWASocket, { DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { config } from './dist/src/config.js';
import { Store } from './dist/src/store.js';
import { encryptedAuth } from './dist/src/whatsapp.js';

const phone = process.env.PAIR_PHONE;
if (!/^[1-9]\d{7,14}$/.test(phone ?? '')) throw new Error('PAIR_PHONE must contain international digits.');
const cfg = config(), store = new Store(cfg.dataDir, cfg.encryptionKey), owner = randomUUID();
if (!store.acquire(owner)) { store.close(); throw new Error('Another process owns the database.'); }
if (process.env.RESET_FAILED_PAIRING === '1') {
  if (store.get('wa-expected-phone')) {
    store.release(owner); store.close();
    throw new Error('Refusing to reset a previously verified WhatsApp account.');
  }
  store.db.prepare("DELETE FROM vault WHERE key LIKE 'wa:%'").run();
  console.log('Cleared unverified WhatsApp pairing state.');
}
let socket, stopped = false, requested = false;
const stop = code => {
  if (stopped) return;
  stopped = true;
  socket?.end(undefined);
  clearInterval(lease); clearTimeout(deadline);
  store.release(owner); store.close(); process.exit(code);
};
const lease = setInterval(() => { if (!store.acquire(owner)) stop(1); }, 10000);
const deadline = setTimeout(() => { console.log('Pairing timed out.'); stop(1); }, 600000);
process.once('SIGINT', () => stop(0)); process.once('SIGTERM', () => stop(0));
function connect() {
  const auth = encryptedAuth(store);
  socket = makeWASocket({ auth: auth.state, logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
  socket.ev.on('creds.update', auth.save);
  socket.ev.on('connection.update', async update => {
    if (update.qr && !requested && !auth.state.creds.registered) {
      requested = true;
      try { console.log('PAIRING_CODE=' + await socket.requestPairingCode(phone)); }
      catch { console.log('Unable to request a linking code.'); stop(1); }
    }
    if (update.connection === 'open') {
      const actual = jidNormalizedUser(socket.user?.id ?? '').split('@')[0];
      if (actual !== phone) { console.log('Linked account differs from the requested number. Service remains stopped.'); stop(1); }
      else { auth.save(); store.set('wa-expected-phone', phone); console.log('PAIRING_COMPLETE: expected phone connected; encrypted session saved.'); stop(0); }
    }
    if (update.connection === 'close' && !stopped) {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.restartRequired) connect();
      else { console.log('Pairing connection closed (status ' + (code ?? 'unknown') + ').'); stop(1); }
    }
  });
}
connect();
