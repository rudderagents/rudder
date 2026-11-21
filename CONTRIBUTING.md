# Contributing to Rudder

Thanks for helping. This repository holds the `rudder` daemon/CLI and the `RudderProtocol` Swift package.

## How changes land

Until version 1.1 this repository is the published copy of each release: every release is one commit and one tag
(`v1.0.0`, `v1.0.1`, …), exported from the tree the release binaries are built from.

Pull requests are welcome and reviewed here. An accepted pull request is applied upstream with you as its author and
ships in the next release; we then close the pull request with a link to that release instead of merging it on
GitHub. From 1.1 this repository becomes the primary home of the code and pull requests are merged here directly.

## Before you open a PR

- Run `cd daemon && bun install && bun run check` and `swift test --package-path protocol/swift`.
- Keep changes focused; one topic per PR.
- Do not commit credentials, tokens, recorded sessions containing personal data, or machine-specific paths.
  CI runs a secret scan on every PR.
- New network endpoints must be documented in `NETWORK.md`.

## License of contributions

Sign off every commit (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
By contributing you license your contribution to the project under the Apache License 2.0, so it can be
distributed under this repository's license (FSL-1.1-ALv2, which converts to Apache-2.0 two years after each release).
Commits without a sign-off cannot be accepted.

## Security issues

Please do not open public issues for vulnerabilities. See `SECURITY.md`.
