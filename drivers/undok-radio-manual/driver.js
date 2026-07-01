'use strict';

const http = require('http');
const UndokDriver = require('../undok-radio/driver');

class ManualDriver extends UndokDriver {

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
