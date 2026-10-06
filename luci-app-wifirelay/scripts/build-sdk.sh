#!/bin/sh

set -eu

VERSION=${1:?OpenWrt version is required}
TAG=${2:?Release tag is required}
WORK=${3:?Working directory is required}
ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SDK_ARCHIVE="$WORK/sdk-$VERSION.tar.zst"
SDK_DIR="$WORK/sdk-$VERSION"

case "$VERSION" in
	24.10) SDK_URL=https://downloads.openwrt.org/releases/24.10.0/targets/mediatek/filogic/openwrt-sdk-24.10.0-mediatek-filogic_gcc-13.3.0_musl.Linux-x86_64.tar.zst ;;
	25.12) SDK_URL=https://downloads.openwrt.org/releases/25.12.0/targets/mediatek/filogic/openwrt-sdk-25.12.0-mediatek-filogic_gcc-14.3.0_musl.Linux-x86_64.tar.zst ;;
	*) echo "Unsupported OpenWrt version: $VERSION" >&2; exit 2 ;;
esac

LUCI_BRANCH="openwrt-$VERSION"

mkdir -p "$WORK"
curl -fsSL "$SDK_URL" -o "$SDK_ARCHIVE"
mkdir -p "$SDK_DIR"
tar --zstd -xf "$SDK_ARCHIVE" --strip-components=1 -C "$SDK_DIR"

# Release SDKs ship a 'base' feed in feeds.conf.default that provides the core
# packages (rpcd, iwinfo, ucode, ...); it clones the matching OpenWrt source
# tree and must be kept exactly as shipped - both release branches already
# declare it, and adding a second 'base' entry makes scripts/feeds abort with
# "Duplicate feed name". Pin only the LuCI feed to the matching release
# branch: its default branch can require a newer SDK API.
# A clean SDK may not have a .config yet, so create the baseline target
# configuration before package-release.sh edits package selections.
(cd "$SDK_DIR" && {
		# A release SDK normally has feeds.conf.default but no feeds.conf yet.
		# scripts/feeds accepts either file, so update the one that exists.
		feed_config=feeds.conf
		[ -f "$feed_config" ] || feed_config=feeds.conf.default
		[ -f "$feed_config" ] || {
			echo "LuCI feed configuration not found in $SDK_DIR" >&2
			exit 1
		}
		if grep -qE '^src-git(-full)? luci ' "$feed_config"; then
			sed -i -E "/^src-git(-full)? luci /c\\src-git luci https://git.openwrt.org/project/luci.git;$LUCI_BRANCH" "$feed_config"
		else
			printf '\nsrc-git luci https://git.openwrt.org/project/luci.git;%s\n' "$LUCI_BRANCH" >> "$feed_config"
		fi
		# Updating the base feed clones the OpenWrt source tree, so this step
		# takes a while; installing both feeds afterwards makes every core and
		# LuCI dependency resolvable to make.
		./scripts/feeds update base luci
		./scripts/feeds install -p base -a
		./scripts/feeds install -p luci luci
		for package in rpcd iwinfo ucode libucode; do
			[ -e "package/feeds/base/$package" ] || {
				echo "Core package '$package' is not available from the base feed" >&2
				exit 1
			}
		done
	})
make -C "$SDK_DIR" defconfig

# The package is copied into the SDK and compiled by package-release.sh. Do
# not use the aggregate package/compile target here: an SDK can have many
# default kernel modules selected, which needlessly builds the entire target
# package set and can hide the actual application result in CI logs.
sh "$ROOT_DIR/scripts/package-release.sh" "$VERSION" "$TAG" "$SDK_DIR" "$WORK/dist/$VERSION"
