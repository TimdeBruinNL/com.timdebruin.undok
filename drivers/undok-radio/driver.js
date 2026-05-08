'use strict';

const { Driver } = require('homey');
const { discover } = require('../../lib/SsdpDiscovery');
const { FsApi } = require('../../lib/FsApi');

class UndokDriver extends Driver {

  async onInit() {
    this.log('UndokDriver initialised');
    this._registerFlowCards();
  }

  async onPairListDevices() {
    this.log('Starting SSDP discovery for pairing...');
    const found = await discover(5000);
    this.log(`Found ${found.length} device(s)`);

    const devices = [];
    for (const d of found) {
      const api = new FsApi(d.ip, '1234');

      let volumeSteps = 32;
      try {
        const steps = await api.get('netRemote.sys.caps.volumeSteps');
        if (steps) volumeSteps = parseInt(steps, 10);
      } catch (err) {
        this.error(`Could not query volumeSteps for ${d.ip}: ${err.message}`);
      }

      let modeMap = {};
      try {
        modeMap = await api.listGetAll('netRemote.sys.caps.validModes');
        this.log(`Mode map for ${d.ip}: ${JSON.stringify(modeMap)}`);
      } catch (err) {
        this.error(`Could not query mode map for ${d.ip}: ${err.message}`);
      }

      // Always query FSAPI for the friendly name — the SSDP name can be a raw
      // placeholder from the device description XML (e.g. "frname").
      // Fall back to the SSDP name if usable, then to a generic label.
      // Only append the IP address when falling back; FSAPI names are shown as-is.
      let friendlyName = null;
      let fsapiNameOk = false;
      try {
        const fsName = await api.get('netRemote.sys.info.friendlyName');
        if (fsName) { friendlyName = fsName; fsapiNameOk = true; }
      } catch (err) {
        this.error(`Could not query friendly name for ${d.ip}: ${err.message}`);
      }
      if (!friendlyName && d.friendlyName && d.friendlyName !== `Radio (${d.ip})`) {
        friendlyName = d.friendlyName;
      }
      if (!friendlyName) friendlyName = 'UNDOK Radio';

      devices.push({
        name: fsapiNameOk ? friendlyName : `${friendlyName} (${d.ip})`,
        data: { id: d.udn },
        store: { volumeSteps, ip: d.ip, modeMap, friendlyName },
        settings: { pin: '1234' },
      });
    }

    return devices;
  }

  _registerFlowCards() {
    // ── Triggers ─────────────────────────────────────────────────────────────
    this._triggerVolumeChanged = this.homey.flow.getDeviceTriggerCard('volume_changed');
    this._triggerPresetChanged = this.homey.flow.getDeviceTriggerCard('preset_changed');

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('preset_condition')
      .registerRunListener(async ({ device, preset }) => device.getCurrentPreset() === preset);

    this.homey.flow.getConditionCard('volume_condition')
      .registerRunListener(async ({ device, operator, volume }) => {
        const current = device.getCurrentVolume();
        if (operator === 'eq') return current === volume;
        if (operator === 'gt') return current > volume;
        if (operator === 'lt') return current < volume;
        return false;
      });

    this.homey.flow.getConditionCard('is_muted')
      .registerRunListener(async ({ device }) => device.isMuted());

    // ── Actions ───────────────────────────────────────────────────────────────

    // Shared autocomplete handler: returns selectable modes from device's stored mode map
    const sourcesAutocomplete = async (query, { device }) => {
      const modeMap = device.getStoreValue('modeMap') || {};
      return Object.entries(modeMap)
        .filter(([_, label]) => !query || label.toLowerCase().includes(query.toLowerCase()))
        .map(([id, label]) => ({ id, name: label }));
    };

    const selectSourceCard = this.homey.flow.getActionCard('select_source');
    selectSourceCard.getArgument('source').registerAutocompleteListener(sourcesAutocomplete);
    selectSourceCard.registerRunListener(async ({ device, source }) =>
      device.setSource(parseInt(source.id, 10)));

    this.homey.flow.getActionCard('select_preset')
      .registerRunListener(async ({ device, preset }) => {
        if (device.getCurrentPreset() === preset) return;
        return device.setPreset(preset);
      });

    const turnOnFullCard = this.homey.flow.getActionCard('turn_on_full');
    turnOnFullCard.getArgument('source').registerAutocompleteListener(sourcesAutocomplete);
    turnOnFullCard.registerRunListener(async ({ device, source, preset, volume }) =>
      device.turnOnFull(parseInt(source.id, 10), preset, volume));
  }

  triggerVolumeChanged(device, volume) { return this._triggerVolumeChanged.trigger(device, { volume }, {}); }
  triggerPresetChanged(device, preset) { return this._triggerPresetChanged.trigger(device, { preset }, {}); }
}

module.exports = UndokDriver;
