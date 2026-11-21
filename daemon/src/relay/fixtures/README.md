# Relay test fixtures

`pass-vector.json` is a shared, test-only Ed25519 vector (including a private key) used to pin signature bytes across rudderd, the relay Worker, and relay-node. It is not referenced by any production config or runtime path. Secret scanners should allowlist this file.

`verify-pass.ts` and `bytes.ts` are copies of `relay/src/pass.ts` and `relay/src/bytes.ts` so the daemon suite can check a pass when the monorepo `relay/` tree is not present (the public `rudderagents/rudder` repo is daemon-only). A monorepo parity test compares `verify-pass.ts` to `relay/src/pass.ts` when `relay/` exists.
