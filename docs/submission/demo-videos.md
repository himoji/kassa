# Demo videos

Three screen recordings of the real web app, committed in [`docs/demo/`](https://github.com/himoji/kassa/tree/main/docs/demo) (H.264 MP4, 1280×720). Each shows the Kassa app on the left and the mock world (shops, wallet, supplier portal) on the right, with a caption strip.

| File | Length | What it shows |
| --- | --- | --- |
| [kassa-demo.mp4](https://github.com/himoji/kassa/blob/main/docs/demo/kassa-demo.mp4) | 3:28 | The two stories below, joined |
| [kassa-eu.mp4](https://github.com/himoji/kassa/blob/main/docs/demo/kassa-eu.mp4) | 1:20 | **EU, Dana in Budapest.** A café card tap logged by her iOS Shortcut, with a budget nudge; "Order me 2 pizzas" in chat: the order fits the rules she signed, so it is paid with no prompt by a one-time card and the kitchen screen follows it to delivery; at the counter she scans the till's QR code, Kassa checks the bill against her rules and the till turns PAID; the hash-chained ledger verified |
| [kassa-cn.mp4](https://github.com/himoji/kassa/blob/main/docs/demo/kassa-cn.mp4) | 2:08 | **China, Shanghai.** Li Wei pays at a pizzeria's till through a QR wallet handoff after the payee name check; the pizzeria owner's agent drafts a purchase order from a stock forecast and she signs it with her passkey; a swapped-invoice attack is refused (`INVOICE_ACCOUNT_MISMATCH`); the genuine invoice is matched against the order and the delivery and paid by verified QR |

All three are under the brief's 5-minute limit.

## How they were made

The 2026-10-12 version of `bun run demo:video` (`scripts/demo-video/record.ts`) started a fresh simulation stack, signed the personas in with software passkeys in Chromium's virtual authenticator, and drove the web app with Playwright. The planner ran from recorded replays, not a live model. Nothing in the frames is mocked up apart from the captions and title cards.

The current `bun run demo:video` records a single take of the five beats in the [demo script](./demo-script.md) into `demo-video-out/`; that take is not committed. For the live model, see the [live agent run](../evidence/live-agent.md).
