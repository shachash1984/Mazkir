// Private event details are printed only when explicitly requested with PRINT_PRIVATE_DETAILS=1.
import { randomUUID } from 'node:crypto';
import { config, POLICY } from './dist/src/config.js';
import { Store } from './dist/src/store.js';
import { MicrosoftAuth, GraphClient } from './dist/src/microsoft.js';
const cfg = config(), store = new Store(cfg.dataDir, cfg.encryptionKey), owner = randomUUID();
let acquired = false;
try {
  acquired = store.acquire(owner);
  if (!acquired) throw new Error('Stop the service first.');
  const graph = new GraphClient(new MicrosoftAuth(cfg, store));
  const events = await graph.all('/me/events?$select=subject,start,attendees,organizer,categories,isDraft,isCancelled,responseRequested,createdDateTime,lastModifiedDateTime,type');
  for (const e of events.filter(e => e.categories?.includes(POLICY.category) && e.organizer?.emailAddress.address.toLowerCase() === cfg.organizerEmail)) {
    const summary = { isDraft: e.isDraft, isCancelled: e.isCancelled, responseRequested: e.responseRequested,
      attendees: e.attendees?.map(a => ({ type: a.type, response: a.status?.response })) };
    console.log(JSON.stringify(process.env.PRINT_PRIVATE_DETAILS === '1' ?
      { ...summary, subject: e.subject, start: e.start, attendees: e.attendees } : summary));
  }
  console.log('Jobs by status: ' + JSON.stringify(store.db.prepare('SELECT status, count(*) AS count FROM jobs GROUP BY status').all()));
} catch (error) {
  console.error(error?.constructor === Error ? error.message : 'Calendar inspection failed.'); process.exitCode=1;
} finally { if(acquired) store.release(owner); store.close(); }
