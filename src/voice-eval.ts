// Synthetic samples and API evaluation only. Never connects to WhatsApp or Microsoft.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, POLICY } from './config.js';
import { Store, type Job } from './store.js';
import { Speech } from './speech.js';
import { Language } from './language.js';

const cfg = config();
const output = resolve(process.argv[2] ?? 'voice-samples');
const store = new Store(mkdtempSync(join(tmpdir(), 'mazkir-voice-eval-')), randomBytes(32).toString('hex'));
const cap = 0.50;
const samples = [
  { name: 'english', language: 'en', text: 'Schedule Judo pickup on September ninth, two thousand twenty-seven, at four in the afternoon.' },
  { name: 'hebrew', language: 'he', text: 'תקבע איסוף לחוג ג׳ודו בתשעה בספטמבר אלפיים עשרים ושבע בשעה ארבע אחר הצהריים.' },
  { name: 'mixed', language: 'he', text: 'תקבע פגישה בשם Design Review בתשעה בספטמבר אלפיים עשרים ושבע בשעה ארבע אחר הצהריים. תענה בעברית.' },
];
try {
  mkdirSync(output, { recursive: true });
  const language = new Language({ ...cfg, aiCap: cap }, store);
  for (const voice of ['nova', 'onyx']) {
    const speech = new Speech({ ...cfg, aiCap: cap + POLICY.speechBudgetHeadroomUsd, speechVoice: voice }, store);
    for (const sample of samples) {
      const audio = await speech.synthesize(sample.text);
      const filename = `${voice}-${sample.name}.ogg`;
      writeFileSync(join(output, filename), Buffer.from(audio.data, 'base64'));
      console.log(`SAMPLE ${filename}: ${audio.seconds.toFixed(1)} seconds, mono Opus`);
      if (voice !== 'nova') continue;
      const job: Job = { id: sample.name, chat: sample.name, actor: 'Synthetic Parent',
        at: new Date().toISOString(), text: '', audio, status: 'pending', attempts: 0, nextAt: 0 };
      job.text = await language.transcribe(job);
      const intent = await language.interpret(job, []);
      assert.equal(intent.action, 'create');
      assert.equal(intent.language, sample.language);
      assert.ok(intent.start?.startsWith('2027-09-09T16:00'), JSON.stringify(intent));
      writeFileSync(join(output, `${sample.name}-transcript.txt`), job.text);
      console.log(`PASS ${sample.name}: transcription and scheduling interpretation`);
    }
  }
  for (const [index, text] of [
    'List my agenda for tomorrow and read it aloud. Answer in Hebrew.',
    'מה יש לי מחר? תענה בהודעה קולית באנגלית.',
    'List my agenda for tomorrow.',
  ].entries()) {
    const result = await language.interpret({ id: `request-${index}`, chat: `request-${index}`,
      actor: 'Synthetic Parent', at: new Date().toISOString(), text, status: 'pending', attempts: 0, nextAt: 0 }, []);
    assert.equal(result.action, 'list');
    assert.equal(result.voiceReply, index < 2);
    assert.equal(result.language, index === 0 ? 'he' : 'en');
    console.log(`PASS explicit reply preference ${index + 1}`);
  }
  console.log('PASS voice evaluation. Samples are AI-generated; human listening review is still required.');
} catch (error) {
  const e = error as { name?: string; status?: number };
  console.error(`Voice evaluation failed: ${error instanceof Error ? error.constructor.name : 'error'}${e.status ? ` (HTTP ${e.status})` : ''}.`);
  if (error instanceof Error && /^(Speech must|Empty speech|Speech response|Invalid speech)/.test(error.message)) console.error(error.message);
  if (error instanceof assert.AssertionError) console.error(error.message);
  process.exitCode = 1;
} finally {
  console.log(`Recorded evaluation spend: $${store.spend().toFixed(4)}; per-run ceiling $${cap.toFixed(2)}. No calendar or WhatsApp writes.`);
  store.close();
}
