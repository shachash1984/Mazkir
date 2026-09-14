// Run with the service stopped and RECIPIENT_EMAIL set to a configured additional email.
// APPLY=1 adds that address to exactly three managed events.
import { randomUUID } from 'node:crypto';
import { config, POLICY } from './dist/src/config.js';
import { Store } from './dist/src/store.js';
import { MicrosoftAuth, GraphClient, eventPath, eventFields } from './dist/src/microsoft.js';
const cfg = config(), store = new Store(cfg.dataDir, cfg.encryptionKey), owner = randomUUID();
const address = (process.env.RECIPIENT_EMAIL ?? '').trim().toLowerCase();
let acquired = false;
try {
  if (!address) throw new Error('Set RECIPIENT_EMAIL to a configured additional recipient.');
  acquired = store.acquire(owner);
  if (!acquired) throw new Error('Stop the service first.');
  const member = cfg.members.find(m => m.additionalEmails?.some(email => email.toLowerCase() === address));
  if (!member) throw new Error('Recipient is not configured.');
  const graph = new GraphClient(new MicrosoftAuth(cfg, store));
  const events = (await graph.all('/me/events?$select=' + eventFields)).filter(e =>
    e.categories?.includes(POLICY.category) && !e.isCancelled &&
    e.organizer?.emailAddress.address.toLowerCase() === cfg.organizerEmail);
  console.log('Managed active events: ' + events.length);
  if (events.length !== 3) throw new Error('Expected exactly three events; no changes made.');
  for (const listed of events) {
    const e = await graph.request('GET', eventPath(listed.id) + '?$select=' + eventFields);
    if (!e.categories?.includes(POLICY.category) || e.isCancelled ||
        e.organizer?.emailAddress.address.toLowerCase() !== cfg.organizerEmail) throw new Error('Event ownership changed.');
    const has = e.attendees?.some(a => a.emailAddress.address.toLowerCase() === address);
    console.log(JSON.stringify({ type: e.type, alreadyIncluded: !!has }));
    if (process.env.APPLY !== '1' || has) continue;
    if (!e['@odata.etag']) throw new Error('Missing concurrency token.');
    await graph.request('PATCH', eventPath(e.id), { attendees: [
      ...(e.attendees ?? []).map(a => ({ emailAddress: a.emailAddress, type: a.type })),
      { emailAddress: { address, name: member.name }, type: 'required' },
    ] }, e['@odata.etag']);
    const updated = await graph.request('GET', eventPath(e.id) + '?$select=attendees');
    if (!updated.attendees?.some(a => a.emailAddress.address.toLowerCase() === address)) throw new Error('Recipient verification failed.');
    console.log('VERIFIED: added recipient.');
  }
} catch (error) {
  console.error(error?.constructor === Error ? error.message : 'Calendar update failed; inspect before retrying.');
  process.exitCode = 1;
} finally {
  if (acquired) store.release(owner);
  store.close();
}
