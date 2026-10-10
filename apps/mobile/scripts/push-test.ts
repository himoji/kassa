#!/usr/bin/env node
/**
 * bun run push:test <ExponentPushToken[...]> ["title"] ["body"]   (npm run / pnpm run / yarn work too)
 *
 * Sends one notification through the Expo push service
 * (https://docs.expo.dev/push-notifications/sending-notifications/) to the
 * token shown on /examples/push. `data.url` deep-links back to that screen.
 * Owned by the push/expo-notifications module; runs on plain node (>=22.18 strips the
 * types), so it survives finalize and works with any package manager.
 */
const ENDPOINT = "https://exp.host/--/api/v2/push/send";

const USAGE = `Usage: bun run push:test <ExponentPushToken[...]> ["title"] ["body"] [--url /path]
`;

interface Ticket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

async function main() {
  const args = process.argv.slice(2);
  const urlFlag = args.indexOf("--url");
  const url = urlFlag >= 0 ? args.splice(urlFlag, 2)[1] : "/examples/push";
  const [token, title = "readynative", body = "Hello from push:test"] = args;

  if (!token || token === "--help") {
    console.log(USAGE);
    process.exit(token ? 0 : 1);
  }
  if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
    console.error(`Not an Expo push token: ${token}\n${USAGE}`);
    process.exit(1);
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ to: token, title, body, sound: "default", data: { url } }),
  });
  if (!res.ok) {
    console.error(`Expo push service responded ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const { data } = (await res.json()) as { data: Ticket | Ticket[] };
  const ticket = Array.isArray(data) ? data[0] : data;
  if (!ticket || ticket.status !== "ok") {
    console.error(`Push rejected: ${ticket?.message ?? "no ticket"}`);
    if (ticket?.details?.error) console.error(`  ${ticket.details.error}`);
    process.exit(1);
  }
  console.log(`Sent. Ticket ${ticket.id ?? "?"} - check the device in a few seconds.`);
  console.log(
    `Receipt: https://docs.expo.dev/push-notifications/sending-notifications/#push-receipts`
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
