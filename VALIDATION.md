# Validation — updated 11 September 2026

## Local voice extension — 14 September 2026

- TypeScript check/build, offline demo, and all 38 offline tests pass. New coverage includes voice-origin persistence, explicit voice preference, clarification without mutations, synthesis failure, interrupted generation, delivery retries across worker restarts, exhausted speech budgets, text chunk checkpoints, full agenda summaries, audio retention, mono Opus validation, invalid/overlong inbound media, and empty transcription.
- A real Baileys media-preparation test uses a synthetic audio fixture and a fake uploader/relay. It verifies voice-note metadata, encrypted upload bytes, stable retry IDs, single upload reuse, and restoration of binary media keys from encrypted storage. It caught a protobuf JSON representation mismatch, now corrected. It does not establish real WhatsApp delivery.
- `npm run eval:voice` passed three synthetic audio → transcription → scheduling cases (English, Hebrew, mixed) and three explicit reply-preference/language cases. Each synthetic scheduling case resolved 9 September 2027 at 16:00 correctly. Six Nova/Onyx mono Opus clips were generated for listening review. The successful run recorded $0.0127 in its isolated ledger, with a $0.50 per-run ceiling.
- Two sandboxed connection attempts retained reservations of about $0.0013 each without generating samples. A network-enabled earlier run recorded $0.0022 and caught a wrong year: spoken “twenty ninety-nine” was interpreted as 2029 rather than 2099. The final run uses ordinary spoken dates. This is a known transcription-accuracy limitation, not a demonstrated fix for every date pronunciation; the text confirmation remains essential.
- No calendar or WhatsApp writes were made by these evaluations. Speech output files contain synthetic content only. The user selected Nova after reviewing the bilingual samples on 14 September 2026; local configuration now explicitly sets `SPEECH_VOICE=nova`. Real human-recorded/noisy Hebrew and English acceptance tests, phone playback/delivery, and production deployment remain pending.

Earlier validation history follows.

## Passed

- `npm run build`: TypeScript compilation.
- `npm test`: 22 offline tests covering encrypted persistence, phone authorization, strict FIFO, deduplication, budget reservations, database ownership, lost create/update responses, reply retries, cancellations, recurrence scopes, DST, retention, and clarification guards.
- `npm run demo`: complete simulated scheduling pipeline; no messages sent.
- `npm run eval:live`: 5/5 synthetic requests against the configured OpenAI model. Final run recorded $0.0027. Previous diagnostic attempts are additional provider usage.
- `docker compose config --quiet`: configuration syntax accepted.
- Dependency installation audit: zero reported vulnerabilities at installation.
- DigitalOcean `YOUR_DROPLET`: SSH access verified, Docker/Compose installed, Docker enabled at boot, SSH-only UFW firewall active.
- Server container build: all 22 tests and TypeScript compilation passed inside the Linux build stage. Container offline demo passed under the configured read-only filesystem and memory limits.
- Server configuration check: `.env` mode 600, persistent data volume created, family contacts and provider configuration complete; service started on 11 September after WhatsApp pairing.

## Live finding fixed

The model initially interpreted two separate same-title events as if they were occurrences of one series, selecting the earlier event for “Cancel Judo.” Candidate serialization now includes explicit series identity, the prompt distinguishes separate events from one series, and calendar validation refuses ambiguous title-only mutations. A model output that contains a clarification question is always treated as clarification, even if its action field says cancel. Regression tests cover both guards.

## Still required

- Representative workload resource measurement, unattended reboot recovery, and DigitalOcean backup configuration verification. Bootstrap was performed over SSH, not through the supplied cloud-init template.
- Real invitation/update/cancellation delivery to both work accounts. Microsoft app registration and organizer authorization are complete: a fresh container successfully loaded the encrypted token cache and read the organizer calendar, which Microsoft reports as editable. This check created no events.
- Family phone identity mappings, voice-note transcription, actual message delivery, and reconnection after outages. Initial pairing and reconnection from saved credentials passed.
- External email notification and backup/restore drills.
- Live recurring-series exception transfer. Offline tests cover split/retry planning but cannot establish Microsoft service behavior.

No real calendar invitations or WhatsApp messages were sent during validation. The local `.env` and server `/opt/mazkir/.env` now contain the user's family contacts, OpenAI key, and Healthchecks URL alongside Microsoft settings and the original encryption key. Five synthetic OpenAI checks passed on the Droplet with this key; that evaluation recorded $0.0027 in its isolated test database, separate from the production usage ledger. Microsoft authorization remains encrypted. Healthchecks accepted an HTTP 200 /log request with response body OK from the Droplet; this verified the URL without arming or resetting the monitor. Actual email delivery and dashboard schedule settings remain unverified. WhatsApp pairing succeeded on 11 September; the helper verified the linked account against the requested agent number. A consistent encrypted database backup was created at /opt/mazkir/backups/mazkir-TIMESTAMP.sqlite before startup. The normal service then reconnected successfully; restart count was zero. End-to-end family messages and invitations remain unverified.

11 September update: User confirmed live WhatsApp scheduling works. Added optional per-member additional email recipients; all 23 tests and TypeScript build passed locally and in the server image. Deployed and restarted with the updated configuration; real delivery to the added address remains to be confirmed.
