# blethermal

A browser controller for the **AH-M2** Bluetooth thermal printer, built on Web Bluetooth.
The protocol was reverse engineered from the Funny Print Android app.

## Printer

This project was built and tested with the [XenGro Mini Sticker Printer](https://www.amazon.com/dp/B0F7LQGZ13), which advertises over Bluetooth as `AH-M2`.
Its print head is 384 dots wide. The official app is Funny Print.

## Files

* `docs/PROTOCOL.md` documents the BLE protocol: GATT layout, commands, handshake, bitmap format and print flow. Section 8 lists the settings that work on real hardware and why.
* `web/index.html` is the control page. It prints text, images and a test pattern, sets density and copies, and shows battery and paper status.
* `web/printer.js` is the protocol module. It has no dependencies and works as an ES module in the browser.
* `test/protocol.test.mjs` holds Node tests for the CRC, packet builders, bitmap packing and notification parser.

## Run

Web Bluetooth needs Chrome or Edge on desktop or Android, and a secure context. `localhost` counts as secure.

```bash
npm run serve        # serves web/ at http://localhost:8000
npm test             # protocol unit tests
```

Open http://localhost:8000, turn the printer on, click **Connect** and pick `AH-M2`.

On Linux, Chrome may need `chrome://flags/#enable-experimental-web-platform-features`.
Safari and Firefox do not support Web Bluetooth.
