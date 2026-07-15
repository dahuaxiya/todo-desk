#!/bin/bash

set -euo pipefail

repository="dahuaxiya/todo-desk"
target_app="/Applications/Todo Desk.app"
local_dmg=""
dry_run=0
no_open=0
expected_bundle_id="com.codex.todo-desk"
work_dir=""
mount_dir=""
mounted=0
backup_app=""
installed_new_app=0
installation_succeeded=0

usage() {
  cat <<'EOF'
Install the latest Todo Desk GitHub Release on macOS without cloning the source repository.

Usage: install-macos-release.sh [options]

Options:
  --dry-run       Resolve and print the matching Release asset without downloading it.
  --dmg PATH      Install from a local DMG instead of downloading the latest Release.
  --target PATH   Override the install path. Defaults to /Applications/Todo Desk.app.
  --no-open       Install and prepare the app without launching it.
  -h, --help      Show this help.
EOF
}

fail() {
  echo "Todo Desk installation failed: $*" >&2
  exit 1
}

cleanup() {
  # If replacement succeeded but a later preparation/startup check failed, restore the previous
  # application bundle. Todo Desk user data is stored elsewhere and is never touched here.
  if [[ "$installed_new_app" -eq 1 && "$installation_succeeded" -eq 0 && \
        -n "$backup_app" && -e "$backup_app" ]]; then
    if [[ "$target_app" == "/Applications/Todo Desk.app" ]]; then
      /usr/bin/pkill -TERM -x "Todo Desk" >/dev/null 2>&1 || true
    fi
    /bin/rm -rf "$target_app"
    /bin/mv "$backup_app" "$target_app" || true
  fi
  if [[ "$mounted" -eq 1 && -n "$mount_dir" ]]; then
    /usr/bin/hdiutil detach "$mount_dir" -force >/dev/null 2>&1 || true
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    /bin/rm -rf "$work_dir"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --dmg)
      [[ $# -ge 2 ]] || fail "--dmg requires a path"
      local_dmg="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || fail "--target requires a path"
      target_app="$2"
      shift 2
      ;;
    --no-open)
      no_open=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer only supports macOS"

case "$(uname -m)" in
  arm64)
    asset_arch="arm64"
    ;;
  x86_64)
    asset_arch="x64"
    ;;
  *)
    fail "unsupported Mac architecture: $(uname -m)"
    ;;
esac

work_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/todo-desk-install.XXXXXX")"
mount_dir="$work_dir/mount"
/bin/mkdir -p "$mount_dir"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

dmg_path="$local_dmg"
if [[ -z "$dmg_path" ]]; then
  release_json="$work_dir/release.json"
  release_api="https://api.github.com/repos/$repository/releases/latest"

  echo "Resolving the latest Todo Desk $asset_arch release..."
  /usr/bin/curl --fail --location --silent --show-error \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    --header "User-Agent: Todo-Desk-Installer" \
    "$release_api" \
    --output "$release_json"

  # JXA is built into macOS. It lets the installer parse GitHub's JSON response without
  # requiring jq, Node.js, Python, Homebrew, or a source checkout on the user's machine.
  asset_info="$(/usr/bin/osascript -l JavaScript -e '
    function run(argv) {
      ObjC.import("Foundation");
      const data = $.NSData.dataWithContentsOfFile(argv[0]);
      const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
      const release = JSON.parse(text);
      const suffix = `-${argv[1]}.dmg`;
      const assets = release.assets.filter((asset) => asset.name.endsWith(suffix));
      if (assets.length !== 1) {
        throw new Error(`Expected exactly one ${suffix} asset, found ${assets.length}`);
      }
      const asset = assets[0];
      return [release.tag_name, asset.name, asset.browser_download_url, asset.digest || ""].join("\t");
    }
  ' "$release_json" "$asset_arch")"

  IFS=$'\t' read -r release_tag asset_name download_url expected_digest <<< "$asset_info"
  [[ -n "$release_tag" && -n "$asset_name" && -n "$download_url" ]] || \
    fail "GitHub returned incomplete release metadata"
  [[ "$expected_digest" == sha256:* ]] || \
    fail "GitHub did not provide a SHA-256 digest for $asset_name"

  echo "Release: $release_tag"
  echo "Asset:   $asset_name"
  if [[ "$dry_run" -eq 1 ]]; then
    echo "URL:     $download_url"
    echo "Digest:  $expected_digest"
    exit 0
  fi

  dmg_path="$work_dir/$asset_name"
  echo "Downloading $asset_name..."
  /usr/bin/curl --fail --location --show-error --progress-bar \
    "$download_url" \
    --output "$dmg_path"

  actual_digest="$(/usr/bin/shasum -a 256 "$dmg_path" | /usr/bin/awk '{print $1}')"
  if [[ "$actual_digest" != "${expected_digest#sha256:}" ]]; then
    fail "download digest does not match GitHub release metadata"
  fi
  echo "SHA-256 digest verified."
else
  [[ -f "$dmg_path" ]] || fail "local DMG does not exist: $dmg_path"
  [[ "$dry_run" -eq 0 ]] || fail "--dry-run cannot be combined with --dmg"
  echo "Using local DMG: $dmg_path"
fi

echo "Mounting the disk image..."
/usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg_path" >/dev/null
mounted=1

source_app="$(/usr/bin/find "$mount_dir" -maxdepth 2 -type d -name "Todo Desk.app" -print -quit)"
[[ -n "$source_app" ]] || fail "the DMG does not contain Todo Desk.app"

source_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$source_app/Contents/Info.plist")"
[[ "$source_bundle_id" == "$expected_bundle_id" ]] || \
  fail "unexpected app bundle identifier: $source_bundle_id"

# Stop an older process before replacing its bundle so the health check cannot accidentally
# succeed against an old version that is still listening on Todo Desk's local API port.
if [[ "$target_app" == "/Applications/Todo Desk.app" ]] && \
   /usr/bin/pgrep -x "Todo Desk" >/dev/null 2>&1; then
  echo "Stopping the running Todo Desk instance..."
  /usr/bin/pkill -TERM -x "Todo Desk" >/dev/null 2>&1 || true
  for attempt in {1..10}; do
    /usr/bin/pgrep -x "Todo Desk" >/dev/null 2>&1 || break
    /bin/sleep 1
  done
  /usr/bin/pgrep -x "Todo Desk" >/dev/null 2>&1 && \
    fail "the existing Todo Desk process did not stop"
fi

target_parent="$(/usr/bin/dirname "$target_app")"
/bin/mkdir -p "$target_parent"
if [[ -e "$target_app" ]]; then
  backup_app="$work_dir/Todo Desk.previous.app"
  /bin/mv "$target_app" "$backup_app"
fi

echo "Installing Todo Desk at $target_app..."
if ! /usr/bin/ditto "$source_app" "$target_app"; then
  /bin/rm -rf "$target_app"
  if [[ -n "$backup_app" && -e "$backup_app" ]]; then
    /bin/mv "$backup_app" "$target_app"
    backup_app=""
  fi
  fail "failed to copy the app into $target_parent"
fi
installed_new_app=1

installed_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$target_app/Contents/Info.plist")"
[[ "$installed_bundle_id" == "$expected_bundle_id" ]] || \
  fail "installed app has an unexpected bundle identifier: $installed_bundle_id"

# Signed and notarized builds keep quarantine and pass Gatekeeper normally. The xattr fallback
# exists only for current unsigned releases, where Gatekeeper reports no usable signature.
if /usr/sbin/spctl --assess --type execute "$target_app" >/dev/null 2>&1; then
  echo "Gatekeeper accepted the signed Todo Desk app."
elif /usr/bin/xattr -p com.apple.quarantine "$target_app" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$target_app"
  echo "Removed com.apple.quarantine from the current unsigned release."
else
  echo "The unsigned app has no quarantine attribute to remove."
fi

if /usr/bin/xattr -p com.apple.quarantine "$target_app" >/dev/null 2>&1 && \
   ! /usr/sbin/spctl --assess --type execute "$target_app" >/dev/null 2>&1; then
  fail "Gatekeeper rejected the app and quarantine could not be removed"
fi

if [[ "$no_open" -eq 1 ]]; then
  installation_succeeded=1
  echo "Todo Desk was installed successfully."
  exit 0
fi

echo "Opening Todo Desk..."
/usr/bin/open "$target_app"

process_ready=0
api_ready=0
for attempt in {1..30}; do
  if /usr/bin/pgrep -x "Todo Desk" >/dev/null 2>&1; then
    process_ready=1
  fi
  if /usr/bin/curl --fail --silent http://127.0.0.1:47731/health >/dev/null 2>&1; then
    api_ready=1
  fi
  [[ "$process_ready" -eq 1 && "$api_ready" -eq 1 ]] && break
  /bin/sleep 1
done

[[ "$process_ready" -eq 1 ]] || fail "Todo Desk did not start"
[[ "$api_ready" -eq 1 ]] || fail "Todo Desk opened, but its local API did not become healthy"

installation_succeeded=1
echo "Todo Desk is installed, open, and ready."
