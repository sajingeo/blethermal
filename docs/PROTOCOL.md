# AH-M2 thermal printer BLE protocol

This protocol was reverse engineered from **Funny Print 2.8.1** (`com.lailaixiong.funnyprint`) for Android.
The app calls its printer driver `XiqiPrinter`. The same driver serves every printer the app supports. The AH-M2 is one of them.

> **Status.** Verified on a real AH-M2, sold as the XenGro Mini Sticker Printer, from Chrome on macOS. The handshake, status messages and job flow match the app. Text, photos and the test pattern all print correctly with the settings in section 8. Section 8 also covers what the app does not tell you: pacing, the tear-edge distance, start-up distortion and dot gain.

## 1. How the app is built

| Layer | What it does |
|---|---|
| React Native + Hermes bytecode (`assets/index.android.bundle`) | All BLE logic: scanning, connecting, handshake, packetising and flow control. It uses `react-native-ble-plx`. |
| Kotlin native modules (`cn.lailaixiong.funnyprint.ReactNaitveModule`) | Turns content into a printer bitmap. `CaptureModule` renders HTML to a 384 px wide image. `PicProcessModule` and `ImageUtil` dither and pack it into 1-bit data. |
| Backend `http://apidev.lailaixiong.com.cn` | Accounts, templates, AI image features and an optional licence check. **Printing does not need the backend.** |

Tools used: `hermes-dec` to decompile the Hermes bundle and `jadx` for the Java and Kotlin code.

## 2. Discovery and GATT

The app scans for every device and keeps those whose advertised **local name** exactly matches its allow-list. That list includes `AH-M2`, `TD-11308`, `T02`, `LX-D01`…`LX-D09`, `LX-D002`…`LX-D009`, `DL-P01`, `ITW14302`, `SWS-PT1` and `ZH-P06`.

It also reads the MAC address from the last 6 bytes of the manufacturer data. The UI uses this only to tell devices apart.

| Item | UUID | Use |
|---|---|---|
| Service | `0000ffe6-0000-1000-8000-00805f9b34fb` | The app picks the first service whose UUID contains `ffe6`. |
| Write characteristic | `0000ffe1-0000-1000-8000-00805f9b34fb` | App to printer. Always **write without response**. |
| Notify characteristic | `0000ffe2-0000-1000-8000-00805f9b34fb` | Printer to app. Notifications are enabled with `monitor()`. |

After connecting, the app calls `discoverAllServicesAndCharacteristics()` and requests an **MTU of 128**. The largest packet is 100 bytes, so the MTU must be at least 103.

## 3. Framing

Every command and every notification starts with `0x5A`, followed by a command byte.
Image data packets start with `0x55` instead.
Multi-byte integers are **big-endian**. Commands are zero-padded to 12 bytes, except the 3-byte density command.

### App to printer

| Cmd | Name in app | Length | Layout |
|---|---|---|---|
| `01` | `sendHardwareInfo` | 12 | `5A 01` + 10 × `00` |
| `03` | `sendMovePaper` | 12 | `5A 03 82 00 03` + 7 × `00`. Sent only to label printers. |
| `04` | `sendPrintStatus` | 12 | `5A 04 TT TT FF NN` + 6 × `00` |
| `0A` | `sendHandshake` | 12 | `5A 0A` + 10 random bytes |
| `0B` | `sendAPPCheck` | 12 | `5A 0B` + 10 CRC high bytes |
| `0C` | `setDensity` | 3 | `5A 0C LL` |
| — | data packet | 100 | `55 II II` + 96 bitmap bytes + `00` |

Fields of the `04` command:

* `TT TT` is the total number of data packets, as a u16.
* `FF` is the job flag. `00` starts a job. `01` ends or cancels it.
* `NN` is the number of copies. Only printer types 2, 3, 5 and 6 use it. The AH-M2 is type 1 and always gets `00`.

The density byte `LL` is the UI level minus one. The UI offers levels 1 to 7, so `LL` ranges from `00` to `06`.

### Printer to app

The app dispatches on byte 1 once byte 0 equals `0x5A`.

| Cmd | Handler | Meaning | Payload |
|---|---|---|---|
| `01` | `process0x01Resp` | Hardware info | bytes 4–9 = MAC, byte 11 = model byte |
| `02` | `process0x02Resp` | Status | see below |
| `03` | `process0x03Resp` | Paper moved | The app then starts the job (label printers only). |
| `04` | `process0x04Resp` | Job status ack | If byte 4 is `01`, the app returns to idle. |
| `05` | `process0x05Resp` | Resend request | bytes 2–3 = u16 index. The app resumes at packet `index − 1`. |
| `06` | `process0x06Resp` | Print finished | bytes 2–3 = total packets received, byte 4 = count |
| `08` | `process0x08Resp` | Pause | Stop sending data. The printer buffer is full. |
| `0A` | `process0x0aResp` | Handshake reply | bytes 2–11 = 10 CRC low bytes |
| `0B` | `process0x0bResp` | App check result | byte 2: `01` = passed, `00` = failed |
| `0C` | not handled by the app | Density echo, seen on the AH-M2 | byte 2 = density sent, byte 3 = packet count of the previous job (low byte), byte 4 = `01`, padded to 12 bytes |

Status notification `5A 02`:

| Byte | Field | Notes |
|---|---|---|
| 2 | battery | Percent |
| 3 | paper | `1` = out of paper |
| 4 | charge | `1` = charging |
| 5 | hot | `1` = print head too hot |
| 6 | lowVoltage | `1` = battery too low to print |
| 7 | density | Current density setting |

The app never sends a status request, so the printer pushes this message on its own.

## 4. Connection handshake

The app runs this sequence every time it connects. It authenticates the app to the printer.

```
App                                   Printer
 │  5A 01 00…                            │   hardware info request
 │ ◄──────────── 5A 01 ?? ?? M0..M5 ?? T │   MAC + model byte
 │  5A 0A R0..R9                         │   10 random bytes, each 1..254
 │ ◄──────────── 5A 0A L0..L9            │   printer proves it knows the MAC
 │  5A 0B H0..H9                         │   app proves the same
 │ ◄──────────── 5A 0B 01                │   01 = accepted
 ▼  state = Idle                         ▼
```

For each random byte `Ri`, compute a CRC over 7 bytes:

```
crc_i = CRC16_XMODEM([Ri, M0, M1, M2, M3, M4, M5])
Li = crc_i & 0xFF      // the printer must return these
Hi = crc_i >> 8        // the app sends these
```

CRC-16/XMODEM uses polynomial `0x1021`, initial value `0x0000`, no reflection and no final XOR. Its check value for `"123456789"` is `0x31C3`.

The app sends `5A 0B` only if the printer's `L0..L9` match. Otherwise it logs `low crc error` and stops.

For names other than `DL-P01`, `DL-T01`, `LX-D05-PRO`, `ZH-P06`, `LX-D002`, `TD-11308` and `T02`, the app sets printer type 1 and runs the handshake. That rule covers the AH-M2. The other models skip the handshake and derive their type from the model byte:

| Model byte | Type |
|---|---|
| `0x01` | 3 |
| `0xE0` | 2 |
| `0xE1` | 6, a label printer |

## 5. Bitmap format

* The line is **384 dots** wide, which is 48 bytes. At the usual 203 dpi for these heads, that is about 48 mm of printable width, and 8 lines make 1 mm.
* Each byte holds 8 dots. The **most significant bit is the leftmost dot**, and **1 means black**.
* Rows are stored top to bottom with no row header.
* The whole buffer is zero-padded to a multiple of **96 bytes**, which is 2 lines (`alignMainBuffer`).

How the app builds the bitmap:

* **Text and labels.** HTML is rendered in an offscreen WebView and scaled to 384 px wide. A pixel prints black when its red channel is below 240 (`ImageUtil.bitmapToBinaryBuffer`).
* **Photos.** The main photo path (`PicProcessModule.convertImage3`) sharpens with a 3×3 kernel (centre 9, neighbours −1). It then adds 15 to every gray value below 127 (`brightGrayImage`) and Floyd–Steinberg dithers with threshold 128 (`ImageUtil.ditherImageToBinaryBuffer`). Simpler paths skip the sharpening and lightening.

**Dot gain on the AH-M2.** Dithered images print much darker than their dot pattern, because each heated dot spreads into its neighbours. In testing at density 4, a photo printed as dark as the same image shifted about 85 gray levels darker. A 50 % dot pattern therefore reads as roughly 83 % black. A printed-lightness model of `(1 − coverage)^k` with k ≈ 2.5 fits this. `web/printer.js` pre-compensates with `gray' = 255 · (gray/255)^(1/k)` before dithering, and the page's preview uses the same model to simulate the print.

## 6. Print job

```
App                                         Printer
 │  5A 0C LL                                   │  optional density
 │  5A 04 TT TT 00 00 …                        │  start job: TT = packet count
 │  55 00 00 <96 bytes> 00                     │
 │  55 00 01 <96 bytes> 00                     │
 │  …                                          │
 │ ◄─────────────────── 5A 08                  │  pause: buffer full
 │ ◄─────────────────── 5A 05 II II            │  resume from packet II-1
 │  55 … resend from II-1 …                    │
 │  55 TT-1 …                                  │  last packet
 │ ◄─────────────────── 5A 06 TT TT CC         │  printing finished
 │  5A 04 TT TT 01 00 …                        │  end job
 │ ◄─────────────────── 5A 04 … 01             │  back to idle
```

Rules:

* Packets are numbered from 0 and sent with write-without-response. The app awaits each write, with no other delay. That is safe on Android but drops packets on macOS, as section 8 explains.
* The app starts the data immediately after `5A 04 … 00` and does not wait for a reply.
* After the last packet, the app waits **15 s** for `5A 06`. On timeout it forces the job state back to idle.
* **Copies on the AH-M2.** The bitmap itself is repeated, with **2304 blank bytes** (48 blank lines) between copies. `NN` stays `00`.
* **Cancel.** Send `5A 04 TT TT 01 00…` and stop sending data.
* **Feed.** Type-1 printers have no feed command. Print blank lines instead. On the AH-M2 the tear-off edge is about **69 lines (8.6 mm) past the print head**, measured by printing the same text with different trailing feeds. Anything printed in the last 69 lines of a job stays inside the printer. `web/index.html` trims blank lines from the image and then adds 80 lines after the last black dot.
* **Start-up distortion.** The first ~16 lines of every job print squashed, because the paper motor is still getting up to speed. A test pattern with a line-numbered staircase showed lines 0–16 compressed and everything after them correct. `web/index.html` therefore puts 24 blank lines in front of the content by default. Blank lines are enough. With 24 blank lines in front, the line-numbered test pattern printed clean from its first line. The page also offers an "Edge dots" lead-in, with one dot at the left edge of each lead-in line, but this printer does not need it.

The app's internal states are `Disconnected`, `Connected`, `Idle`, `Printing`, `PrintPaused`, `PrintingCompleted` and `Error`. Printing is allowed only in `Idle`.

## 7. Worked example

A 2-line job that prints a single black dot in the top-left corner:

```
→ 5A 0C 03                                  density 4
→ 5A 04 00 01 00 00 00 00 00 00 00 00       start, 1 packet
→ 55 00 00 80 00 … (95 more bytes) … 00     packet 0
← 5A 06 00 01 01                            done
→ 5A 04 00 01 01 00 00 00 00 00 00 00       end
```

## 8. Observations from a real AH-M2

All tests were run from Chrome on macOS.

### Settings that work

| Setting | Value | Why |
|---|---|---|
| Gap between data packets | 20 ms | Without it, macOS drops packets and the print is cut short. |
| Blank lines before content | 24 | The first ~16 lines of a job print squashed. |
| Blank lines after the last dot | 80 | The tear edge is ~69 lines past the head. |
| Dot-gain factor for photos | 2.5 | Dithered images otherwise print far too dark. |
| Density | 4, sent as `5A 0C 03` | The default used in testing. |

### Traffic

A typical session:

```
← 5A 01 00 03 41 42 00 00 11 59 01 00      hardware info
← 5A 0B 01 00 00 00 00 00 00 00 00 00      app check passed
← 5A 02 60 00 00 00 00 03 01 D0 23 23      status, pushed every ~2 s
← 5A 04 00 A0 00 00 00 00 00 00 00 00      echo of the start command
← 5A 06 00 A0 01 00 00 00 00 00 00 00      done, echoes the packet count
```

### Findings

* The printer advertises as `AH-M2` and accepts the handshake exactly as described in section 4.
* FFE1 supports only **write without response** and **read**. There is no acknowledged write, so pacing has to be done by timing.
* With a 20 ms gap between data packets, the 160-packet test pattern printed completely from macOS Chrome. Sending took 3.6 s.
* On macOS the first write right after enabling notifications sometimes fails with "GATT operation failed for unknown reason". A 250 ms pause plus a retry avoids it.
* The bytes the app treats as the MAC (4–9 of `5A 01`) are `41 42 00 00 11 59`. The CRC handshake passes with these bytes. Byte 11, the model byte, is `00`.
* Status arrives unprompted about every 2 seconds and is 12 bytes long. Byte 2 is the battery level (`0x60` = 96 %). Byte 7 holds the density. Bytes 8–11 (`01 D0 23 23`) are not read by the app. Byte 9 drifts between `D0` and `D9`, so it may be a temperature or voltage reading.
* The printer echoes `5A 04` straight back. `5A 06` repeats the job's packet count in bytes 2–3, so it does **not** prove every packet arrived.

**Pacing matters.** The first print was cut short. All 160 data packets left in under a second, while printing took 8 seconds, and the printer never sent `5A 08`. On macOS, Chrome resolves write-without-response before the packet is on air. CoreBluetooth then drops packets once its queue fills. Android's stack waits for each write to clear, so the app never needed pacing. `web/printer.js` therefore waits 20 ms between data packets by default. That fixed the problem.

### Still open

1. The smallest reliable packet gap on each platform. 20 ms works on macOS.
2. The meaning of status bytes 8–11.
3. What `5A 03 82 00 03` does on label models. The value `0x82` may be a feed distance.

## 9. Where things are in the app

| Topic | Location |
|---|---|
| Driver class | Hermes bundle, class `XiqiPrinter` |
| Scan allow-list | `allowedNames` in the `XiqiPrinter` constructor |
| GATT setup | `connect()`: finds `ffe6`, `ffe1`, `ffe2` and requests MTU 128 |
| Notification dispatch | `deviceCallback` |
| Packet sender | `sendData` → `writeCharacteristicWithoutResponseForDevice` |
| Data loop | `sendPkgLoop`, `innerPrint`, `alignMainBuffer` |
| Handshake | `sendHandshake`, `checkCrc`, `crc16xmodem`, `sendAPPCheck` |
| Bitmap encoding | `cn/lailaixiong/funnyprint/util/ImageUtil.java` |
| HTML to bitmap | `cn/lailaixiong/funnyprint/ReactNaitveModule/CaptureModule.java` |
