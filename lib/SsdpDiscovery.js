'use strict';

const dgram = require('dgram');
const http = require('http');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGET = 'urn:schemas-frontier-silicon-com:undok:fsapi:1';
const SEARCH_MESSAGE = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 3',
  `ST: ${SEARCH_TARGET}`,
  '',
  '',
].join('\r\n');

// Fetch and parse the SSDP device description XML
function fetchDescription(location) {
  return new Promise((resolve, reject) => {
    http.get(location, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'));
  return m ? m[1].trim() : null;
}

// Returns a promise that resolves with an array of discovered device objects
function discover(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Map(); // udn -> device
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve(Array.from(found.values()));
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('message', async (msg) => {
      const text = msg.toString();
      if (!text.includes('frontier-silicon') && !text.includes('undok')) return;

      const locationMatch = text.match(/LOCATION:\s*(.+)/i);
      if (!locationMatch) return;
      const location = locationMatch[1].trim();

      // Extract IP from location URL
      const ipMatch = location.match(/http:\/\/([\d.]+)/);
      if (!ipMatch) return;
      const ip = ipMatch[1];

      try {
        const xml = await fetchDescription(location);
        const udn = parseTag(xml, 'UDN') || parseTag(xml, 'serialNumber') || ip;
        const friendlyName = parseTag(xml, 'friendlyName') || `Radio (${ip})`;
        const modelName = parseTag(xml, 'modelName') || '';

        if (!found.has(udn)) {
          found.set(udn, { udn, ip, friendlyName, modelName, location });
        }
      } catch (_) {
        // If description fetch fails, record with IP-derived id
        if (!found.has(ip)) {
          found.set(ip, { udn: ip, ip, friendlyName: `Radio (${ip})`, modelName: '', location });
        }
      }
    });

    socket.on('error', () => { clearTimeout(timer); finish(); });

    socket.bind(() => {
      const buf = Buffer.from(SEARCH_MESSAGE);
      socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS, (err) => {
        if (err) { clearTimeout(timer); finish(); }
      });
    });
  });
}

module.exports = { discover };
