#!/bin/sh
# Builds the single-file `rudder` for both Mac architectures into daemon/dist/, signs each with the Developer ID
# certificate (hardened runtime, packaging/macos/rudder.entitlements), optionally notarizes them, and prints the
# SHA-256s that go into packaging/homebrew/rudder.rb. See the release section of the README and the distribution notes.
#
#   RUDDER_SIGN_IDENTITY   codesign identity, required: a "Developer ID Application: …" certificate for a
#                          release, or `-` to sign ad hoc for a local test build that is not released.
#   RUDDER_NOTARIZE=1      also submit each binary to Apple's notary service and wait for the verdict. Needs
#   RUDDER_NOTARY_KEY      path to the App Store Connect API key (.p8, never in the repo),
#   RUDDER_NOTARY_KEY_ID   its key id, and
#   RUDDER_NOTARY_ISSUER   its issuer id.
#
# A bare Mach-O cannot carry a stapled ticket, so Gatekeeper looks the notarization up online on first launch.
set -eu
cd "$(dirname "$0")/.."

identity=${RUDDER_SIGN_IDENTITY:?set RUDDER_SIGN_IDENTITY to a Developer ID Application identity, or - for a local unsigned build}
entitlements=../packaging/macos/rudder.entitlements
# Kept the same for every release: macOS privacy (TCC) grants follow the designated requirement, which is this
# identifier plus the team, so a signed upgrade keeps the owner's folder-access answers.
bundle_id=com.zysuccess.rudder

version=$(bun run src/main.ts --version | sed 's/^rudder //')
notices=../packaging/notices
# The notices name the Bun release whose license text they carry; a different Bun needs them refreshed first.
if [ "$(bun --version)" != "$(cat "$notices/BUN_VERSION")" ]; then
  echo "bun $(bun --version) differs from $notices/BUN_VERSION; refresh BUN-LICENSE.md from that Bun release" >&2
  exit 1
fi
rm -rf dist
mkdir -p dist

for arch in arm64 x64; do
  name="rudder-$version-darwin-$arch"
  mkdir -p "dist/$name"
  bun build src/main.ts --compile --target="bun-darwin-$arch" --outfile "dist/$name/rudder"
  binary="dist/$name/rudder"
  if [ "$identity" = "-" ]; then
    codesign --force --sign - --identifier "$bundle_id" "$binary"
  else
    codesign --force --options runtime --timestamp --entitlements "$entitlements" \
      --identifier "$bundle_id" --sign "$identity" "$binary"
  fi
  codesign --verify --strict --verbose=2 "$binary"
  if [ "${RUDDER_NOTARIZE:-0}" = "1" ]; then
    : "${RUDDER_NOTARY_KEY:?set RUDDER_NOTARY_KEY to the .p8 path}"
    : "${RUDDER_NOTARY_KEY_ID:?set RUDDER_NOTARY_KEY_ID}"
    : "${RUDDER_NOTARY_ISSUER:?set RUDDER_NOTARY_ISSUER}"
    # notarytool takes a zip, dmg or pkg; the zip is only the upload, the tarball below ships the same binary.
    ditto -c -k --keepParent "$binary" "dist/$name-notarize.zip"
    xcrun notarytool submit "dist/$name-notarize.zip" --key "$RUDDER_NOTARY_KEY" --key-id "$RUDDER_NOTARY_KEY_ID" \
      --issuer "$RUDDER_NOTARY_ISSUER" --wait --output-format json > "dist/$name-notary.json"
    status=$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "dist/$name-notary.json")
    echo "notary: $name $status ($(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "dist/$name-notary.json"))"
    if [ "$status" != "Accepted" ]; then
      echo "notarization of $name did not pass; see xcrun notarytool log <id> with the same key" >&2
      exit 1
    fi
    rm "dist/$name-notarize.zip"
  fi
  cp -R "$notices" "dist/$name/THIRD_PARTY_NOTICES"
  tar -czf "dist/$name.tar.gz" -C "dist/$name" rudder THIRD_PARTY_NOTICES
done

# The native one must still start under the hardened runtime.
native=$(uname -m | sed 's/x86_64/x64/')
"dist/rudder-$version-darwin-$native/rudder" --version

echo
echo "rudder $version"
ls -l dist/*/rudder dist/*.tar.gz
echo
codesign -dv "dist/rudder-$version-darwin-$native/rudder" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Runtime Version|Timestamp)='
echo
shasum -a 256 dist/*.tar.gz dist/*/rudder
