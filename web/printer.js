// AH-M2 / "XiqiPrinter" BLE protocol, reverse engineered from Funny Print 2.8.1.
// See ../docs/PROTOCOL.md for the full description.
// The pure functions in this file have no browser dependencies, so Node can test them.

export const SERVICE_UUID = 0xffe6;
export const WRITE_CHAR_UUID = 0xffe1;   // write without response
export const NOTIFY_CHAR_UUID = 0xffe2;  // notifications from printer

export const PRINT_WIDTH = 384;          // dots per line
export const BYTES_PER_LINE = PRINT_WIDTH / 8; // 48
export const CHUNK_SIZE = 96;            // bitmap bytes per data packet (2 lines)
export const COPY_GAP_BYTES = 2304;      // blank bytes the app inserts between copies (48 lines)
export const PRINT_TIMEOUT_MS = 15000;

export const HEADER = 0x5a;
export const DATA_HEADER = 0x55;

export const CMD = {
  HARDWARE_INFO: 0x01,
  STATUS: 0x02,
  MOVE_PAPER: 0x03,
  PRINT_STATUS: 0x04,
  RESEND_FROM: 0x05,
  PRINT_DONE: 0x06,
  PAUSE: 0x08,
  HANDSHAKE: 0x0a,
  APP_CHECK: 0x0b,
  DENSITY: 0x0c,
};

// ---------------------------------------------------------------- CRC

/** CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflection, no final xor. */
export function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * For each of the 10 random handshake bytes r[i], CRC the 7 bytes [r[i], mac0..mac5].
 * The low byte of each CRC is what the printer must echo back (0x0A response).
 * The high byte of each CRC is what the app sends in the 0x0B "app check".
 */
export function handshakeCrcs(random10, mac6) {
  const low = new Uint8Array(10);
  const high = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    const crc = crc16xmodem([random10[i], ...mac6]);
    high[i] = crc >> 8;
    low[i] = crc & 0xff;
  }
  return { low, high };
}

// ---------------------------------------------------------------- commands

function frame(len, cmd) {
  const b = new Uint8Array(len);
  b[0] = HEADER;
  b[1] = cmd;
  return b;
}

/** 5A 01 + 10 zero bytes. Asks for MAC and model byte. */
export function cmdHardwareInfo() {
  return frame(12, CMD.HARDWARE_INFO);
}

/** 5A 0A + 10 random bytes in 1..254. */
export function cmdHandshake(random10) {
  const b = frame(12, CMD.HANDSHAKE);
  b.set(random10.slice(0, 10), 2);
  return b;
}

/** 5A 0B + the 10 high CRC bytes. */
export function cmdAppCheck(high10) {
  const b = frame(12, CMD.APP_CHECK);
  b.set(high10.slice(0, 10), 2);
  return b;
}

/** 5A 0C (level-1). The app offers levels 1..7. */
export function cmdDensity(level) {
  const l = Math.max(1, Math.min(7, Math.round(level)));
  const b = frame(3, CMD.DENSITY);
  b[2] = l - 1;
  return b;
}

/**
 * 5A 04 [totalPkg u16 BE] [flag] [copies] + zero padding to 12 bytes.
 * flag 0 = start job, flag 1 = end or cancel job.
 * copies is only honoured by printer types 2, 3, 5 and 6. The AH-M2 is type 1 and
 * gets copies = 0, with copies concatenated into the bitmap instead.
 */
export function cmdPrintStatus(totalPkg, flag, copies = 0) {
  const b = frame(12, CMD.PRINT_STATUS);
  b[2] = (totalPkg >> 8) & 0xff;
  b[3] = totalPkg & 0xff;
  b[4] = flag & 0xff;
  b[5] = copies & 0xff;
  return b;
}

/** 5A 03 82 00 03 + zeros. Sent only to label printers (types 2, 3, 6) before a job. */
export function cmdMovePaper() {
  const b = frame(12, CMD.MOVE_PAPER);
  b[2] = 0x82;
  b[3] = 0x00;
  b[4] = 0x03;
  return b;
}

/** 55 [index u16 BE] [96 bitmap bytes] 00 = 100 bytes. Index is 0-based. */
export function dataPacket(index, bitmap) {
  const b = new Uint8Array(CHUNK_SIZE + 4);
  b[0] = DATA_HEADER;
  b[1] = (index >> 8) & 0xff;
  b[2] = index & 0xff;
  const off = index * CHUNK_SIZE;
  for (let j = 0; j < CHUNK_SIZE; j++) b[3 + j] = bitmap[off + j] ?? 0;
  b[99] = 0x00;
  return b;
}

// ---------------------------------------------------------------- notifications

export function parseNotification(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (v.length < 2 || v[0] !== HEADER) return { type: 'invalid', raw: v };
  const cmd = v[1];
  const u16 = (i) => ((v[i] << 8) | v[i + 1]) >>> 0;
  switch (cmd) {
    case CMD.HARDWARE_INFO:
      return { type: 'hardwareInfo', cmd, mac: v.slice(4, 10), model: v[11], raw: v };
    case CMD.STATUS:
      return {
        type: 'status', cmd, raw: v,
        battery: v[2],
        noPaper: v[3] === 1,
        charging: v[4] === 1,
        overheat: v[5] === 1,
        lowVoltage: v[6] === 1,
        density: v[7],
      };
    case CMD.MOVE_PAPER:
      return { type: 'movePaperAck', cmd, raw: v };
    case CMD.PRINT_STATUS:
      return { type: 'printStatusAck', cmd, flag: v[4], raw: v };
    case CMD.RESEND_FROM:
      return { type: 'resendFrom', cmd, index: u16(2), raw: v };
    case CMD.PRINT_DONE:
      return { type: 'printDone', cmd, total: u16(2), count: v[4], raw: v };
    case CMD.PAUSE:
      return { type: 'pause', cmd, raw: v };
    case CMD.HANDSHAKE:
      return { type: 'handshake', cmd, echo: v.slice(2, 12), raw: v };
    case CMD.DENSITY:
      // Seen on the AH-M2: 5A 0C <density> <previous job's packet count, low byte> 01 00…
      return { type: 'densityAck', cmd, density: v[2], lastJobPackets: v[3], raw: v };
    case CMD.APP_CHECK:
      return { type: 'appCheck', cmd, ok: v[2] === 1, result: v[2], raw: v };
    default:
      return { type: 'unknown', cmd, raw: v };
  }
}

// ---------------------------------------------------------------- bitmap

/** RGBA → 0..255 luminance. Transparent pixels become white. */
export function rgbaToGray(rgba, width, height) {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    g[i] = lum * a + 255 * (1 - a);
  }
  return g;
}

/**
 * Gray → 1-bit dots (true = black). Floyd–Steinberg matches the app's photo mode.
 * Threshold mode matches the app's text and label capture, which uses 240.
 */
export function grayToDots(gray, width, height, { threshold = 128, dither = 'floyd', invert = false } = {}) {
  const buf = Float32Array.from(gray, (v) => (invert ? 255 - v : v));
  const dots = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const black = old < threshold;
      dots[i] = black ? 1 : 0;
      if (dither !== 'floyd') continue;
      const err = old - (black ? 0 : 255);
      if (x + 1 < width) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += (err * 3) / 16;
        buf[i + width] += (err * 5) / 16;
        if (x + 1 < width) buf[i + width + 1] += err / 16;
      }
    }
  }
  return dots;
}

/**
 * Thermal dots spread on paper, so dithered images print darker than the dot
 * pattern suggests. Model: printed lightness = (dot-free fraction)^k. On the
 * AH-M2 a 50 % pattern looked like ~83 % black, which gives k ≈ 2.5.
 * Pre-compensate by raising lightness to the power 1/k. k = 1 is a no-op.
 */
export function dotGainCorrect(gray, k) {
  if (!(k > 1)) return gray;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, 1 / k));
  for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i] | 0];
  return gray;
}

/**
 * Approximate how dots look on paper: local dot coverage over a 3×3 window,
 * then the same dot-gain curve as dotGainCorrect. Returns 0..255 lightness.
 */
export function simulatePrint(dots, width, height, k) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += dots[yy * width + xx];
          n++;
        }
      }
      out[y * width + x] = 255 * Math.pow(1 - sum / n, Math.max(1, k));
    }
  }
  return out;
}

/** Dots → packed rows, MSB = leftmost dot, bit 1 = black. Width must be 384. */
export function packDots(dots, width, height) {
  if (width !== PRINT_WIDTH) throw new Error(`width must be ${PRINT_WIDTH}, got ${width}`);
  const out = new Uint8Array(BYTES_PER_LINE * height);
  for (let i = 0; i < dots.length; i++) {
    if (dots[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/**
 * Drop blank lines above the first and below the last black dot.
 * Paper between the head and the tear edge already forms the top margin, so
 * leading blank lines only waste paper. Returns an empty array if all blank.
 */
export function trimBlankLines(bitmap) {
  const lines = Math.floor(bitmap.length / BYTES_PER_LINE);
  const blank = (l) => {
    for (let i = l * BYTES_PER_LINE, e = i + BYTES_PER_LINE; i < e; i++) if (bitmap[i]) return false;
    return true;
  };
  let top = 0;
  while (top < lines && blank(top)) top++;
  if (top === lines) return new Uint8Array(0);
  let bottom = lines - 1;
  while (bottom > top && blank(bottom)) bottom--;
  return bitmap.slice(top * BYTES_PER_LINE, (bottom + 1) * BYTES_PER_LINE);
}

/** Pad to a whole number of 96-byte packets, as the app's alignMainBuffer does. */
export function alignToChunk(bitmap) {
  const pad = (CHUNK_SIZE - (bitmap.length % CHUNK_SIZE)) % CHUNK_SIZE;
  if (!pad) return bitmap;
  const out = new Uint8Array(bitmap.length + pad);
  out.set(bitmap);
  return out;
}

/**
 * Repeat the job for type-1 printers: [img, gap, img, gap, img ...]. Optionally put
 * leadLines blank lines in front, and feedLines blank lines after so short prints
 * clear the tear-off edge.
 */
export function buildJob(bitmap, copies = 1, feedLines = 0, leadLines = 0, leadDots = false) {
  const img = alignToChunk(bitmap);
  const n = Math.max(1, copies | 0);
  const lead = Math.max(0, leadLines | 0) * BYTES_PER_LINE;
  const tail = Math.max(0, feedLines | 0) * BYTES_PER_LINE;
  const out = new Uint8Array(lead + img.length * n + COPY_GAP_BYTES * (n - 1) + tail);
  // Optionally mark each lead-in line with one dot at the left edge, so the printer
  // treats them as printed lines rather than blank paper.
  if (leadDots) for (let i = 0; i < lead; i += BYTES_PER_LINE) out[i] = 0x80;
  let o = lead;
  for (let c = 0; c < n; c++) {
    if (c) o += COPY_GAP_BYTES;
    out.set(img, o);
    o += img.length;
  }
  return alignToChunk(out);
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();

// ---------------------------------------------------------------- Web Bluetooth driver

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AhM2Printer extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.mac = null;
    this.model = null;
    this.authenticated = false;
    this.status = null;
    this.state = 'disconnected';
    this._waiters = [];
    this._job = null;
    // Pacing for image data. macOS Chrome resolves write-without-response before the
    // packet is on air and CoreBluetooth drops packets once its queue fills, so
    // unpaced jobs print only partly. The AH-M2 has no acknowledged write, so
    // pacing has to be done by timing.
    this.packetDelayMs = 20;
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _log(msg) {
    this._emit('log', msg);
  }

  _setState(s) {
    this.state = s;
    this._emit('state', s);
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser.');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'AH-M2' },
        { namePrefix: 'AHM2' },
        { namePrefix: 'AH' },
        { services: [SERVICE_UUID] },
      ],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this._log(`Connecting to ${this.device.name || this.device.id}…`);
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.writeChar = await service.getCharacteristic(WRITE_CHAR_UUID);
      this.notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
      this.notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
      await this.notifyChar.startNotifications();
      const pr = this.writeChar.properties || {};
      const flags = ['write', 'writeWithoutResponse', 'notify', 'read'].filter((k) => pr[k]);
      this._setState('connected');
      this._log(`GATT ready (service FFE6, write FFE1, notify FFE2). FFE1 supports: ${flags.join(', ') || 'unknown'}.`);
      // macOS can fail the first write if it follows startNotifications immediately.
      await sleep(250);
      await this.authenticate();
    } catch (e) {
      this.disconnect();
      throw e;
    }
    return this.device.name;
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  _onDisconnect() {
    this._setState('disconnected');
    this.authenticated = false;
    if (this._job) this._job.reject(new Error('Printer disconnected'));
    this._job = null;
    this._log('Disconnected.');
  }

  async write(bytes) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.writeChar.writeValueWithoutResponse) {
          await this.writeChar.writeValueWithoutResponse(bytes);
        } else {
          await this.writeChar.writeValue(bytes);
        }
        return;
      } catch (e) {
        // Chrome throws if a previous GATT op is still in flight, and macOS sometimes
        // fails the first write after connecting. Back off and retry.
        if (attempt >= 5 || !/in progress|busy|unknown reason|GATT operation failed/i.test(e.message)) throw e;
        await sleep(20 * (attempt + 1));
      }
    }
  }

  async send(bytes) {
    this._log(`→ ${hex(bytes)}`);
    await this.write(bytes);
  }

  waitFor(type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const w = { type, resolve, reject };
      w.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  _onNotify(ev) {
    const v = new Uint8Array(ev.target.value.buffer.slice(ev.target.value.byteOffset, ev.target.value.byteOffset + ev.target.value.byteLength));
    const msg = parseNotification(v);
    this._log(`← ${hex(v)}  (${msg.type})`);
    for (const w of [...this._waiters]) {
      if (w.type === msg.type) {
        clearTimeout(w.timer);
        this._waiters = this._waiters.filter((x) => x !== w);
        w.resolve(msg);
      }
    }
    if (msg.type === 'status') {
      this.status = msg;
      this._emit('status', msg);
    }
    this._job?.onMessage(msg);
  }

  /** 0x01 → 0x0A challenge → 0x0B response, as the app does after every connect. */
  async authenticate() {
    const infoP = this.waitFor('hardwareInfo');
    await this.send(cmdHardwareInfo());
    let info;
    try {
      info = await infoP;
    } catch (e) {
      this._log('No 0x01 reply. Continuing without handshake. Printing may be refused.');
      this._setState('idle');
      return false;
    }
    this.mac = info.mac;
    this.model = info.model;
    this._emit('info', { mac: hex(info.mac).replace(/ /g, ':'), model: info.model });

    const random = new Uint8Array(10).map(() => 1 + Math.floor(Math.random() * 254));
    const { low, high } = handshakeCrcs(random, this.mac);
    const hsP = this.waitFor('handshake');
    await this.send(cmdHandshake(random));
    try {
      const hs = await hsP;
      if (hex(hs.echo) !== hex(low)) {
        this._log(`Handshake CRC mismatch. Expected ${hex(low)}.`);
        this._setState('idle');
        return false;
      }
      const ackP = this.waitFor('appCheck');
      await this.send(cmdAppCheck(high));
      const ack = await ackP;
      this.authenticated = ack.ok;
      this._log(ack.ok ? 'App check passed.' : `App check failed (result ${ack.result}).`);
    } catch (e) {
      this._log(`Handshake incomplete: ${e.message}`);
    }
    this._setState('idle');
    return this.authenticated;
  }

  async setDensity(level) {
    await this.send(cmdDensity(level));
  }

  /**
   * Print a packed bitmap (48 bytes per line).
   * Flow: 5A 04 start → 55 data packets → printer sends 5A 06 → 5A 04 end.
   * The printer may send 5A 08 to pause, then 5A 05 <index> to resume.
   */
  print(bitmap, { copies = 1, feedLines = 0, leadLines = 0, leadDots = false, onProgress } = {}) {
    if (this.state !== 'idle') return Promise.reject(new Error(`Printer is ${this.state}, not idle`));
    const data = buildJob(bitmap, copies, feedLines, leadLines, leadDots);
    const total = data.length / CHUNK_SIZE;
    if (total > 0xffff) return Promise.reject(new Error('Job too long'));

    return new Promise((resolve, reject) => {
      let sent = 0;
      let paused = false;
      let looping = false;
      let timeout = null;

      const finish = (err) => {
        clearTimeout(timeout);
        this._job = null;
        this._setState('idle');
        err ? reject(err) : resolve();
      };

      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          this._log('Print timeout. Forcing idle.');
          this.write(cmdPrintStatus(total, 1, 0)).catch(() => {});
          finish(new Error('Print timed out'));
        }, PRINT_TIMEOUT_MS);
      };

      const loop = async () => {
        if (looping) return;
        looping = true;
        const t0 = Date.now();
        try {
          while (!paused && sent < total && this._job === job) {
            await this.write(dataPacket(sent, data));
            sent++;
            if (this.packetDelayMs > 0) await sleep(this.packetDelayMs);
            onProgress?.(sent, total);
          }
          if (sent >= total && this._job === job) {
            this._log(`All ${total} packets sent in ${Date.now() - t0} ms (${this.packetDelayMs} ms gap). Waiting for 0x06.`);
            armTimeout();
          }
        } catch (e) {
          finish(e);
        } finally {
          looping = false;
        }
      };

      const job = {
        total,
        reject: (e) => finish(e),
        onMessage: async (msg) => {
          if (msg.type === 'pause') {
            paused = true;
            this._setState('paused');
          } else if (msg.type === 'resendFrom') {
            sent = Math.max(0, msg.index - 1);
            paused = false;
            this._setState('printing');
            clearTimeout(timeout);
            loop();
          } else if (msg.type === 'printDone') {
            if (msg.total !== total) this._log(`0x06 total ${msg.total} ≠ sent ${total}.`);
            try {
              await this.send(cmdPrintStatus(total, 1, 0));
            } catch {}
            finish();
          } else if (msg.type === 'status' && msg.noPaper) {
            this._log('Printer reports no paper.');
          }
        },
      };

      this._job = job;
      this._setState('printing');
      this.send(cmdPrintStatus(total, 0, 0))
        .then(() => sleep(30))
        .then(loop)
        .catch(finish);
    });
  }

  async cancel() {
    if (!this._job) return;
    const job = this._job;
    this._job = null;
    try {
      await this.send(cmdPrintStatus(job.total, 1, 0));
    } finally {
      this._setState('idle');
      job.reject(new Error('Cancelled'));
    }
  }

  /** Feed paper by printing blank lines. Type-1 printers have no separate feed command. */
  feed(lines = 48) {
    return this.print(new Uint8Array(BYTES_PER_LINE * lines));
  }
}
