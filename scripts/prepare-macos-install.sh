#!/bin/bash

set -euo pipefail

app_path="${1:-/Applications/Todo Desk.app}"
expected_bundle_id="com.codex.todo-desk"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This command only applies to macOS." >&2
  exit 1
fi

info_plist="$app_path/Contents/Info.plist"
if [[ ! -f "$info_plist" ]]; then
  echo "Todo Desk is not installed at: $app_path" >&2
  echo "Copy the app into /Applications first, or pass its actual .app path." >&2
  exit 1
fi

# Removing quarantine bypasses a macOS trust check, so verify the bundle identity first.
# This prevents an installation agent from applying xattr to an unrelated app by mistake.
bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$info_plist")"
if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  echo "Refusing to remove quarantine from an unexpected bundle: $bundle_id" >&2
  exit 1
fi

# A signed and notarized download should keep quarantine so Gatekeeper can record its normal
# first-launch approval. The fallback below is only for the project's current unsigned releases.
if spctl --assess --type execute "$app_path" >/dev/null 2>&1; then
  echo "Gatekeeper accepts Todo Desk; quarantine was left unchanged."
  echo "Todo Desk is ready to open."
  exit 0
fi

if xattr -p com.apple.quarantine "$app_path" >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$app_path"
  echo "Removed com.apple.quarantine from: $app_path"
else
  echo "No quarantine attribute is present on: $app_path"
fi

if xattr -p com.apple.quarantine "$app_path" >/dev/null 2>&1; then
  echo "Failed to remove com.apple.quarantine from: $app_path" >&2
  exit 1
fi

echo "Todo Desk is ready to open."
