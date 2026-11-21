#!/bin/sh
# Cross-compiles the single-file `rudder.exe` for Windows x64 and arm64 into daemon/dist/, zips each, and prints the
# SHA-256s that go into packaging/windows/ (Scoop `hash`, winget `InstallerSha256`). See the Windows notes.
#
# The binaries are NOT code-signed: Authenticode signing needs the owner's certificate decision and
# runs on Windows (signtool) or through Azure Trusted Signing. Product name, version resource and icon
# (--windows-title / --windows-icon …) can only be set by bun when it compiles on Windows; this macOS cross-build has none.
set -eu
cd "$(dirname "$0")/.."

version=$(bun run src/main.ts --version | sed 's/^rudder //')
mkdir -p dist

for arch in x64 arm64; do
  name="rudder-$version-windows-$arch"
  rm -rf "dist/$name" "dist/$name.zip"
  mkdir -p "dist/$name"
  bun build src/main.ts --compile --target="bun-windows-$arch" --outfile "dist/$name/rudder.exe"
  cp -R ../packaging/notices "dist/$name/THIRD_PARTY_NOTICES"
  (cd "dist/$name" && zip -q -X -r "../$name.zip" rudder.exe THIRD_PARTY_NOTICES)
done

echo
echo "rudder $version (unsigned)"
ls -l dist/rudder-"$version"-windows-*/rudder.exe dist/rudder-"$version"-windows-*.zip
echo
shasum -a 256 dist/rudder-"$version"-windows-*.zip dist/rudder-"$version"-windows-*/rudder.exe
