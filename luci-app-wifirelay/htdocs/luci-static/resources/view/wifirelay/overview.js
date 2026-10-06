'use strict';

'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require poll';
'require dom';

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

function securityLabel(value) {
	var labels = {
		'none': _('Open network'),
		'wep': _('WEP'),
		'psk': _('WPA-PSK'),
		'psk2': _('WPA2-PSK'),
		'psk-mixed': _('WPA-PSK/WPA2-PSK mixed'),
		'sae': _('WPA3-SAE'),
		'psk2+sae': _('WPA2-PSK/WPA3-SAE mixed'),
		'sae-mixed': _('WPA2-PSK/WPA3-SAE mixed')
	};
	return labels[value] || value || _('Unknown');
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
			E('p', _('Applying relay configuration. Watch the status above for the result.')),
			'info');
	}).catch(function() {
		ui.addNotification(null,
			E('p', _('Failed to start applying. Is the relay backend service running?')),
			'error');
	});
}

function renderStatus(box, status) {
	var states = {
		online: [ _('Online'), '#090' ],
		connecting: [ _('Connecting'), '#e80' ],
		degraded: [ _('Degraded'), '#e80' ],
		error: [ _('Failed'), '#c00' ],
		disabled: [ _('Disabled'), '#888' ],
		stopped: [ _('Stopped'), '#888' ]
	};

	var entry = states[status.state] || [ _('Unknown'), '#888' ];

	dom.content(box, [
		E('h3', {}, _('Relay status')),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:1.5em;align-items:center;padding:.25em 0;' }, [
			E('span', { 'style': 'font-weight:bold;color:%s'.format(entry[1]) }, entry[0]),
			status.uplink ? E('span', {}, '%s: %s'.format(_('Uplink'), uplinkName(status.uplink))) : E('span'),
			status.message ? E('span', { 'class': 'cbi-value-description' }, status.message) : E('span')
		]),
		E('div', { 'class': 'cbi-value-description', 'style': 'padding-bottom:.5em' },
			_('Health check: ping www.baidu.com every 30 seconds, 3 second timeout, failover after 3 consecutive failures.')),
		E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': function() { return reapplyConfiguration(); }
		}, _('Reapply configuration'))
	]);
}

function renderNetworks(networks) {
	if (!networks || !networks.length)
		return E('em', {}, _('No networks found'));

	return E('table', { 'class': 'table cbi-section-table' }, [
		E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('SSID')),
			E('th', { 'class': 'th' }, _('Band')),
			E('th', { 'class': 'th' }, _('Signal')),
			E('th', { 'class': 'th' }, _('Security')),
			E('th', { 'class': 'th' }, _('BSSID')),
			E('th', { 'class': 'th' }, _('Action'))
		]),
		networks.map(function(network) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, network.ssid || _('<hidden>')),
				E('td', { 'class': 'td' }, network.band == '5g' ? _('5 GHz') : _('2.4 GHz')),
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
						uci.set('wifirelay', 'global', 'active_uplink', section);
						ui.hideModal();
						ui.addNotification(null,
							E('p', _('Network "%s" added to the saved list. Enter its password below and use Save & Apply.').format(network.ssid || network.bssid)),
							'info');
					}
				}, _('Use')))
			]);
		})
	]);
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

		var m = new form.Map('wifirelay', _('WiFi Relay'), _('Configure cross-band WiFi relay in router mode with NAT.'));

		var s = m.section(form.NamedSection, 'global', 'relay', _('Relay settings'));
		s.anonymous = true;

		var enabled = s.option(form.Flag, 'enabled', _('Enable relay service'));
		enabled.rmempty = false;
		enabled.default = '0';

		var uplinkBand = s.option(form.ListValue, 'uplink_band', _('Uplink band'));
		uplinkBand.value('2g', _('2.4 GHz receives, 5 GHz transmits'));
		uplinkBand.value('5g', _('5 GHz receives, 2.4 GHz transmits'));
		uplinkBand.default = '5g';

		var ap = m.section(form.TypedSection, 'ap', _('Downstream AP settings'),
			_('Each band has independent SSID, password and security settings. LAN stays 192.168.1.1/24 with NAT.'));
		ap.anonymous = true;
		ap.addremove = false;
		ap.sortable = false;

		var apBand = ap.option(form.DummyValue, 'band', _('Band'));
		apBand.cfgvalue = function(section_id) {
			var band = uci.get('wifirelay', section_id, 'band');
			return band == '5g' ? _('5 GHz') : _('2.4 GHz');
		};

		var ssid = ap.option(form.Value, 'ssid', _('SSID'));
		ssid.rmempty = false;
		ssid.maxlength = 32;

		var key = ap.option(form.Value, 'key', _('Password'));
		key.password = true;
		key.rmempty = true;

		var encryption = ap.option(form.ListValue, 'encryption', _('Security'));
		encryption.value('psk2+sae', _('WPA2-PSK/WPA3-SAE Mixed Mode'));
		encryption.value('psk2', _('WPA2-PSK'));
		encryption.value('sae', _('WPA3-SAE'));
		encryption.value('psk-mixed', _('WPA-PSK/WPA2-PSK Mixed Mode'));
		encryption.value('psk', _('WPA-PSK'));
		encryption.value('none', _('Open network (no password)'));
		encryption.description = _('Choosing "Open network (no password)" hides the password field; this AP will be unencrypted.');
		key.depends('encryption', 'psk2+sae');
		key.depends('encryption', 'psk2');
		key.depends('encryption', 'sae');
		key.depends('encryption', 'psk-mixed');
		key.depends('encryption', 'psk');

		var uplink = m.section(form.TableSection, 'uplink', _('Saved upstream WiFi'),
			_('Sorted by signal strength for automatic selection. Hidden SSIDs and same-name network management are not supported; use BSSID to pin a specific AP.'));
		uplink.anonymous = true;
		uplink.addremove = true;
		uplink.sortable = false;

		var band = uplink.option(form.ListValue, 'band', _('Band'));
		band.value('2g', _('2.4 GHz'));
		band.value('5g', _('5 GHz'));

		var uplinkSsid = uplink.option(form.Value, 'ssid', _('SSID'));
		uplinkSsid.rmempty = false;

		var bssid = uplink.option(form.Value, 'bssid', _('BSSID (optional)'));
		bssid.datatype = 'macaddr';

		var uplinkEncryption = uplink.option(form.ListValue, 'encryption', _('Security'));
		uplinkEncryption.value('psk2+sae', _('WPA2-PSK/WPA3-SAE'));
		uplinkEncryption.value('psk2', _('WPA2-PSK'));
		uplinkEncryption.value('sae', _('WPA3-SAE'));
		uplinkEncryption.value('psk-mixed', _('WPA-PSK/WPA2-PSK'));
		uplinkEncryption.value('psk', _('WPA-PSK'));
		uplinkEncryption.value('none', _('Open network'));
		uplinkEncryption.description = _('For open networks no password is required.');

		var uplinkKey = uplink.option(form.Value, 'key', _('Password'));
		uplinkKey.password = true;
		uplinkKey.rmempty = true;
		uplinkKey.depends('encryption', 'psk2+sae');
		uplinkKey.depends('encryption', 'psk2');
		uplinkKey.depends('encryption', 'sae');
		uplinkKey.depends('encryption', 'psk-mixed');
		uplinkKey.depends('encryption', 'psk');

		var signal = uplink.option(form.Value, 'signal', _('Signal (dBm)'));
		signal.rmempty = true;
		signal.description = _('Updated automatically on each scan; drives the automatic ordering.');

		var uplinkEnabled = uplink.option(form.Flag, 'enabled', _('Enabled'));
		uplinkEnabled.rmempty = false;
		uplinkEnabled.default = '1';

		var activate = uplink.option(form.Button, '_activate', _('Action'));
		activate.inputtitle = _('Activate');
		activate.inputstyle = 'apply';
		activate.onclick = function(ev, section_id) {
			uci.set('wifirelay', 'global', 'active_uplink', section_id);
			uci.set('wifirelay', 'global', 'enabled', '1');
			ui.addNotification(null,
				E('p', _('Profile "%s" marked active. Use Save & Apply to connect.').format(uplinkName(section_id))),
				'info');
		};

		var scan = m.section(form.NamedSection, 'global', 'relay', _('Scan upstream WiFi'));
		scan.anonymous = true;

		[ '2g', '5g' ].forEach(function(bandName) {
			var scanButton = scan.option(form.Button, '_scan_' + bandName,
				bandName == '2g' ? _('Scan 2.4 GHz') : _('Scan 5 GHz'));
			scanButton.inputstyle = 'apply';
			scanButton.onclick = function() {
				var title = bandName == '2g' ? _('2.4 GHz scan results') : _('5 GHz scan results');

				return callScan(bandName).then(function(networks) {
					ui.showModal(title, [
						renderNetworks(networks || []),
						E('div', { 'class': 'right' }, E('button', {
							'class': 'btn',
							'click': ui.hideModal
						}, _('Close')))
					]);
				}).catch(function() {
					ui.addNotification(null,
						E('p', _('The scan failed. Make sure the wireless interfaces are up.')), 'error');
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
			return E('div', {}, [ statusBox, mapNode ]);
		});
	}
});
