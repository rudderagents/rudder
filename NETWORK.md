# Network connections made by `rudder`

This is the complete list of network traffic the daemon itself starts, taken from the source. Every outbound host
is defined in one of two files: [`daemon/src/config.ts`](daemon/src/config.ts) and
[`daemon/src/update-check.ts`](daemon/src/update-check.ts). If you find a connection that is not listed here,
please report it (see [SECURITY.md](SECURITY.md)).

The agent CLIs that Rudder starts for you (Claude Code, Codex, Copilot, …) make their own connections to their
vendors; those are governed by those tools, not by this list.

## Inbound

| Listener | Default | Who connects | Notes |
|---|---|---|---|
| HTTPS / WSS `0.0.0.0:7749` | on | your paired phone over LAN or Tailscale | Self-signed certificate generated on first start; the app pins its fingerprint from the pairing QR code. Only `POST /v1/pair` (with a single-use token) is unauthenticated; everything else needs a paired device key. Port: `RUDDER_PORT`; address: `RUDDER_HOST`. |
| Unix socket `RUDDER_HOME/rudder.sock` | on | `rudder pair` / `rudder devices` on the same machine | Owner-only file permissions; never exposed over TCP. |

`rudder install` and `rudder status` also call the daemon's own `/health` on this machine to confirm it started.

## Outbound

| # | Destination | Purpose | When | What is sent | Turn off |
|---|---|---|---|---|---|
| 1 | `wss://relay.rudderagents.com` (default relay), then the relays returned by #2 | Lets your phone reach this computer when it is not on the same network | At start and kept open, when the relay is on (default) | A WebSocket to `/v1/daemon?slot=<slot id>`, authenticated with this computer's Ed25519 relay key (public key, timestamp, signature). All app traffic inside it is end-to-end encrypted with Noise (`NNpsk0`) between phone and computer; the relay sees only the slot id, connection ids, frame sizes and timing, never plaintext. | `rudder relay off` or `RUDDER_RELAY=off`. `RUDDER_RELAY=wss://your-relay` uses only the relays you list. |
| 2 | `https://api.rudderagents.com/v1/relays?scope=computer` | Fetches the list of relay endpoints (regions) | At start and when the list's TTL expires (retry hourly on failure), only when the relay is on and `RUDDER_RELAY` names no relay of its own | A plain `GET` with `accept: application/json`. No identifiers. The answer is cached in `RUDDER_HOME/relays.json`. | as #1 |
| 3 | `https://api.rudderagents.com/v1/blob/<id>` | Large file transfer between phone and computer ("blob lane") | Only when the phone asks to receive a file from the computer or send an attachment to it | `PUT` / `GET` of the file **encrypted with AES-256-GCM under a key only the phone and computer hold**, with a one-time bearer token the phone obtained. The server stores ciphertext only. | `RUDDER_BLOB_API=<your server>` overrides the base. Not used unless the phone requests it. |
| 4 | `https://push.rudderagents.com/v1/push` | Lock-screen notifications and Live Activity updates on the phone (via Apple Push Notification service) | When a session needs your approval or an answer, finishes, fails or resumes, and a paired phone registered for notifications | A gateway *ticket* for that phone (not the raw APNs token), a collapse id, and the notification **sealed with AES-256-GCM** under the phone's session key. For Live Activities, every word on the card (titles, prompts, tool names, results, machine name) is sealed the same way; only enum words and numbers (phase, counters, timestamps, a fixed set of alert strings) are visible to the gateway and to Apple. | `RUDDER_PUSH_GATEWAY=off`, or turn notifications off in the app. |
| 5 | `https://raw.githubusercontent.com/rudderagents/homebrew-tap/main/Formula/rudder.rb` | "A newer version is available" notice | At most once per day, **only when this binary was installed with Homebrew** | A plain `GET` with user agent `rudderd update check`, 3-second timeout. Reads the formula's `version` line. A 404, timeout or malformed answer counts as "no update" and is silent; the answer is cached in `RUDDER_HOME/update-check.json`. | `RUDDER_UPDATE_CHECK=off` |
| 6 | `https://rudderagents.com/windows/latest.json` | Same as #5 for Windows builds | Windows only (not released for 1.0) | A plain `GET`; reads `{"version": …}`. | `RUDDER_UPDATE_CHECK=off` |
| 7 | DNS `100.100.100.100` (Tailscale MagicDNS) | Find this computer's `*.ts.net` name so the phone can use your tailnet | Only when the computer has a Tailscale address; 1-second timeout | A reverse (PTR) lookup of this computer's own tailnet IP. The query stays inside Tailscale. | Not needed if you do not use Tailscale (no Tailscale address → no query). |
| 8 | npm registry (via `npx -y pi-acp@0.0.34`) | Starts the `pi` agent's ACP bridge | Only when you start a session with the `pi` agent | Whatever `npx` sends to download that pinned package. | Do not use the `pi` agent. |

## What never leaves your computer

- Your code, files and agent transcripts, except: what the phone asks to see (sent over the direct connection or
  end-to-end encrypted through the relay), and files the phone explicitly asks for (encrypted, #3).
- The pairing token (only shown in your terminal and the QR code), device keys, and the TLS private key.
- No analytics, telemetry or crash reporting is sent by the daemon.


