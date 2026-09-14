import makeWASocket, { BufferJSON, DisconnectReason, downloadMediaMessage, initAuthCreds,
  jidNormalizedUser, normalizeMessageContent, prepareWAMessageMedia, proto, type AuthenticationState,
  type SignalDataTypeMap, type SignalDataSet, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { POLICY, type Config, type Member, RetryableError } from './config.js';
import { Store } from './store.js';
import type { Messenger } from './worker.js';
import type { ReplyAudio } from './speech.js';

const logger = pino({ level: 'silent' }); // Protocol logs can contain private message/session material.
function read<T>(store: Store, key: string): T | undefined {
  const value = store.get<string>('wa:' + key);
  return value === undefined ? undefined : JSON.parse(value, BufferJSON.reviver) as T;
}
function write(store: Store, key: string, value: unknown): void {
  store.set('wa:' + key, JSON.stringify(value, BufferJSON.replacer));
}
export function encryptedAuth(store: Store): { state: AuthenticationState; save: () => void } {
  const creds = read<AuthenticationState['creds']>(store, 'creds') ?? initAuthCreds();
  const state: AuthenticationState = { creds, keys: {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        let value = read<SignalDataTypeMap[T]>(store, `${type}:${id}`);
        if (value && type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as unknown as Record<string, unknown>) as unknown as SignalDataTypeMap[T];
        if (value) result[id] = value;
      }
      return result;
    },
    set: async (data: SignalDataSet) => {
      store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [type, values] of Object.entries(data)) for (const [id, value] of Object.entries(values ?? {})) {
          if (value) write(store, `${type}:${id}`, value); else store.remove(`wa:${type}:${id}`);
        }
        store.db.exec('COMMIT');
      } catch (e) { store.db.exec('ROLLBACK'); throw e; }
    },
  } };
  return { state, save: () => write(store, 'creds', creds) };
}
export function memberForJid(jid: string, members: Member[], mappedPhone?: string): Member | undefined {
  const normalized = jidNormalizedUser(jid);
  const phone = normalized.endsWith('@s.whatsapp.net') ? normalized.split('@')[0] :
    normalized.endsWith('@lid') ? mappedPhone : undefined;
  return phone ? members.find(m => m.phone === phone) : undefined;
}

export class WhatsApp implements Messenger {
  ready = false;
  needsPairing = false;
  private socket?: WASocket;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private inbound = Promise.resolve();
  constructor(private cfg: Config, private store: Store,
    private status: (message: string) => void, private qr?: (value: string) => void) {}

  connect(): void {
    const auth = encryptedAuth(this.store);
    const socket = makeWASocket({ auth: auth.state, logger, markOnlineOnConnect: false,
      syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      getMessage: async key => {
        const record = read<{ at: number; message: proto.IMessage }>(this.store, 'out:' + key.id);
        return record ? proto.Message.fromObject(record.message) : undefined;
      },
    });
    this.socket = socket;
    socket.ev.on('creds.update', auth.save);
    socket.ev.on('connection.update', update => {
      if (update.qr) {
        this.needsPairing = true;
        if (this.qr) this.qr(update.qr); else this.status('WhatsApp requires pairing.');
      }
      if (update.connection === 'open') {
        this.ready = true; this.needsPairing = false;
        this.status('WhatsApp connected.');
      }
      if (update.connection === 'close') {
        this.ready = false;
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.connectionReplaced) {
          this.needsPairing = true;
          this.status('WhatsApp session needs attention. Stop the service and run pair:whatsapp.');
        } else if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 5000);
      }
    });
    socket.ev.on('messages.upsert', event => {
      if (event.type !== 'notify') return;
      for (const message of event.messages) {
        this.inbound = this.inbound.then(() => this.accept(message, socket)).catch(() => {
          this.status('An inbound message could not be stored.');
          this.store.set('inbound-fault', true);
        });
      }
    });
  }
  private async accept(message: WAMessage, socket: WASocket): Promise<void> {
    if (message.key.fromMe || !message.key.remoteJid || !message.key.id) return;
    const jid = jidNormalizedUser(message.key.remoteJid);
    let mappedPhone: string | undefined;
    if (jid.endsWith('@lid')) {
      // Resolve through Baileys' authenticated Signal mapping, never display names or message text.
      const pn = await socket.signalRepository.lidMapping.getPNForLID(jid);
      mappedPhone = pn ? jidNormalizedUser(pn).split('@')[0] : undefined;
    }
    const member = memberForJid(jid, this.cfg.members, mappedPhone);
    if (!member) return;
    const content = normalizeMessageContent(message.message);
    if (!content || content.protocolMessage || content.reactionMessage) return;
    const at = new Date(Number(message.messageTimestamp) * 1000);
    if (!Number.isFinite(at.getTime())) return;
    const base = { id: `${member.phone}:${message.key.id}`, chat: member.phone, actor: member.name,
      at: at.toISOString(), text: content.conversation ?? content.extendedTextMessage?.text ?? '' };
    // Keep reply routing current when WhatsApp changes a contact from PN to LID addressing.
    this.store.set('route:' + member.phone, jid);
    if (this.store.db.prepare('SELECT id FROM jobs WHERE id=?').get(base.id)) return;
    const audio = content.audioMessage;
    if (audio) {
      const seconds = Number(audio.seconds ?? 0), size = Number(audio.fileLength ?? 0);
      if (seconds <= 0 || seconds > POLICY.maxVoiceSeconds || size > POLICY.maxVoiceBytes) {
        const job = { ...base, text: 'Voice note', status: 'pending', attempts: 0, nextAt: 0 };
        this.store.enqueue(job);
        this.store.readyReply(job, 'Please send a voice note up to 3 minutes. / נא לשלוח הודעה קולית עד 3 דקות.');
        return;
      }
      const stream = await downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30000) } });
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > POLICY.maxVoiceBytes) { stream.destroy(); throw new Error('Voice note too large.'); }
        chunks.push(Buffer.from(chunk));
      }
      this.store.enqueue({ ...base, voiceReply: true, audio: { data: Buffer.concat(chunks).toString('base64'), mime: audio.mimetype ?? 'audio/ogg', seconds } });
    } else if (base.text) this.store.enqueue(base);
    else {
      const job = { ...base, text: 'Unsupported attachment', status: 'pending', attempts: 0, nextAt: 0 };
      this.store.enqueue(job);
      this.store.readyReply(job, 'Please send text or a voice note. / נא לשלוח טקסט או הודעה קולית.');
    }
  }
  async send(chat: string, text: string, id: string): Promise<void> {
    if (!this.ready || !this.socket) throw new RetryableError('WhatsApp is disconnected.');
    const jid = this.store.get<string>('route:' + chat) ?? `${chat}@s.whatsapp.net`;
    const messageId = createHash('sha256').update('reply:' + id).digest('hex').slice(0, 32).toUpperCase();
    write(this.store, 'out:' + messageId, { at: Date.now(), message: { conversation: text } });
    await this.socket.sendMessage(jid, { text }, { messageId });
  }
  async sendAudio(chat: string, audio: ReplyAudio, id: string): Promise<void> {
    if (!this.ready || !this.socket) throw new RetryableError('WhatsApp is disconnected.');
    const jid = this.store.get<string>('route:' + chat) ?? `${chat}@s.whatsapp.net`;
    const messageId = createHash('sha256').update('voice-reply:' + id).digest('hex').slice(0, 32).toUpperCase();
    let record = read<{ at: number; message: proto.IMessage }>(this.store, 'out:' + messageId);
    if (!record) {
      const content = { audio: Buffer.from(audio.data, 'base64'),
        mimetype: audio.mime, ptt: true, seconds: Math.ceil(audio.seconds),
        // Supply duration and omit waveform analysis to avoid plaintext temp audio/decoders.
        waveform: new Uint8Array(0),
      };
      const message = await prepareWAMessageMedia(content, { upload: this.socket.waUploadToServer, mediaUploadTimeoutMs: 30000 });
      record = { at: Date.now(), message };
      write(this.store, 'out:' + messageId, record);
    }
    // Reuse both encrypted media metadata and message ID after uncertain delivery.
    await this.socket.relayMessage(jid, proto.Message.fromObject(record.message), { messageId });
  }
  stop(): void {
    this.stopped = true; this.ready = false;
    clearTimeout(this.reconnect);
    this.socket?.end(undefined);
  }
}
