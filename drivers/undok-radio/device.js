'use strict';

const { Device } = require('homey');
const { discover } = require('../../lib/SsdpDiscovery');
const { FsApi, FSAPI_STATUS, PLAY_CONTROL } = require('../../lib/FsApi');

const DEFAULT_POLL_INTERVAL_S = 10;
const MAX_CONSECUTIVE_FAILURES = 10;
const STARTUP_SUSPEND_MS = 30000;

// Number of consecutive poll cycles where BOTH power=0 AND playStatus=0 before
// setting onoff to false. Prevents false-off from transient power=0 readings.
const POWER_OFF_THRESHOLD = 6;

class UndokDevice extends Device {

  async onAdded() {
    const friendlyName = this.getStoreValue('friendlyName');
    if (friendlyName) await this.setName(friendlyName);
  }

  async onInit() {
    this.log(`UndokDevice ${this.getName()} initialised`);

    this._api = null;
    this._currentPreset = 1;
    this._currentVolume = 0;
    this._currentMode = 0;
    this._pollTimer = null;
    this._lastKnownIp = null;
    this._consecutiveFailures = 0;
    this._consecutivePowerOff = 0;
    this._startupActive = false;
    this._startupInProgress = false;
    this._startupTimer = null;
    this._rediscovering = false;
    this._isMuted = false;
    this._mutedViaNode = false;
    this._volumeBeforeMute = 0;
    this._currentStation = '';
    this._currentArtist = '';
    this._currentSong = '';
    this._radioIsOff = false;
    this._pollActive = false;

    // Remove capabilities that were renamed or removed in this version
    for (const cap of ['speaker_artist', 'speaker_track', 'source']) {
      if (this.hasCapability(cap)) await this.removeCapability(cap);
    }
    // Ensure all current capabilities are present (handles upgrades from older versions)
    for (const cap of ['input_source', 'volume_set', 'station_name', 'song', 'now_playing',
      'volume_mute', 'speaker_prev', 'speaker_playing', 'speaker_next']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }

    await this._initApi();
    await this._initInputSourceOptions();

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('input_source', this.onCapabilityInputSource.bind(this));
    this.registerCapabilityListener('volume_set', this.onCapabilityVolumeSet.bind(this));
    this.registerCapabilityListener('volume_up', this.onCapabilityVolumeUp.bind(this));
    this.registerCapabilityListener('volume_down', this.onCapabilityVolumeDown.bind(this));
    this.registerCapabilityListener('volume_mute', this.onCapabilityVolumeMute.bind(this));
    this.registerCapabilityListener('speaker_playing', this.onCapabilitySpeakerPlaying.bind(this));
    this.registerCapabilityListener('speaker_prev', async () => this.playControl(PLAY_CONTROL.PREVIOUS));
    this.registerCapabilityListener('speaker_next', async () => this.playControl(PLAY_CONTROL.NEXT));

    this._startPolling();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('pin') && this._api) {
      this._api.pin = newSettings.pin;
    }
    if (changedKeys.includes('poll_interval')) {
      this._startPolling();
    }
  }

  onDeleted() {
    this._stopPolling();
    this._cancelStartupTimer();
  }

  // ── Startup suspension ────────────────────────────────────────────────────

  _beginStartup() {
    this._consecutivePowerOff = 0;
    this._startupActive = true;
    this._cancelStartupTimer();
    this._startupTimer = setTimeout(() => this._endStartup(), STARTUP_SUSPEND_MS);
  }

  _endStartup() {
    if (!this._startupActive) return;
    this._cancelStartupTimer();
    this._startupActive = false;
    this._consecutivePowerOff = 0;
  }

  _cancelStartupTimer() {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
  }

  // ── API null guard ────────────────────────────────────────────────────────

  _ensureApi() {
    if (!this._api) throw new Error('Device not reachable');
  }

  // ── Capability handlers ──────────────────────────────────────────────────

  async onCapabilityOnoff(value) {
    this._ensureApi();
    await this._api.set('netRemote.sys.power', value ? 1 : 0);
    if (value) {
      this._consecutivePowerOff = 0;
      if (this._radioIsOff) {
        this._radioIsOff = false;
        this._startPolling();
      }
      this._beginStartup();
    } else {
      if (this._startupActive) this._endStartup();
    }
  }

  async onCapabilityVolumeSet(value) {
    this._ensureApi();
    const max = this._volumeMax();
    const intVal = Math.max(0, Math.min(Math.round(value * max), max));
    const confirmed = await this._api.setVolume(intVal, max);
    if (confirmed !== null) {
      this._currentVolume = confirmed;
      // Do not call _syncVolumeCapability here — Homey already moved the slider
    }
  }

  async onCapabilityVolumeUp() {
    this._ensureApi();
    const confirmed = await this._api.adjustVolume(+1, this._volumeMax());
    if (confirmed !== null) {
      this._currentVolume = confirmed;
      await this._syncVolumeCapability(confirmed);
    }
  }

  async onCapabilityVolumeDown() {
    this._ensureApi();
    const confirmed = await this._api.adjustVolume(-1, this._volumeMax());
    if (confirmed !== null) {
      this._currentVolume = confirmed;
      await this._syncVolumeCapability(confirmed);
    }
  }

  async onCapabilityVolumeMute(value) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;
    if (value) await this.mute();
    else await this.unmute();
  }

  async onCapabilitySpeakerPlaying(value) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;
    await this._api.set('netRemote.play.control', value ? PLAY_CONTROL.PLAY : PLAY_CONTROL.PAUSE);
  }

  async onCapabilityInputSource(value) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;
    const modeInt = parseInt(value, 10);
    if (modeInt === this._currentMode) return;
    await this._api.set('netRemote.sys.mode', modeInt);
  }

  // ── Public methods (called from driver flow card run listeners) ───────────

  getCurrentPreset() { return this._currentPreset; }
  getCurrentVolume() {
    const max = this._volumeMax();
    return max > 0 ? Math.round((this._currentVolume / max) * 100) : 0;
  }
  isMuted() { return this._isMuted; }

  async setSource(modeInt) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;

    // Mode check: use last polled value as fast path; live read if not yet polled.
    let currentMode = this._currentMode;
    if (currentMode === null || currentMode === undefined) {
      const raw = await this._api.get('netRemote.sys.mode');
      currentMode = raw !== null ? parseInt(raw, 10) : null;
    }
    if (currentMode === modeInt) return;

    await this._api.set('netRemote.sys.mode', modeInt);
  }

  async setPreset(preset1based) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;
    this.log(`setPreset: sending preset=${preset1based}`);
    await this._api.set('netRemote.nav.state', 1);
    await this._api.set('netRemote.nav.action.selectPreset', preset1based - 1);
    this._currentPreset = preset1based;
  }

  // Send a playback control command. Use PLAY_CONTROL constants from FsApi.
  // Silently skips if the radio is off.
  async playControl(value) {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) return;
    await this._api.set('netRemote.play.control', value);
  }

  async mute() {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) throw new Error(this.homey.__('flow.error_not_on'));
    try {
      await this._api.set('netRemote.sys.audio.mute', 1);
      this._isMuted = true;
      this._mutedViaNode = true;
    } catch (_) {
      // Radio does not support the mute node — fall back to setting volume to 0
      this._volumeBeforeMute = this._currentVolume;
      await this._api.set('netRemote.sys.audio.volume', 0);
      this._currentVolume = 0;
      this._isMuted = true;
      this._mutedViaNode = false;
      await this._syncVolumeCapability(0);
    }
  }

  async unmute() {
    this._ensureApi();
    if (!this.getCapabilityValue('onoff')) throw new Error(this.homey.__('flow.error_not_on'));
    if (this._mutedViaNode) {
      await this._api.set('netRemote.sys.audio.mute', 0);
    } else {
      const restore = this._volumeBeforeMute;
      await this._api.set('netRemote.sys.audio.volume', restore);
      this._currentVolume = restore;
      await this._syncVolumeCapability(restore);
    }
    this._isMuted = false;
    this._mutedViaNode = false;
  }

  async turnOnFull(modeInt, preset1based, volumePct) {
    this._ensureApi();
    this._startupInProgress = true;
    this._beginStartup();

    try {
      await this._startupSet('netRemote.sys.power', 1);
      await this._delay(1500);

      await this._startupSet('netRemote.sys.mode', modeInt);
      await this._delay(1500);

      await this._startupSet('netRemote.nav.state', 1);
      await this._delay(500);

      await this._startupSet('netRemote.nav.action.selectPreset', preset1based - 1);

      await this._api.waitUntilPlaying(10000, 500);

      await this._startupSet('netRemote.nav.state', 0);
      await this._delay(300);

      const max = this._volumeMax();
      const clamped = Math.max(0, Math.min(Math.round((volumePct / 100) * max), max));
      await this._startupSet('netRemote.sys.audio.volume', clamped);

      const confirmedVol = await this._api.get('netRemote.sys.audio.volume');
      if (confirmedVol !== null) {
        this._currentVolume = parseInt(confirmedVol, 10);
        await this._syncVolumeCapability(this._currentVolume);
      }

    } catch (err) {
      this.error(`turnOnFull sequence failed: ${err.message}`);
      throw new Error(this.homey.__('flow.error_timeout'));
    } finally {
      this._startupInProgress = false;
      this._endStartup();
    }
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  _getConfiguredPollMs() {
    return (this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL_S) * 1000;
  }

  _getEffectivePollMs() {
    const base = this._getConfiguredPollMs();
    return this._radioIsOff ? Math.min(base * 3, 60000) : base;
  }

  _startPolling() {
    this._stopPolling();
    this._pollActive = true;
    this.log(`polling started (interval: ${this._getEffectivePollMs() / 1000}s)`);
    this._schedulePoll(this._getEffectivePollMs());
  }

  _schedulePoll(ms) {
    this._pollTimer = setTimeout(() => this._runPollCycle(), ms);
  }

  async _runPollCycle() {
    if (!this._pollActive) return;
    this._pollTimer = null;
    await this._poll().catch((e) => this.error(`poll error: ${String(e)}`));
    // Schedule next cycle only if _poll() did not already reschedule (e.g. via _startPolling)
    if (this._pollActive && this._pollTimer === null) {
      this._schedulePoll(this._getEffectivePollMs());
    }
  }

  _stopPolling() {
    this._pollActive = false;
    if (this._pollTimer) {
      this.log('polling stopped');
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    // If the API is not yet available, attempt re-discovery and wait for next tick.
    if (!this._api) {
      if (this.getAvailable()) await this.setUnavailable('Device not reachable — rediscovering...');
      await this._tryRediscover();
      return;
    }

    // Suspend polling entirely during the turnOnFull startup sequence to prevent
    // the poller from stealing sessions mid-sequence.
    if (this._startupInProgress) return;

    // Fetch all 10 nodes in a single session.
    // Only CREATE_SESSION failure propagates; individual node errors return null.
    let state;
    try {
      state = await this._api.pollAll();
      this._consecutiveFailures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this._consecutiveFailures++;
      this._consecutivePowerOff = 0; // network failure is not evidence the radio is off
      this.error(`poll network failure ${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}: ${err.message}`);
      if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (this.getAvailable()) await this.setUnavailable(err.message);
        await this._tryRediscover();
      }
      return;
    }

    const { power, volume, mute, mode, preset, playStatus, name, artist, text } = state;

    // ── Power state ──────────────────────────────────────────────────────────
    const wasOn = this.getCapabilityValue('onoff');

    if (this._startupActive) {
      // Grace period: poll runs normally but onoff is protected.
      // End early as soon as the radio reports it is playing or paused.
      if (playStatus === '2' || playStatus === '3') {
        this._endStartup();
        if (!wasOn) await this.setCapabilityValue('onoff', true);
      }

    } else if (power === null) {
      // FS_NODE_BLOCKED or missing — never interpret as off, reset counter
      this._consecutivePowerOff = 0;

    } else if (power === '1') {
      this._consecutivePowerOff = 0;
      if (this._radioIsOff) {
        // Radio came back on — immediately revert to configured (1x) poll interval
        this._radioIsOff = false;
        this._startPolling();
      }
      if (!wasOn) {
        await this.setCapabilityValue('onoff', true);
        this._beginStartup();
      }

    } else {
      // power === '0'
      if (wasOn) {
        // Require playStatus=0 (stopped) in the SAME cycle to confirm the radio is truly off.
        // A single power=0 reading is not enough — it can be transient.
        if (playStatus === '0') {
          this._consecutivePowerOff++;
          if (this._consecutivePowerOff >= POWER_OFF_THRESHOLD) {
            this._consecutivePowerOff = 0;
            this._radioIsOff = true; // switch to 3x poll interval on next cycle
            await this.setCapabilityValue('onoff', false);
          }
        } else {
          // power=0 but play status is not conclusively stopped — likely transient, reset counter
          this._consecutivePowerOff = 0;
        }
      }
    }

    // ── Volume (update from poll only if changed) ─────────────────────────────
    if (volume !== null) {
      const volumeInt = parseInt(volume, 10);
      if (volumeInt !== this._currentVolume) {
        this._currentVolume = volumeInt;
        await this._syncVolumeCapability(volumeInt);
        const max = this._volumeMax();
        const volumePct = max > 0 ? Math.round((volumeInt / max) * 100) : 0;
        this.driver.triggerVolumeChanged(this, volumePct);
      }
    }

    // ── Mute (null = node unsupported → keep local state) ────────────────────
    if (mute !== null) {
      const isMuted = mute === '1';
      this._isMuted = isMuted;
      if (isMuted !== this.getCapabilityValue('volume_mute')) {
        await this.setCapabilityValue('volume_mute', isMuted);
      }
    }

    // ── Speaker playing state ─────────────────────────────────────────────────
    if (playStatus !== null) {
      const isPlaying = playStatus === '2';
      if (isPlaying !== this.getCapabilityValue('speaker_playing')) {
        await this.setCapabilityValue('speaker_playing', isPlaying);
      }
    }

    // ── Mode ─────────────────────────────────────────────────────────────────
    if (mode !== null) {
      this._currentMode = parseInt(mode, 10);
      const modeStr = String(this._currentMode);
      if (this.getCapabilityValue('input_source') !== modeStr) {
        await this.setCapabilityValue('input_source', modeStr);
      }
    }

    // ── Preset ───────────────────────────────────────────────────────────────
    // netRemote.nav.action.selectPreset is write-only on many Frontier Silicon
    // firmwares: the radio resets it to 0 when nav.state returns to 0, regardless
    // of the actually playing preset. Trusting a "0" reading would corrupt the
    // _currentPreset cache and break the setPreset() deduplication guard.
    // setPreset() and turnOnFull() maintain _currentPreset authoritatively;
    // the poll only updates it for unambiguous external changes (presets 2+).
    if (preset !== null) {
      this.log(`[PRESET] poll: raw=${preset} (0-based) | _currentPreset=${this._currentPreset} (1-based)`);
      if (preset !== '0') {
        const preset1 = parseInt(preset, 10) + 1;
        if (preset1 !== this._currentPreset) {
          this._currentPreset = preset1;
          this.driver.triggerPresetChanged(this, preset1);
        }
      }
    }

    // ── Now-playing (keep last known value when null = blocked/unavailable) ──
    if (name !== null) this._currentStation = name;
    if (artist !== null) this._currentArtist = artist;
    if (text !== null) this._currentSong = text;

    if (!this.getCapabilityValue('onoff')) {
      await this._clearNowPlaying();
    } else {
      await this._updateNowPlaying();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _volumeMax() {
    return (this.getStoreValue('volumeSteps') || 32) - 1;
  }

  async _syncVolumeCapability(intVal) {
    const max = this._volumeMax();
    await this.setCapabilityValue('volume_set', max > 0 ? intVal / max : 0);
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // SET during startup; FS_NODE_BLOCKED is silently ignored (radio may still be booting).
  async _startupSet(node, value) {
    try {
      await this._api.set(node, value);
    } catch (err) {
      if (err.message && err.message.includes(FSAPI_STATUS.NODE_BLOCKED)) return;
      throw err;
    }
  }

  async _clearNowPlaying() {
    await this.setCapabilityValue('station_name', '-');
    await this.setCapabilityValue('song', '-');
    await this.setCapabilityValue('now_playing', '-');
  }

  async _updateNowPlaying() {
    const modeMap = this.getStoreValue('modeMap') || {};
    const sourceStr = modeMap[String(this._currentMode)] || `Mode ${this._currentMode}`;

    // Detect CD/USB sources by label so we don't show "Preset N" as station name.
    const sourceLower = sourceStr.toLowerCase();
    const isCdOrUsb = sourceLower.includes('cd') || sourceLower.includes('usb') || sourceLower.includes('disc');

    let stationStr;
    let songStr;

    if (isCdOrUsb) {
      stationStr = '';
      // Priority: artist+text → text → name → empty
      if (this._currentArtist && this._currentSong) {
        songStr = `${this._currentArtist} - ${this._currentSong}`;
      } else if (this._currentSong) {
        songStr = this._currentSong;
      } else if (this._currentStation) {
        songStr = this._currentStation;
      } else {
        songStr = '';
      }
    } else {
      // Internet radio / DAB / FM: station name with preset fallback, plus song info
      stationStr = this._currentStation || `Preset ${this._currentPreset}`;
      if (this._currentArtist && this._currentSong) {
        songStr = `${this._currentArtist} - ${this._currentSong}`;
      } else {
        songStr = this._currentSong || '';
      }
    }

    await this.setCapabilityValue('station_name', stationStr || '-');
    await this.setCapabilityValue('song', songStr || '-');

    // Now Playing: "Source · Station Name · Song" with empty segments omitted
    const parts = [sourceStr, stationStr, songStr].filter(Boolean);
    await this.setCapabilityValue('now_playing', parts.join(' · ') || '-');
  }

  // ── IP re-discovery and input_source options ─────────────────────────────

  async _initInputSourceOptions() {
    const modeMap = this.getStoreValue('modeMap') || {};
    const values = Object.entries(modeMap).map(([id, label]) => ({
      id: String(id),
      title: { en: label },
    }));
    if (values.length > 0) {
      await this.setCapabilityOptions('input_source', { values });
    }
  }

  async _initApi() {
    const storedIp = this.getStoreValue('ip');
    if (storedIp) {
      this._lastKnownIp = storedIp;
      this._createApi(storedIp);
      return;
    }
    await this._tryRediscover();
  }

  async _tryRediscover() {
    if (this._rediscovering) return;
    this._rediscovering = true;
    this.log('SSDP re-discovery started');
    try {
      const devices = await discover(5000);
      const myUdn = this.getData().id;
      const match = devices.find((d) => d.udn === myUdn);
      if (match) {
        this.log(`SSDP re-discovered device at ${match.ip}`);
        await this.setStoreValue('ip', match.ip);
        this._lastKnownIp = match.ip;
        this._createApi(match.ip);
        if (!this.getAvailable()) await this.setAvailable();
      } else {
        this.log('SSDP re-discovery: device not found on network');
      }
    } catch (err) {
      this.error(`SSDP re-discovery failed: ${err.message}`);
    } finally {
      this._rediscovering = false;
    }
  }

  _createApi(ip) {
    const pin = this.getSetting('pin') || '1234';
    this._api = new FsApi(ip, pin);
  }

}

module.exports = UndokDevice;
