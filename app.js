'use strict';

const { App } = require('homey');

class UndokApp extends App {
  async onInit() {
    this.log('UNDOK / Frontier Silicon radio app started');
  }
}

module.exports = UndokApp;
