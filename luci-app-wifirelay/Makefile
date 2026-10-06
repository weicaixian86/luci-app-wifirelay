include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifirelay
PKG_VERSION?=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=WiFi Relay LuCI application
# Only packages present in the Q30 Pro firmware's apk repository may be hard
# dependencies: iwinfo and wpad-basic-mbedtls have no such packages there (the
# firmware image ships its own mtwifi userland), and apk refuses to install
# the app if they are listed. Per the requirements, runtime dependencies come
# from the preinstalled device environment; the scan falls back gracefully
# when /usr/bin/iwinfo is absent.
LUCI_DEPENDS:=+luci +rpcd +rpcd-mod-ucode
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
