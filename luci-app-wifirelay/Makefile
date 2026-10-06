include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifirelay
PKG_VERSION?=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=WiFi Relay LuCI application
LUCI_DEPENDS:=+luci +rpcd +rpcd-mod-ucode +iwinfo +wpad-basic-mbedtls
LUCI_PKGARCH:=all

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/luci/luci.mk
