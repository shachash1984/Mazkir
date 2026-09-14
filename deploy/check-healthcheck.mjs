// Connectivity check while the service is stopped. A /log ping does not arm or reset monitoring.
import { config } from './dist/src/config.js';

try {
  const { healthcheckUrl } = config();
  if (!healthcheckUrl) throw new Error('Monitor URL is missing.');
  const response = await fetch(healthcheckUrl + '/log', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'text/plain' },
    body: 'Mazkir setup connectivity check. Service is stopped pending WhatsApp pairing.',
  });
  const body = (await response.text()).trim();
  if (response.status !== 200 || body !== 'OK') throw new Error('Monitor did not accept the diagnostic log.');
  console.log('PASS: Healthchecks accepted the diagnostic log from this Droplet.');
  console.log('Monitoring state was not changed. Email delivery is not verified by this check.');
} catch {
  console.error('Monitor connectivity check failed; verify the saved ping URL and network access.');
  process.exitCode = 1;
}
