import assert from 'node:assert/strict';
import * as P from '../web/printer.js';

// The app's crc16xmodem, transcribed from the decompiled Hermes bytecode.
function appCrc(bytes) {
  let c = 0;
  bytes.forEach((b) => {
    for (let i = 0; i < 8; i++) {
      const bit = ((b >> (7 - i)) & 1) === 1;
      const c15 = ((c >> 15) & 1) === 1;
      c <<= 1;
      if (c15 ^ bit) c ^= 4129;
    }
  });
  return (c & 65535) ^ 0;
}

// CRC-16/XMODEM check value
assert.equal(P.crc16xmodem(new TextEncoder().encode('123456789')), 0x31c3);
for (let t = 0; t < 2000; t++) {
  const b = Array.from({ length: 7 }, () => Math.floor(Math.random() * 256));
  assert.equal(P.crc16xmodem(b), appCrc(b));
}

// Handshake CRC split, mirroring the app's checkCrc string logic
const rnd = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 254]);
const mac = Uint8Array.from([0xaa, 0xbb, 0xcc, 0x11, 0x22, 0x33]);
const { low, high } = P.handshakeCrcs(rnd, mac);
let lowS = '', highS = '';
for (let i = 0; i < 10; i++) {
  const h = appCrc([rnd[i], ...mac]).toString(16).toUpperCase().padStart(4, '0');
  lowS += h.substring(2, 4); highS += h.substring(0, 2);
}
assert.equal(P.hex(low).replace(/ /g, ''), lowS);
assert.equal(P.hex(high).replace(/ /g, ''), highS);

// Command frames
assert.equal(P.hex(P.cmdHardwareInfo()), '5A 01 00 00 00 00 00 00 00 00 00 00');
assert.equal(P.hex(P.cmdDensity(1)), '5A 0C 00');
assert.equal(P.hex(P.cmdDensity(7)), '5A 0C 06');
assert.equal(P.hex(P.cmdPrintStatus(0x0123, 0, 0)), '5A 04 01 23 00 00 00 00 00 00 00 00');
assert.equal(P.hex(P.cmdPrintStatus(5, 1, 0)), '5A 04 00 05 01 00 00 00 00 00 00 00');
assert.equal(P.hex(P.cmdMovePaper()), '5A 03 82 00 03 00 00 00 00 00 00 00');
assert.equal(P.cmdHandshake(rnd).length, 12);
assert.deepEqual([...P.cmdAppCheck(high).slice(2)], [...high]);

// Data packet
const bm = new Uint8Array(96 * 3).map((_, i) => i & 0xff);
const pk = P.dataPacket(2, bm);
assert.equal(pk.length, 100);
assert.deepEqual([...pk.slice(0, 4)], [0x55, 0x00, 0x02, bm[192]]);
assert.equal(pk[98], bm[287]);
assert.equal(pk[99], 0);

// Bit packing: MSB first, 1 = black, 48 bytes per line
const dots = new Uint8Array(384 * 2); dots[0] = 1; dots[9] = 1; dots[384 + 383] = 1;
const packed = P.packDots(dots, 384, 2);
assert.equal(packed.length, 96);
assert.equal(packed[0], 0x80); assert.equal(packed[1], 0x40); assert.equal(packed[95], 0x01);

// Threshold vs dither on mid-gray
const gray = new Uint8ClampedArray(384 * 4).fill(128);
assert.equal(P.grayToDots(gray, 384, 4, { dither: 'none', threshold: 129 }).reduce((a, b) => a + b), 384 * 4);
const fs = P.grayToDots(gray, 384, 4, { dither: 'floyd' }).reduce((a, b) => a + b);
assert.ok(fs > 384 * 4 * 0.4 && fs < 384 * 4 * 0.6, `dither ratio ${fs}`);
assert.equal(P.grayToDots(new Uint8ClampedArray(384).fill(0), 384, 1, { dither: 'none', invert: true }).reduce((a, b) => a + b), 0);

// Job assembly: pad to 96, copies separated by 2304 blank bytes
assert.equal(P.alignToChunk(new Uint8Array(100)).length, 192);
assert.equal(P.buildJob(new Uint8Array(96).fill(1), 3).length, 96 * 3 + 2304 * 2);
const led = P.buildJob(new Uint8Array(96).fill(1), 1, 0, 16);
assert.equal(led.length, 16 * 48 + 96);
assert.ok(led.slice(0, 16 * 48).every((b) => b === 0)); assert.equal(led[16 * 48], 1);
const dotted = P.buildJob(new Uint8Array(96).fill(1), 1, 0, 4, true);
assert.deepEqual([0, 48, 96, 144].map((i) => dotted[i]), [0x80, 0x80, 0x80, 0x80]);
assert.equal(dotted.slice(0, 4 * 48).reduce((a, b) => a + (b ? 1 : 0), 0), 4);
const fed = P.buildJob(new Uint8Array(96).fill(1), 1, 80);
assert.equal(fed.length, 96 + 80 * 48);
assert.ok(fed.slice(96).every((b) => b === 0));
assert.equal(P.buildJob(new Uint8Array(96), 1, 1).length % 96, 0);

// Notification parsing
const st = P.parseNotification(Uint8Array.from([0x5a, 0x02, 80, 1, 0, 1, 0, 3]));
assert.equal(st.type, 'status'); assert.equal(st.battery, 80); assert.ok(st.noPaper); assert.ok(st.overheat); assert.equal(st.density, 3);
const hw = P.parseNotification(Uint8Array.from([0x5a, 1, 0, 0, 1, 2, 3, 4, 5, 6, 0, 9]));
assert.deepEqual([...hw.mac], [1, 2, 3, 4, 5, 6]); assert.equal(hw.model, 9);
assert.equal(P.parseNotification(Uint8Array.from([0x5a, 5, 0, 7])).index, 7);
assert.equal(P.parseNotification(Uint8Array.from([0x5a, 0x0b, 1])).ok, true);
assert.equal(P.parseNotification(Uint8Array.from([0x11, 1])).type, 'invalid');
const dack = P.parseNotification(Uint8Array.from([0x5a, 0x0c, 3, 0x30, 1, 0, 0, 0, 0, 0, 0, 0]));
assert.equal(dack.density, 3); assert.equal(dack.lastJobPackets, 0x30);

// Trimming blank lines: 3 blank, ink, 1 blank, ink, 4 blank -> 3 lines kept
const img = new Uint8Array(48 * 10); img[48 * 3 + 5] = 0x10; img[48 * 5 + 47] = 0x01;
const trimmed = P.trimBlankLines(img);
assert.equal(trimmed.length, 48 * 3); assert.equal(trimmed[5], 0x10); assert.equal(trimmed[48 * 2 + 47], 0x01);
assert.equal(P.trimBlankLines(new Uint8Array(48 * 4)).length, 0);

// Dot gain: endpoints fixed, midtones lightened, k = 1 is a no-op
const g = Uint8ClampedArray.from([0, 64, 128, 192, 255]);
P.dotGainCorrect(g, 2.5);
assert.equal(g[0], 0); assert.equal(g[4], 255);
assert.ok(Math.abs(g[2] - 194) <= 1, `mid ${g[2]}`);
assert.ok(g[1] < g[2] && g[2] < g[3]);
assert.deepEqual([...P.dotGainCorrect(Uint8ClampedArray.from([10, 128]), 1)], [10, 128]);

// Simulated print: white stays white, black stays black, 50 % checker with k = 1 ≈ mid gray
const W = 8, H = 8;
assert.ok(P.simulatePrint(new Uint8Array(W * H), W, H, 2.5).every((v) => v === 255));
assert.ok(P.simulatePrint(new Uint8Array(W * H).fill(1), W, H, 2.5).every((v) => v === 0));
const chk = new Uint8Array(W * H).map((_, i) => ((i % W) + Math.floor(i / W)) % 2);
const mid = P.simulatePrint(chk, W, H, 1)[3 * W + 3];
assert.ok(mid > 100 && mid < 160, `checker ${mid}`);
// Round trip: correcting then simulating a flat gray should land near the original
const flat = new Uint8ClampedArray(384 * 40).fill(128);
P.dotGainCorrect(flat, 2.5);
const sim = P.simulatePrint(P.grayToDots(flat, 384, 40, { dither: 'floyd' }), 384, 40, 2.5);
const avg = sim.slice(384 * 10, 384 * 30).reduce((a, b) => a + b, 0) / (384 * 20);
assert.ok(Math.abs(avg - 128) < 25, `round trip ${avg}`);

console.log('all protocol tests passed');
