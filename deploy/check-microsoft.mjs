// Run through stdin inside the stopped service container; never prints tokens or event content.
import { randomUUID } from 'node:crypto';
import { config } from './dist/src/config.js';
import { Store } from './dist/src/store.js';
import { MicrosoftAuth, GraphClient } from './dist/src/microsoft.js';

const cfg = config();
const store = new Store(cfg.dataDir, cfg.encryptionKey);
const owner = randomUUID();
try {
  if (!store.acquire(owner)) throw new Error('Stop the service before running this check.');
  const graph = new GraphClient(new MicrosoftAuth(cfg, store));
  const calendar = await graph.request('GET', '/me/calendar?$select=id,canEdit');
  if (!calendar.id || calendar.canEdit !== true) throw new Error('Organizer calendar is not writable.');
  console.log('PASS: saved organizer authorization works and Microsoft reports an editable calendar.');
  console.log('Read-only verification; no events or invitations created.');
} catch (error) {
  console.error(error?.constructor === Error ? error.message : 'Microsoft calendar verification failed; check organizer authorization.');
  process.exitCode = 1;
} finally {
  store.release(owner);
  store.close();
}
