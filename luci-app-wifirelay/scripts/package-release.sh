#!/bin/sh

set -eu

VERSION=${1:?OpenWrt version is required}
TAG=${2:?Release tag is required}
SDK_DIR=${3:?SDK directory is required}
ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT_DIR=${4:-"$ROOT_DIR/dist/$VERSION"}

case "$VERSION" in
	24.10)
		SDK_URL=https://downloads.openwrt.org/releases/24.10.0/targets/mediatek/filogic/openwrt-sdk-24.10.0-mediatek-filogic_gcc-13.3.0_musl.Linux-x86_64.tar.zst
		FORMAT=ipk
		;;
	25.12)
		SDK_URL=https://downloads.openwrt.org/releases/25.12.0/targets/mediatek/filogic/openwrt-sdk-25.12.0-mediatek-filogic_gcc-14.3.0_musl.Linux-x86_64.tar.zst
		FORMAT=apk
		;;
	*) echo "Unsupported OpenWrt version: $VERSION" >&2; exit 2 ;;
esac

# The release version is the user-provided tag with only a leading v or V
# removed.
case "$TAG" in
	[vV]*) ver=${TAG#?} ;;
	*) ver=$TAG ;;
esac
printf '%s' "$ver" | grep -qE '^[0-9]+(\.[0-9]+)+$' || {
	echo "Invalid release tag: $TAG (expected v<version>, e.g. v2.0.01)" >&2
	exit 2
}

# Tags carrying an explicit release component split into PKG_VERSION and
# PKG_RELEASE: when the last dotted field of the version starts with 0 and has
# more digits (e.g. the "01" in 2.0.01), it is the release, so v2.0.01 becomes
# PKG_VERSION=2.0 PKG_RELEASE=1. Any other tag keeps the full version with
# PKG_RELEASE=1.
pkg_version=$ver
pkg_release=1
last=$(printf '%s' "$ver" | awk -F. '{print $NF}')
prefix=$(printf '%s' "$ver" | sed -E 's/\.[0-9]+$//')
case "$last" in
	0[0-9]*)
		rel=$(printf '%s' "$last" | sed 's/^0*//')
		[ -n "$rel" ] || rel=1
		pkg_version=$prefix
		pkg_release=$rel
		;;
esac

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

rm -rf "$SDK_DIR/package/luci-app-wifirelay"
cp -R "$ROOT_DIR" "$SDK_DIR/package/luci-app-wifirelay"
rm -rf "$SDK_DIR/package/luci-app-wifirelay/.git" "$SDK_DIR/package/luci-app-wifirelay/dist"

# The source tree may be checked out with CRLF line endings; a CR inside the
# Makefile would end up in the package version or break make. Normalize every
# text file to LF before make reads anything.
grep -rIl "$(printf '\r')" "$SDK_DIR/package/luci-app-wifirelay" 2>/dev/null \
	| xargs -r sed -i 's/\r$//'

# Stamp the user-provided tag into the package version, splitting PKG_VERSION
# and PKG_RELEASE for explicit-release tags.
sed -i "s/^PKG_VERSION?=.*/PKG_VERSION?=$pkg_version/" "$SDK_DIR/package/luci-app-wifirelay/Makefile"
sed -i "s/^PKG_RELEASE:=.*/PKG_RELEASE:=$pkg_release/" "$SDK_DIR/package/luci-app-wifirelay/Makefile"

# A freshly unpacked SDK can lack .config. Initialize it before sed modifies
# package selections; the second defconfig below resolves the final package
# dependency closure after the plugin is present.
[ -f "$SDK_DIR/.config" ] || make -C "$SDK_DIR" defconfig

# Select only the packages the plugin needs at build time. Remove an existing
# assignment first because SDK defaults may already select a large set of
# target-specific kernel modules.
sed -i '/^CONFIG_PACKAGE_[^=]*=/ s/=.*$/=n/' "$SDK_DIR/.config"

set_config() {
	symbol=$1
	value=$2
	sed -i "/^${symbol}=/d" "$SDK_DIR/.config"
	printf '%s=%s\n' "$symbol" "$value" >> "$SDK_DIR/.config"
}

set_config CONFIG_PACKAGE_luci y
set_config CONFIG_PACKAGE_luci-base y
set_config CONFIG_PACKAGE_rpcd y
set_config CONFIG_PACKAGE_rpcd-mod-ucode y
# Build-time-only selections, not runtime deps of the plugin: the luci
# metapackage pulls uhttpd, whose PKG_BUILD_DEPENDS:=ustream-ssl builds the
# default libustream-mbedtls variant. Its mbedtls dependency is conditional
# (+PACKAGE_libustream-mbedtls:libmbedtls), so unless libustream-mbedtls is
# selected here nothing stages libmbedtls and the variant fails at the CMake
# generate step.
set_config CONFIG_PACKAGE_libustream-mbedtls y
set_config CONFIG_PACKAGE_libmbedtls y
set_config CONFIG_PACKAGE_ucode y
set_config CONFIG_PACKAGE_libucode y
set_config CONFIG_PACKAGE_luci-app-wifirelay y
set_config CONFIG_BUILD_LOG y

make -C "$SDK_DIR" defconfig

# The compile target only exists when the scan indexed the package and the
# config selected it; a missing index entry surfaces later as an opaque
# "No rule to make target", so fail here with the actual reason.
grep -q '^Package: luci-app-wifirelay$' "$SDK_DIR/tmp/.packageinfo" || {
	echo 'luci-app-wifirelay is missing from the package index (scan failed)' >&2
	grep -n 'luci-app-wifirelay' "$SDK_DIR/tmp/.packageinfo" 2>/dev/null || true
	exit 1
}
grep -q '^CONFIG_PACKAGE_luci-app-wifirelay=y' "$SDK_DIR/.config" || {
	echo 'CONFIG_PACKAGE_luci-app-wifirelay is not selected in .config' >&2
	grep -n 'luci-app-wifirelay' "$SDK_DIR/.config" 2>/dev/null || true
	exit 1
}

# lucihttp builds a ucode module and includes ucode/module.h while compiling.
# In an SDK-only, package-scoped build the runtime dependency can be selected
# without running ucode's Build/InstallDev step first, so stage ucode
# explicitly before entering the LuCI dependency graph. ucode comes from the
# base feed, so its build target lives under package/feeds/base.
make -C "$SDK_DIR" -j1 package/feeds/base/ucode/compile V=sc

ucode_header=$(find "$SDK_DIR/staging_dir" -type f \
	-path '*/usr/include/ucode/module.h' -print -quit)
[ -n "$ucode_header" ] || {
	echo 'ucode development header was not staged: usr/include/ucode/module.h' >&2
	exit 1
}

# Build only the application and its recursive dependency closure. A
# single-job build keeps the first failing package's compiler output ordered,
# while V=sc includes commands that OpenWrt otherwise hides behind a summary.
if ! make -C "$SDK_DIR" -j1 package/luci-app-wifirelay/compile V=sc; then
	echo 'Package build failed; available OpenWrt package logs:' >&2
	if [ -d "$SDK_DIR/logs" ]; then
		find "$SDK_DIR/logs" -type f -print >&2
		for log in $(find "$SDK_DIR/logs" -type f \( -iname '*lucihttp*' -o -iname '*wifirelay*' \)); do
			echo "--- $log ---" >&2
			tail -n 300 "$log" >&2
		done
	fi
	exit 1
fi

PACKAGE_DIRS="$SDK_DIR/bin/packages
$SDK_DIR/bin/targets/mediatek/filogic/packages"

# The release must carry exactly one plugin package in the target format; the
# release workflow renames it to the published file name convention.
set -- $(find $PACKAGE_DIRS -type f \( -name "luci-app-wifirelay_*.${FORMAT}" -o -name "luci-app-wifirelay-*.${FORMAT}" \) 2>/dev/null)
[ $# -eq 1 ] || {
	echo "Expected exactly one built plugin package, found: ${*:-none}" >&2
	exit 1
}
cp "$1" "$OUT_DIR/"
echo "$OUT_DIR/$(basename "$1")"
