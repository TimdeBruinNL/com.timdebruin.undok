'use strict';

const http = require('http');

const TIMEOUT_MS = 5000;

// FSAPI protocol status strings returned in XML responses.
// The PIN is transmitted as a URL query parameter as required by the FSAPI protocol;
// all communication is over the local network only — never to external servers.
const FSAPI_STATUS = {
  OK: 'FS_OK',
  NODE_BLOCKED: 'FS_NODE_BLOCKED',
  TIMEOUT: 'FS_TIMEOUT',
  FAIL: 'FS_FAIL',
};

// Playback control values for netRemote.play.control
const PLAY_CONTROL = {
  PLAY: 1,
  PAUSE: 2,
  NEXT: 3,
  PREVIOUS: 4,
};

class SessionStolenError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SessionStolenError';
  }
}

class GetMultipleUnsupportedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'GetMultipleUnsupportedError';
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// Strip XML/HTML tags and decode HTML entities from a value string.
function decodeValue(value) {
  if (!value) return value;
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseValue(xml) {
  const m = xml.match(/<value>(.*?)<\/value>/s)
    || xml.match(/<u8>(.*?)<\/u8>/s)
    || xml.match(/<u32>(.*?)<\/u32>/s)
    || xml.match(/<s8>(.*?)<\/s8>/s)
    || xml.match(/<c8_array>(.*?)<\/c8_array>/s);
  return m ? decodeValue(m[1].trim()) : null;
}

function parseStatus(xml) {
  const m = xml.match(/<status>(.*?)<\/status>/);
  return m ? m[1].trim() : null;
}

function parseSessionId(xml) {
  const m = xml.match(/<sessionId>(.*?)<\/sessionId>/);
  return m ? m[1].trim() : null;
}

// Parse GET_MULTIPLE response into { nodeName: value } map.
// Nodes with non-OK status (BLOCKED, TIMEOUT, etc.) map to null.
function parseGetMultipleResponse(xml) {
  const result = {};
  const blockRe = /<fsapiResponse>([\s\S]*?)<\/fsapiResponse>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const nodeMatch = block.match(/<node>(.*?)<\/node>/);
    if (!nodeMatch) continue;
    const nodeName = nodeMatch[1].trim();
    const statusMatch = block.match(/<status>(.*?)<\/status>/);
    const status = statusMatch ? statusMatch[1].trim() : null;
    result[nodeName] = status === FSAPI_STATUS.OK ? parseValue(block) : null;
  }
  return result;
}

// Parse LIST_GET_NEXT response into { "key": "label" } map (selectable modes only).
function parseListItems(xml) {
  const map = {};
  const itemRe = /<item key="(\d+)">([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const key = m[1];
    const inner = m[2];
    const labelMatch = inner.match(/<field name="label"><c8_array>(.*?)<\/c8_array>/);
    const unselectable = inner.match(/<field name="unselectable"><u8>1<\/u8>/);
    if (labelMatch && !unselectable) {
      map[key] = decodeValue(labelMatch[1]);
    }
  }
  return map;
}

class FsApi {

  constructor(ip, pin = '1234') {
    this.ip = ip;
    this.pin = pin;
    this._getMultipleSupported = true;
  }

  _base() { return `http://${this.ip}/fsapi`; }

  // Create a fresh session and return the sid.
  // Throws on HTTP error or non-FS_OK response — radio is genuinely unreachable or PIN is wrong.
  async createSession() {
    const { statusCode, body } = await httpGet(`${this._base()}/CREATE_SESSION?pin=${this.pin}`);
    if (statusCode !== 200) throw new Error(`CREATE_SESSION HTTP ${statusCode}`);
    const status = parseStatus(body);
    if (status !== FSAPI_STATUS.OK) throw new Error(`CREATE_SESSION failed: ${status}`);
    const sid = parseSessionId(body);
    if (!sid) throw new Error('CREATE_SESSION returned no session ID');
    return sid;
  }

  // Run fn(sid) with a fresh session.
  // On SessionStolenError (HTTP 404), create a new session and retry fn once.
  async withSession(fn) {
    const sid = await this.createSession();
    try {
      return await fn(sid);
    } catch (err) {
      if (err instanceof SessionStolenError) {
        const sid2 = await this.createSession();
        return await fn(sid2);
      }
      throw err;
    }
  }

  // GET using an existing sid.
  // Returns value string or null (FS_NODE_BLOCKED, transient FS errors, missing value tag).
  // Throws SessionStolenError on HTTP 404; throws on genuine network errors.
  async _doGet(sid, node) {
    const url = `${this._base()}/GET/${node}?pin=${this.pin}&sid=${sid}`;
    const { statusCode, body } = await httpGet(url);
    if (statusCode === 404) throw new SessionStolenError(`GET ${node} HTTP 404`);
    if (statusCode !== 200) throw new Error(`GET ${node} HTTP ${statusCode}`);
    const status = parseStatus(body);
    if (status === FSAPI_STATUS.OK) return parseValue(body);
    if (status === FSAPI_STATUS.NODE_BLOCKED
      || status === FSAPI_STATUS.TIMEOUT
      || status === FSAPI_STATUS.FAIL) return null;
    return null;
  }

  // SET using an existing sid. Returns true on FS_OK. Throws on any failure.
  async _doSet(sid, node, value) {
    const url = `${this._base()}/SET/${node}?pin=${this.pin}&sid=${sid}&value=${encodeURIComponent(value)}`;
    const { statusCode, body } = await httpGet(url);
    if (statusCode === 404) throw new SessionStolenError(`SET ${node} HTTP 404`);
    if (statusCode !== 200) throw new Error(`SET ${node} HTTP ${statusCode}`);
    const status = parseStatus(body);
    if (status === FSAPI_STATUS.OK) return true;
    throw new Error(`SET ${node}=${value} failed: ${status}`);
  }

  // Stateless GET — creates and disposes its own session per call.
  async get(node) {
    return this.withSession((sid) => this._doGet(sid, node));
  }

  // Stateless SET — creates and disposes its own session per call. Throws on failure.
  async set(node, value) {
    return this.withSession((sid) => this._doSet(sid, node, value));
  }

  // Fetch multiple nodes in a single GET_MULTIPLE HTTP request.
  // Returns { nodeName: value } — null for any node that is blocked or missing.
  // Throws GetMultipleUnsupportedError if the device doesn't support GET_MULTIPLE.
  // Throws SessionStolenError on HTTP 404. Throws on genuine network errors.
  async getMultiple(nodes, sid) {
    const nodeParams = nodes.map((n) => `node=${encodeURIComponent(n)}`).join('&');
    const url = `${this._base()}/GET_MULTIPLE?pin=${this.pin}&sid=${sid}&${nodeParams}`;
    const { statusCode, body } = await httpGet(url);
    if (statusCode === 404) throw new SessionStolenError('GET_MULTIPLE HTTP 404');
    if (statusCode !== 200 || !body.includes('<fsapiGetMultipleResponse>')) {
      const status = parseStatus(body) || `HTTP ${statusCode}`;
      throw new GetMultipleUnsupportedError(`GET_MULTIPLE not supported: ${status}`);
    }
    return parseGetMultipleResponse(body);
  }

  // Poll all status nodes in one HTTP roundtrip using GET_MULTIPLE when supported,
  // falling back to parallel individual GETs on devices that lack the endpoint.
  // Returns { power, volume, mute, mode, preset, playStatus, name, artist, text }
  // (null for any node that is blocked, missing, or failed).
  async pollAll() {
    const POLL_NODES = [
      'netRemote.sys.power',
      'netRemote.sys.audio.volume',
      'netRemote.sys.audio.mute',
      'netRemote.sys.mode',
      'netRemote.nav.action.selectPreset',
      'netRemote.play.status',
      'netRemote.play.info.name',
      'netRemote.play.info.artist',
      'netRemote.play.info.text',
    ];

    return this.withSession(async (sid) => {
      let map;

      if (this._getMultipleSupported) {
        try {
          map = await this.getMultiple(POLL_NODES, sid);
        } catch (err) {
          if (err instanceof SessionStolenError) throw err;
          if (err instanceof GetMultipleUnsupportedError) {
            this._getMultipleSupported = false;
            // eslint-disable-next-line no-console
            console.warn(`[FsApi] GET_MULTIPLE not supported for ${this.ip}, falling back to individual GETs:`, err.message);
          } else {
            throw err; // genuine network error — propagate so caller increments failure counter
          }
        }
      }

      if (!map) {
        // Parallel individual GETs (fallback path)
        let sessionStolen = false;
        const safeGet = async (node) => {
          try { return await this._doGet(sid, node); }
          catch (err) {
            if (err instanceof SessionStolenError) sessionStolen = true;
            return null;
          }
        };
        const values = await Promise.all(POLL_NODES.map((n) => safeGet(n)));
        if (sessionStolen) throw new SessionStolenError('session stolen during individual GET fallback');
        map = Object.fromEntries(POLL_NODES.map((n, i) => [n, values[i]]));
      }

      return {
        power:      map['netRemote.sys.power'] ?? null,
        volume:     map['netRemote.sys.audio.volume'] ?? null,
        mute:       map['netRemote.sys.audio.mute'] ?? null,
        mode:       map['netRemote.sys.mode'] ?? null,
        preset:     map['netRemote.nav.action.selectPreset'] ?? null,
        playStatus: map['netRemote.play.status'] ?? null,
        name:       map['netRemote.play.info.name'] ?? null,
        artist:     map['netRemote.play.info.artist'] ?? null,
        text:       map['netRemote.play.info.text'] ?? null,
      };
    });
  }

  // Adjust volume by steps (positive = up, negative = down) within [0, max].
  // Uses a single session for power check + read + set + confirm.
  // Returns confirmed volume integer, or null if the radio is explicitly off.
  async adjustVolume(steps, max) {
    return this.withSession(async (sid) => {
      const power = await this._doGet(sid, 'netRemote.sys.power');
      if (power === '0') return null;

      const currentRaw = await this._doGet(sid, 'netRemote.sys.audio.volume');
      const current = parseInt(currentRaw, 10);
      if (isNaN(current)) throw new Error('Could not retrieve current volume from radio.');

      const next = Math.max(0, Math.min(current + steps, max));
      await this._doSet(sid, 'netRemote.sys.audio.volume', next);

      const confirmedRaw = await this._doGet(sid, 'netRemote.sys.audio.volume');
      return confirmedRaw !== null ? parseInt(confirmedRaw, 10) : next;
    });
  }

  // Set volume to an absolute integer value within [0, max].
  // Uses a single session for power check + set + confirm.
  // Returns confirmed volume integer, or null if the radio is explicitly off.
  async setVolume(intValue, max) {
    return this.withSession(async (sid) => {
      const power = await this._doGet(sid, 'netRemote.sys.power');
      if (power === '0') return null;

      const clamped = Math.max(0, Math.min(intValue, max));
      await this._doSet(sid, 'netRemote.sys.audio.volume', clamped);

      const confirmedRaw = await this._doGet(sid, 'netRemote.sys.audio.volume');
      return confirmedRaw !== null ? parseInt(confirmedRaw, 10) : clamped;
    });
  }

  // Fetch all valid modes as a { "key": "label" } map (selectable modes only).
  async listGetAll(node, maxItems = 100) {
    return this.withSession(async (sid) => {
      const url = `${this._base()}/LIST_GET_NEXT/${node}/-1?pin=${this.pin}&sid=${sid}&maxItems=${maxItems}`;
      const { statusCode, body } = await httpGet(url);
      if (statusCode === 404) throw new SessionStolenError(`LIST_GET_NEXT ${node} HTTP 404`);
      if (statusCode !== 200) throw new Error(`LIST_GET_NEXT ${node} HTTP ${statusCode}`);
      const status = parseStatus(body);
      if (status !== FSAPI_STATUS.OK) throw new Error(`LIST_GET_NEXT ${node} failed: ${status}`);
      return parseListItems(body);
    });
  }

  // Poll netRemote.play.status until playing (2) or paused (3), each check with a fresh session.
  // Throws after maxMs if the playing state is never reached.
  async waitUntilPlaying(maxMs = 10000, intervalMs = 500) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const val = await this.get('netRemote.play.status');
        if (val === '2' || val === '3') return true;
      } catch (_) {
        // network error — keep retrying until deadline
      }
    }
    throw new Error('Radio did not reach playing state within timeout');
  }

}

module.exports = { FsApi, FSAPI_STATUS, PLAY_CONTROL };
