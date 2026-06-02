/**
 * WhatsApp client wrapper using Baileys.
 * Based on OpenClaw's working implementation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  extractMessageContent as baileysExtractMessageContent,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, basename, resolve, sep } from 'path';
import { randomBytes } from 'crypto';

const VERSION = '0.1.0';

export interface InboundMessage {
  id: string;
  sender: string;
  pn: string;
  content: string;
  timestamp: number;
  isGroup: boolean;
  wasMentioned?: boolean;
  media?: string[];
}

export interface WhatsAppClientOptions {
  authDir: string;
  onMessage: (msg: InboundMessage) => void;
  onQR: (qr: string) => void;
  onStatus: (status: string) => void;
}

export class WhatsAppClient {
  private sock: any = null;
  private options: WhatsAppClientOptions;
  private reconnecting = false;

  constructor(options: WhatsAppClientOptions) {
    this.options = options;
  }

  private normalizeJid(jid: string | undefined | null): string {
    // Extract leading digits: handles 6285186675994:14@s.whatsapp.net, 157080610721998:14@lid, 157080610721998@lid
    const match = /^(\d+)/.exec(jid || '');
    return match ? match[1] : '';
  }

  private wasMentioned(msg: any): boolean {
    if (msg?.key?.remoteJid?.split('@')[1] !== 'g.us') return false;

    const candidates = [
      msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid,
      msg?.message?.imageMessage?.contextInfo?.mentionedJid,
      msg?.message?.videoMessage?.contextInfo?.mentionedJid,
      msg?.message?.documentMessage?.contextInfo?.mentionedJid,
      msg?.message?.audioMessage?.contextInfo?.mentionedJid,
    ];
    const mentioned = candidates.flatMap((items) => (Array.isArray(items) ? items : []));
    if (mentioned.length === 0) return false;

    const selfIds = new Set(
      [this.sock?.user?.id, this.sock?.user?.lid, this.sock?.user?.jid]
        .map((jid) => this.normalizeJid(jid))
        .filter(Boolean),
    );
    return mentioned.some((jid: string) => selfIds.has(this.normalizeJid(jid)));
  }

  async connect(): Promise<void> {
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Using Baileys version: ${version.join('.')}`);

    // Create socket following OpenClaw's pattern
    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['marbot', 'cli', VERSION],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Handle WebSocket errors
    if (this.sock.ws && typeof this.sock.ws.on === 'function') {
      this.sock.ws.on('error', (err: Error) => {
        console.error('WebSocket error:', err.message);
      });
    }

    // Handle connection updates
    this.sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Display QR code in terminal
        console.log('\n📱 Scan this QR code with WhatsApp (Linked Devices):\n');
        qrcode.generate(qr, { small: true });
        await this.writePairingQR(qr);
        this.options.onQR(qr);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`Connection closed. Status: ${statusCode}, Will reconnect: ${shouldReconnect}`);
        this.options.onStatus('disconnected');

        if (shouldReconnect && !this.reconnecting) {
          this.reconnecting = true;
          console.log('Reconnecting in 5 seconds...');
          setTimeout(() => {
            this.reconnecting = false;
            this.connect();
          }, 5000);
        }
      } else if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        this.options.onStatus('connected');
      }
    });

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      console.log(`WhatsApp upsert type=${type} messages=${messages.length}`);
      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid || '';
        const messageId = msg.key.id || '';
        if (msg.key.fromMe) {
          console.log(`WhatsApp message skipped fromMe id=${messageId} remote=${remoteJid}`);
          continue;
        }
        if (remoteJid === 'status@broadcast') {
          console.log(`WhatsApp message skipped status broadcast id=${messageId}`);
          continue;
        }

        const unwrapped = baileysExtractMessageContent(msg.message);
        if (!unwrapped) {
          console.log(`WhatsApp message skipped empty content id=${messageId} remote=${remoteJid}`);
          continue;
        }

        const content = this.getTextContent(unwrapped);
        let fallbackContent: string | null = null;
        const mediaPaths: string[] = [];

        if (unwrapped.imageMessage) {
          fallbackContent = '[Image]';
          const path = await this.downloadMedia(msg, unwrapped.imageMessage.mimetype ?? undefined);
          if (path) mediaPaths.push(path);
        } else if (unwrapped.documentMessage) {
          fallbackContent = '[Document]';
          const path = await this.downloadMedia(msg, unwrapped.documentMessage.mimetype ?? undefined,
            unwrapped.documentMessage.fileName ?? undefined);
          if (path) mediaPaths.push(path);
        } else if (unwrapped.videoMessage) {
          fallbackContent = '[Video]';
          const path = await this.downloadMedia(msg, unwrapped.videoMessage.mimetype ?? undefined);
          if (path) mediaPaths.push(path);
        } else if (unwrapped.audioMessage) {
          fallbackContent = '[Voice Message]';
          const path = await this.downloadMedia(msg, unwrapped.audioMessage.mimetype ?? undefined);
          if (path) mediaPaths.push(path);
        }

        const finalContent = content || (mediaPaths.length === 0 ? fallbackContent : '') || '';
        if (!finalContent && mediaPaths.length === 0) {
          console.log(`WhatsApp message skipped unsupported content id=${messageId} remote=${remoteJid}`);
          continue;
        }

        const isGroup = remoteJid.split('@')[1] === 'g.us';
        const wasMentioned = this.wasMentioned(msg);
        console.log(
          `WhatsApp inbound id=${messageId} remote=${remoteJid} alt=${msg.key.remoteJidAlt || ''} ` +
          `group=${isGroup} mentioned=${wasMentioned} media=${mediaPaths.length} text=${finalContent.slice(0, 80)}`,
        );

        this.options.onMessage({
          id: messageId,
          sender: remoteJid,
          pn: msg.key.remoteJidAlt || '',
          content: finalContent,
          timestamp: msg.messageTimestamp as number,
          isGroup,
          ...(isGroup ? { wasMentioned } : {}),
          ...(mediaPaths.length > 0 ? { media: mediaPaths } : {}),
        });
      }
    });
  }

  private async writePairingQR(qr: string): Promise<void> {
    try {
      const pairingDir = join(this.options.authDir, '..', 'pairing');
      await mkdir(pairingDir, { recursive: true });

      const svg = await QRCode.toString(qr, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 512,
      });

      await writeFile(join(pairingDir, 'whatsapp-qr.txt'), qr, 'utf8');
      await writeFile(join(pairingDir, 'whatsapp-qr.svg'), svg, 'utf8');
      await writeFile(
        join(pairingDir, 'whatsapp-qr.html'),
        `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>NanoBot WhatsApp QR</title>
  <style>
    body { font-family: sans-serif; margin: 24px; background: #fff; color: #111; }
    .qr { width: min(90vw, 520px); }
  </style>
</head>
<body>
  <h1>Scan with WhatsApp Linked Devices</h1>
  <div class="qr">${svg}</div>
</body>
</html>
`,
        'utf8',
      );

      console.log(`Wrote WhatsApp pairing QR files to ${pairingDir}`);
    } catch (err) {
      console.error('Failed to write pairing QR files:', err);
    }
  }

  private async downloadMedia(msg: any, mimetype?: string, fileName?: string): Promise<string | null> {
    try {
      const mediaDir = join(this.options.authDir, '..', 'media');
      await mkdir(mediaDir, { recursive: true });

      const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;

      let outFilename: string;
      if (fileName) {
        const safeName = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
        outFilename = `wa_${Date.now()}_${randomBytes(4).toString('hex')}_${safeName}`;
      } else {
        const mime = mimetype || 'application/octet-stream';
        const ext = '.' + (mime.split('/').pop()?.split(';')[0] || 'bin');
        outFilename = `wa_${Date.now()}_${randomBytes(4).toString('hex')}${ext}`;
      }

      const filepath = resolve(mediaDir, outFilename);
      if (!filepath.startsWith(resolve(mediaDir) + sep)) {
        throw new Error(`Path traversal blocked: ${outFilename}`);
      }
      await writeFile(filepath, buffer);

      return filepath;
    } catch (err) {
      console.error('Failed to download media:', err);
      return null;
    }
  }

  private getTextContent(message: any): string | null {
    // Text message
    if (message.conversation) {
      return message.conversation;
    }

    // Extended text (reply, link preview)
    if (message.extendedTextMessage?.text) {
      return message.extendedTextMessage.text;
    }

    // Image with optional caption
    if (message.imageMessage) {
      return message.imageMessage.caption || '';
    }

    // Video with optional caption
    if (message.videoMessage) {
      return message.videoMessage.caption || '';
    }

    // Document with optional caption
    if (message.documentMessage) {
      return message.documentMessage.caption || '';
    }

    // Voice/Audio message
    if (message.audioMessage) {
      return `[Voice Message]`;
    }

    return null;
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected');
    }

    await this.sock.sendMessage(to, { text });
  }

  async sendMedia(
    to: string,
    filePath: string,
    mimetype: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected');
    }

    const buffer = await readFile(filePath);
    const category = mimetype.split('/')[0];

    if (category === 'image') {
      await this.sock.sendMessage(to, { image: buffer, caption: caption || undefined, mimetype });
    } else if (category === 'video') {
      await this.sock.sendMessage(to, { video: buffer, caption: caption || undefined, mimetype });
    } else if (category === 'audio') {
      await this.sock.sendMessage(to, { audio: buffer, mimetype });
    } else {
      const name = fileName || basename(filePath);
      await this.sock.sendMessage(to, { document: buffer, mimetype, fileName: name });
    }
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }
}
