# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Include a description, steps to reproduce and the affected version
(`rudder --version`). Do not open a public GitHub issue for security problems.

We aim to acknowledge reports within 3 business days and to keep you updated until a fix ships. Please give us
a reasonable time to release a fix before disclosing publicly.

## Scope

In scope: the `rudder` daemon and the protocol in this repository, and the release binaries published through
`rudderagents/homebrew-tap` — for example authentication bypass on the pairing or device endpoints, ways for a
network peer or the relay to read or alter session content, path traversal in the file and attachment endpoints,
or signing/notarization problems with the published binaries.

The Rudder iOS app, the relay and the push gateway are closed source; reports about them are welcome through the same
channel.

## Supported versions

Only the latest release receives security fixes. Upgrade with `brew upgrade rudder`.

## Verifying what you run

See "Verify the binary" in [README.md](README.md) for checksums, `codesign` (Team ID `RU6YBAV7ZA`) and notarization
checks, and [NETWORK.md](NETWORK.md) for every connection the daemon makes.
