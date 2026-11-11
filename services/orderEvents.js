'use strict';
const { EventEmitter } = require('events');
const orderEvents = new EventEmitter();
orderEvents.setMaxListeners(50);
module.exports = orderEvents;
