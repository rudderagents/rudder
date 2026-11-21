# Third-party notices for the `rudder` binary

`rudder` is a single executable built with `bun build --compile`, so it contains the Bun runtime alongside the
daemon's own code (licensed under FSL-1.1-ALv2, see LICENSE in the source repository).

- **Bun** (MIT) and the libraries it links, listed in `BUN-LICENSE.md` (copied from the Bun release named in
  `BUN_VERSION`).
- **JavaScriptCore / WebKit** (LGPL-2.0, `LGPL-2.0.txt`) and **tinycc** (LGPL-2.1, `LGPL-2.1.txt`) are statically
  linked into Bun. Bun's patched WebKit source is at https://github.com/oven-sh/webkit, with relinking steps in
  `BUN-LICENSE.md`.
- To rebuild `rudder` against a modified Bun or WebKit, build from the tagged source at
  https://github.com/rudderagents/rudder (`cd daemon && bun install && RUDDER_SIGN_IDENTITY=- bun run build`).
- **uqr** (MIT), the QR code encoder used by the pairing screen.
