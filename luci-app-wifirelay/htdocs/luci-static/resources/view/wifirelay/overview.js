'use strict';

'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require poll';
'require dom';

// UI strings are Simplified Chinese literals instead of _() lookups: the
// release pipeline ships exactly one package (no luci-i18n-* subpackage),
// so LuCI translation catalogs never reach the device.

var callStatus = rpc.declare({
	object: 'luci.wifirelay',
	method: 'status',
	expect: { '': { state: 'stopped', uplink: '', message: '' } }
});

var callScan = rpc.declare({
	object: 'luci.wifirelay',
	method: 'scan',
	params: [ 'band' ],
	expect: { networks: [] }
});

var callApply = rpc.declare({
	object: 'luci.wifirelay',
	method: 'apply',
	expect: { pending: false }
});

// Set while the form is on screen. Programmatic uci changes (scan "use",
// activate) must re-render the map: on Save & Apply every widget writes its
// DOM value, which would otherwise clobber the staged changes with the stale
// values captured at initial render time.
var redrawForm = null;

function securityLabel(value) {
	var labels = {
		'none': '开放网络',
		'wep': 'WEP',
		'psk': 'WPA-PSK',
		'psk2': 'WPA2-PSK',
		'psk-mixed': 'WPA-PSK/WPA2-PSK 混合模式',
		'sae': 'WPA3-SAE',
		'psk2+sae': 'WPA2-PSK/WPA3-SAE 混合模式',
		'sae-mixed': 'WPA2-PSK/WPA3-SAE 混合模式'
	};
	return labels[value] || value || '未知';
}

function uplinkName(sectionId) {
	if (!sectionId)
		return '';

	var ssid = uci.get('wifirelay', sectionId, 'ssid');

	return ssid || sectionId;
}

function reapplyConfiguration() {
	return callApply().then(function() {
		ui.addNotification(null,
			E('p', '正在应用中继配置，请留意上方状态查看结果。'),
			'info');
	}).catch(function() {
		ui.addNotification(null,
			E('p', '启动应用失败，请确认中继后端服务是否正在运行。'),
			'error');
	});
}

function renderStatus(box, status) {
	var states = {
		online: [ '在线', '#090' ],
		connecting: [ '连接中', '#e80' ],
		degraded: [ '已降级', '#e80' ],
		error: [ '失败', '#c00' ],
		disabled: [ '已停用', '#888' ],
		stopped: [ '已停止', '#888' ]
	};

	var entry = states[status.state] || [ '未知', '#888' ];

	dom.content(box, [
		E('h3', {}, '中继状态'),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:1.5em;align-items:center;padding:.25em 0;' }, [
			E('span', { 'style': 'font-weight:bold;color:%s'.format(entry[1]) }, entry[0]),
			status.uplink ? E('span', {}, '%s: %s'.format('上行', uplinkName(status.uplink))) : E('span'),
			status.message ? E('span', { 'class': 'cbi-value-description' }, status.message) : E('span')
		]),
		E('div', { 'class': 'cbi-value-description', 'style': 'padding-bottom:.5em' },
			'健康检查：每 30 秒 ping 一次 www.baidu.com，单次超时 3 秒，连续失败 3 次后切换。'),
		E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': function() { return reapplyConfiguration(); }
		}, '重新应用配置')
	]);
}

function renderNetworks(networks) {
	if (!networks || !networks.length)
		return E('em', {}, '未发现任何网络');

	// dom.create() does not recurse into nested child arrays: a nested array
	// would be stringified into "[object HTMLTableRowElement]" text, so the
	// row list must be flattened into the top-level children here.
	return E('table', { 'class': 'table cbi-section-table' }, [
		E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, 'SSID'),
			E('th', { 'class': 'th' }, '频段'),
			E('th', { 'class': 'th' }, '信号'),
			E('th', { 'class': 'th' }, '加密方式'),
			E('th', { 'class': 'th' }, 'BSSID'),
			E('th', { 'class': 'th' }, '操作')
		])
	].concat(networks.map(function(network) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, network.ssid || '（隐藏）'),
				E('td', { 'class': 'td' }, network.band == '5g' ? '5 GHz' : '2.4 GHz'),
				E('td', { 'class': 'td' }, (network.signal != null ? '%d dBm'.format(network.signal) : '')),
				E('td', { 'class': 'td' }, securityLabel(network.security)),
				E('td', { 'class': 'td' }, network.bssid || ''),
				E('td', { 'class': 'td' }, E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': function() {
						var section = 'uplink_' + (network.band == '5g' ? '5g' : '2g');

						if (uci.get('wifirelay', section, 'ssid'))
							section = uci.add('wifirelay', 'uplink');

						uci.set('wifirelay', section, 'band', network.band == '5g' ? '5g' : '2g');
						uci.set('wifirelay', section, 'ssid', network.ssid || '');
						uci.set('wifirelay', section, 'bssid', network.bssid || '');
						uci.set('wifirelay', section, 'encryption', network.security == 'sae-mixed' ? 'psk2+sae' : (network.security || 'none'));
						uci.set('wifirelay', section, 'signal', String(network.signal != null ? network.signal : ''));
						uci.set('wifirelay', section, 'enabled', '1');
						uci.set('wifirelay', section, 'key', '');
						uci.set('wifirelay', 'global', 'active_uplink', section);
						uci.set('wifirelay', 'global', 'enabled', '1');
						ui.hideModal();
						ui.addNotification(null,
							E('p', '网络“%s”已加入已保存列表，请在下方填写其密码并点击“保存并应用”。'.format(network.ssid || network.bssid)),
							'info');

						if (redrawForm)
							return redrawForm();
					}
				}, '使用'))
			]);
		})));
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('wifirelay'),
			// Degrade gracefully when the rpcd plugin is not loaded yet
			// (e.g. directly after installation before rpcd restarted).
			callStatus().catch(function() {
				return { state: 'stopped', uplink: '', message: '' };
			})
		]);
	},

	render: function(data) {
		var status = data[1] || {};
		var statusBox = E('div', { 'class': 'cbi-section', 'id': 'wifirelay-status' });

		renderStatus(statusBox, status);

		var m = new form.Map('wifirelay', 'WiFi 中继', '在路由模式（NAT）下配置跨频段 WiFi 中继。');

		var s = m.section(form.NamedSection, 'global', 'relay', '中继设置');
		s.anonymous = true;

		var enabled = s.option(form.Flag, 'enabled', '启用中继服务');
		enabled.rmempty = false;
		enabled.default = '0';

		var uplinkBand = s.option(form.ListValue, 'uplink_band', '上行频段');
		uplinkBand.value('2g', '2.4 GHz 接收，5 GHz 发射');
		uplinkBand.value('5g', '5 GHz 接收，2.4 GHz 发射');
		uplinkBand.default = '5g';

		var ap = m.section(form.TypedSection, 'ap', '下游 AP 设置',
			'每个频段均可独立设置 SSID、密码和加密方式。LAN 保持 192.168.1.1/24 并启用 NAT。');
		ap.anonymous = true;
		ap.addremove = false;
		ap.sortable = false;

		var apBand = ap.option(form.DummyValue, 'band', '频段');
		apBand.cfgvalue = function(section_id) {
			var band = uci.get('wifirelay', section_id, 'band');
			return band == '5g' ? '5 GHz' : '2.4 GHz';
		};

		var ssid = ap.option(form.Value, 'ssid', 'SSID');
		ssid.rmempty = false;
		ssid.maxlength = 32;

		var key = ap.option(form.Value, 'key', '密码');
		key.password = true;
		key.rmempty = true;

		var encryption = ap.option(form.ListValue, 'encryption', '加密方式');
		encryption.value('psk2+sae', 'WPA2-PSK/WPA3-SAE 混合模式');
		encryption.value('psk2', 'WPA2-PSK');
		encryption.value('sae', 'WPA3-SAE');
		encryption.value('psk-mixed', 'WPA-PSK/WPA2-PSK 混合模式');
		encryption.value('psk', 'WPA-PSK');
		encryption.value('none', '开放网络（无密码）');
		encryption.description = '选择“开放网络（无密码）”将隐藏密码输入框，该 AP 将不加密。';
		key.depends('encryption', 'psk2+sae');
		key.depends('encryption', 'psk2');
		key.depends('encryption', 'sae');
		key.depends('encryption', 'psk-mixed');
		key.depends('encryption', 'psk');

		var uplink = m.section(form.TableSection, 'uplink', '已保存的上级 WiFi',
			'按信号强度排序用于自动选择。不支持隐藏 SSID 与同名网络管理；如需固定连接指定 AP，请填写 BSSID。');
		uplink.anonymous = true;
		uplink.addremove = true;
		uplink.sortable = false;

		var band = uplink.option(form.ListValue, 'band', '频段');
		band.value('2g', '2.4 GHz');
		band.value('5g', '5 GHz');

		var uplinkSsid = uplink.option(form.Value, 'ssid', 'SSID');
		uplinkSsid.rmempty = false;

		var bssid = uplink.option(form.Value, 'bssid', 'BSSID（可选）');
		bssid.datatype = 'macaddr';

		var uplinkEncryption = uplink.option(form.ListValue, 'encryption', '加密方式');
		uplinkEncryption.value('psk2+sae', 'WPA2-PSK/WPA3-SAE');
		uplinkEncryption.value('psk2', 'WPA2-PSK');
		uplinkEncryption.value('sae', 'WPA3-SAE');
		uplinkEncryption.value('psk-mixed', 'WPA-PSK/WPA2-PSK');
		uplinkEncryption.value('psk', 'WPA-PSK');
		uplinkEncryption.value('none', '开放网络');
		uplinkEncryption.description = '开放网络无需填写密码。';

		var uplinkKey = uplink.option(form.Value, 'key', '密码');
		uplinkKey.password = true;
		uplinkKey.rmempty = true;
		uplinkKey.depends('encryption', 'psk2+sae');
		uplinkKey.depends('encryption', 'psk2');
		uplinkKey.depends('encryption', 'sae');
		uplinkKey.depends('encryption', 'psk-mixed');
		uplinkKey.depends('encryption', 'psk');

		var signal = uplink.option(form.Value, 'signal', '信号（dBm）');
		signal.rmempty = true;
		signal.description = '每次扫描后自动更新，用于决定自动选择顺序。';

		var uplinkEnabled = uplink.option(form.Flag, 'enabled', '已启用');
		uplinkEnabled.rmempty = false;
		uplinkEnabled.default = '1';

		var activate = uplink.option(form.Button, '_activate', '操作');
		activate.inputtitle = '激活';
		activate.inputstyle = 'apply';
		activate.onclick = function(ev, section_id) {
			uci.set('wifirelay', 'global', 'active_uplink', section_id);
			uci.set('wifirelay', 'global', 'enabled', '1');
			ui.addNotification(null,
				E('p', '已将配置“%s”设为当前使用，点击“保存并应用”后连接。'.format(uplinkName(section_id))),
				'info');

			if (redrawForm)
				return redrawForm();
		};

		var scan = m.section(form.NamedSection, 'global', 'relay', '扫描上级 WiFi');
		scan.anonymous = true;

		[ '2g', '5g' ].forEach(function(bandName) {
			var scanButton = scan.option(form.Button, '_scan_' + bandName,
				bandName == '2g' ? '扫描 2.4 GHz' : '扫描 5 GHz');
			scanButton.inputstyle = 'apply';
			scanButton.onclick = function() {
				var title = bandName == '2g' ? '2.4 GHz 扫描结果' : '5 GHz 扫描结果';

				return callScan(bandName).then(function(networks) {
					ui.showModal(title, [
						renderNetworks(networks || []),
						E('div', { 'class': 'right' }, E('button', {
							'class': 'btn',
							'click': ui.hideModal
						}, '关闭'))
					]);
				}).catch(function() {
					ui.addNotification(null,
						E('p', '扫描失败，请确认无线接口已启用。'), 'error');
				});
			};
		});

		m.on_after_commit = function() {
			return reapplyConfiguration();
		};

		poll.add(function() {
			return callStatus().then(function(latest) {
				renderStatus(statusBox, latest);
			}).catch(function() {
				renderStatus(statusBox, { state: 'stopped', uplink: '', message: '' });
			});
		}, 5);

		return m.render().then(function(mapNode) {
			var container = E('div', {}, [ statusBox, mapNode ]);

			redrawForm = function() {
				return m.render().then(function(newNode) {
					container.replaceChild(newNode, mapNode);
					mapNode = newNode;
				});
			};

			return container;
		});
	}
});
