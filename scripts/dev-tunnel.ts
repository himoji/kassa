#!/usr/bin/env bun
/**
 * The cloudflared pane of `bun run dev:all` (turbo root task `//#dev:tunnel`). dev:all owns the tunnel and writes
 * its output to `.data/cloudflared.log`; turbo's TUI owns the terminal, so this task shows the phone URL + QR code
 * and follows that log inside the TUI. It never starts or stops cloudflared itself.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";

export const TUNNEL_LOG = join(import.meta.dir, "..", ".data", "cloudflared.log");

if (import.meta.main) {
  const url = process.env.PUBLIC_ORIGIN;
  if (!url?.startsWith("https://")) {
    console.log("No tunnel URL (PUBLIC_ORIGIN): start this through `bun run dev:all`.");
  } else {
    const named = Boolean(process.env.CLOUDFLARED_TUNNEL && process.env.PHONE_HOST);
    console.log(`Kassa on phones: ${url}  (${named ? "named" : "quick"} tunnel)\n`);
    console.log(await QRCode.toString(url, { type: "terminal", small: true }));
    if (!named) console.log("Quick tunnel: new host every run, passkeys do not survive a restart; dev sign-in is on.\n");
  }
  console.log(`--- cloudflared (${TUNNEL_LOG}) ---`);

  // Follow the log (tail -F): print what is there, then new bytes; start over if dev:all truncates it.
  let offset = 0;
  const buf = Buffer.alloc(64 * 1024);
  const poll = () => {
    if (!existsSync(TUNNEL_LOG)) return;
    const size = statSync(TUNNEL_LOG).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(TUNNEL_LOG, "r");
    try {
      let n: number;
      while ((n = readSync(fd, buf, 0, buf.length, offset)) > 0) {
        process.stdout.write(buf.subarray(0, n));
        offset += n;
      }
    } finally {
      closeSync(fd);
    }
  };
  poll();
  setInterval(poll, 500);
}
