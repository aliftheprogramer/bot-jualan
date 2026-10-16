import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, normalizeMessageContent, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import type { Config } from './config.js';
import { resolveCustomer } from './identity.js';
import type { Store } from './store.js';
import { ProviderError, type Messenger, type OutgoingMessage } from './providers/types.js';

export class WhatsApp implements Messenger {
  private socket?: WASocket;
  private connected = false;
  private stopping = false;
  private retries = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private pending = new Set<Promise<void>>();

  constructor(private store: Store, private config: Pick<Config, 'sessionPath' | 'botName'>) {}

  async start() {
    await mkdir(this.config.sessionPath, { recursive: true, mode: 0o700 });
    const auth = await useMultiFileAuthState(this.config.sessionPath);
    const socket = makeWASocket({ auth: auth.state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false });
    this.socket = socket;
    const track = (task: Promise<void>) => {
      this.pending.add(task);
      void task.catch(() => { console.error('WhatsApp task failed; no sensitive payload logged.'); }).finally(() => this.pending.delete(task));
    };
    socket.ev.on('creds.update', () => track(auth.saveCreds()));
    socket.ev.on('connection.update', update => {
      if (update.qr) track((async () => {
        const path = join(this.config.sessionPath, 'pairing.png');
        await QRCode.toFile(path, update.qr!, { width: 600 });
        console.info(`Pairing diperlukan. Buka file lokal ${path}; jangan membagikan gambar ini.`);
      })());
      if (update.connection === 'open') {
        this.connected = true;
        this.retries = 0;
        console.info('WhatsApp connected.');
      }
      if (update.connection === 'close') {
        this.connected = false;
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (!this.stopping && code !== DisconnectReason.loggedOut) {
          const delay = Math.min(60000, 1000 * 2 ** Math.min(this.retries++, 6));
          this.reconnect = setTimeout(() => { track(this.start()); }, delay);
        } else if (!this.stopping) console.error('WhatsApp logged out. Pairing ulang manual diperlukan; sesi tidak dihapus otomatis.');
      }
    });
    socket.ev.on('messages.upsert', event => {
      if (event.type !== 'notify' || this.stopping) return;
      track((async () => {
        for (const message of event.messages) {
          if (message.key.fromMe || !message.key.id) continue;
          const customer = await resolveCustomer(message.key.remoteJid, message.key.remoteJidAlt, lid => socket.signalRepository.lidMapping.getPNForLID(lid));
          if (!customer) continue;
          const content = normalizeMessageContent(message.message);
          const text = content?.conversation ?? content?.extendedTextMessage?.text;
          if (typeof text === 'string') await this.store.acceptCommand(customer, text, message.key.id);
        }
      })());
    });
  }

  async send(customer: string, message: OutgoingMessage, messageId: string): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected || this.stopping) throw new ProviderError('WhatsApp', 'OFFLINE');
    if (!/^\d{8,15}$/.test(customer)) throw new ProviderError('WhatsApp', 'INVALID_RECIPIENT');
    const destination = `${customer}@s.whatsapp.net`;
    const send = async () => {
      if (message.qr || message.imagePath) {
        const image = message.qr ? await QRCode.toBuffer(message.qr, { width: 600, margin: 2 }) : await readFile(message.imagePath!);
        if (image.length > 5 * 1024 * 1024) throw new ProviderError('WhatsApp', 'IMAGE_TOO_LARGE');
        await socket.sendMessage(destination, { image, caption: message.text.slice(0, 900) }, { messageId });
        if (message.text.length > 900) await socket.sendMessage(destination, { text: message.text.slice(900) }, { messageId: createHash('sha256').update(`${messageId}:tail`).digest('hex').slice(0, 32).toUpperCase() });
      } else await socket.sendMessage(destination, { text: message.text }, { messageId });
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([send(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new ProviderError('WhatsApp', 'SEND_TIMEOUT')), 40000); })]);
    } finally { clearTimeout(timeout); }
  }

  async close() {
    this.stopping = true;
    this.connected = false;
    clearTimeout(this.reconnect);
    await this.socket?.end(undefined);
    await Promise.allSettled([...this.pending]);
  }
}
