'use strict';

const http = require('http');
const UndokDriver = require('../undok-radio/driver');

class ManualDriver extends UndokDriver {

  _registerFlowCards() {
    this._triggerVolumeChanged = this.homey.flow.getDeviceTriggerCard('volume_changed_manual');
    this._triggerPresetChanged = this.homey.flow.getDeviceTriggerCard('preset_changed_manual');
    this._triggerNowPlayingChanged = this.homey.flow.getDeviceTriggerCard('now_playing_changed_manual');

    this.homey.flow.getConditionCard('preset_condition_manual')
      .registerRunListener(async ({ device, preset }) => device.getCurrentPreset() === preset);

    this.homey.flow.getConditionCard('volume_condition_manual')
      .registerRunListener(async ({ device, operator, volume }) => {
        const current = device.getCurrentVolume();
        if (operator === 'eq') return current === volume;
        if (operator === 'gt') return current > volume;
        if (operator === 'lt') return current < volume;
        return false;
      });

    this.homey.flow.getConditionCard('is_playing_manual')
      .registerRunListener(async ({ device }) => device.isPlaying());

    this.homey.flow.getConditionCard('is_muted_manual')
      .registerRunListener(async ({ device }) => device.isMuted());

    const sourcesAutocomplete = async (query, { device }) => {
      const modeMap = device.getStoreValue('modeMap') || {};
      return Object.entries(modeMap)
        .filter(([_, label]) => !query || label.toLowerCase().includes(query.toLowerCase()))
        .map(([id, label]) => ({ id, name: label }));
    };

    const selectSourceCard = this.homey.flow.getActionCard('select_source_manual');
    selectSourceCard.getArgument('source').registerAutocompleteListener(sourcesAutocomplete);
    selectSourceCard.registerRunListener(async ({ device, source }) =>
      device.setSource(parseInt(source.id, 10)));

    this.homey.flow.getActionCard('select_preset_manual')
      .registerRunListener(async ({ device, preset }) => {
        if (device.getCurrentPreset() === preset) return;
        return device.setPreset(preset);
      });

    const turnOnFullCard = this.homey.flow.getActionCard('turn_on_full_manual');
    turnOnFullCard.getArgument('source').registerAutocompleteListener(sourcesAutocomplete);
    turnOnFullCard.registerRunListener(async ({ device, source, preset, volume }) =>
      device.turnOnFull(parseInt(source.id, 10), preset, volume));
  }

  async onPair(session) {
    session.setHandler('pair_radio', async ({ ip, pin }) => {
      try {
        const sessionXml = await httpGet(
          `http://${ip}/fsapi/CREATE_SESSION?pin=${encodeURIComponent(pin)}`
        );
        if (!sessionXml.includes('FS_OK')) {
          const status = parseXml(sessionXml, 'status');
          return {
            error: status === 'FS_FAIL'
              ? 'Wrong PIN or radio not ready.'
              : `Radio refused: ${status || 'unknown'}`,
          };
        }
        const sid = parseXml(sessionXml, 'sessionId') || '';

        const nameXml = await httpGet(
          `http://${ip}/fsapi/GET/netRemote.sys.info.friendlyName?pin=${encodeURIComponent(pin)}&sid=${sid}`
        );
        const name = parseXml(nameXml, 'c8_array') || parseXml(nameXml, 'value') || 'UNDOK Radio';

        let volumeSteps = 32;
        try {
          const vsXml = await httpGet(
            `http://${ip}/fsapi/GET/netRemote.sys.caps.volumeSteps?pin=${encodeURIComponent(pin)}&sid=${sid}`
          );
          const vs = parseInt(parseXml(vsXml, 'u8') || parseXml(vsXml, 'value') || '', 10);
          if (!isNaN(vs)) volumeSteps = vs;
        } catch (_) { /* use default 32 */ }

        return { name, volumeSteps };
      } catch (err) {
        return { error: err.message || 'Could not connect to radio.' };
      }
    });
  }

}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 6000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out.')); });
  });
}

function parseXml(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

module.exports = ManualDriver;
