/*!
 * Nats
 * Copyright(c) 2012-2015 Apcera Inc. All rights reserved.
 * Copyright(c) 2011-2014 Derek Collison (derek.collison@gmail.com)
 * MIT Licensed
 */

/* jslint node: true */
'use strict';

/**
 * Module Dependencies
 */

var net    = require('net'),
    url    = require('url'),
    util   = require('util'),
    events = require('events');

/**
 * Constants
 */

var VERSION = '0.4.4',

    DEFAULT_PORT = 4222,
    DEFAULT_PRE  = 'nats://localhost:',
    DEFAULT_URI  =  DEFAULT_PRE + DEFAULT_PORT,

    MAX_CONTROL_LINE_SIZE = 512,

    // Parser state
    AWAITING_CONTROL = 0,
    AWAITING_MSG_PAYLOAD = 1,

    // Reconnect Parameters, 2 sec wait, 10 tries
    DEFAULT_RECONNECT_TIME_WAIT = 2*1000,
    DEFAULT_MAX_RECONNECT_ATTEMPTS = 10,

    // Protocol
    //CONTROL_LINE = /^(.*)\r\n/, // TODO: remove / never used

    MSG  = /^MSG\s+([^\s\r\n]+)\s+([^\s\r\n]+)\s+(([^\s\r\n]+)[^\S\r\n]+)?(\d+)\r\n/i,
    OK   = /^\+OK\s*\r\n/i,
    ERR  = /^-ERR\s+('.+')?\r\n/i,
    PING = /^PING\r\n/i,
    PONG = /^PONG\r\n/i,
    INFO = /^INFO\s+([^\r\n]+)\r\n/i,

    CR_LF = '\r\n',
    CR_LF_LEN = CR_LF.length,
    EMPTY = '',
    SPC = ' ',

    // Protocol
    //PUB     = 'PUB', // TODO: remove / never used
    SUB     = 'SUB',
    UNSUB   = 'UNSUB',
    CONNECT = 'CONNECT',

    // Responses
    PING_REQUEST  = 'PING' + CR_LF,
    PONG_RESPONSE = 'PONG' + CR_LF,

    EMPTY = '',

    // Pedantic Mode support
    //Q_SUB = /^([^\.\*>\s]+|>$|\*)(\.([^\.\*>\s]+|>$|\*))*$/, // TODO: remove / never used
    //Q_SUB_NO_WC = /^([^\.\*>\s]+)(\.([^\.\*>\s]+))*$/, // TODO: remove / never used

    FLUSH_THRESHOLD = 65536;

/**
 * Library Version
 */

exports.version = VERSION;

/**
 * Generate random hex strings for createInbox.
 *
 * @api private
*/

function hexRand(limit) {
  return (parseInt(Math.random()*limit, 16).toString(16));
}

/**
 * Create a properly formatted inbox subject.
 *
 * @api public
*/

var createInbox = exports.createInbox = function() {
  return ('_INBOX.' +
          hexRand(0x0010000) +
          hexRand(0x0010000) +
          hexRand(0x0010000) +
          hexRand(0x0010000) +
          hexRand(0x1000000));
};

/**
 * Initialize a client with the appropriate options.
 *
 * @param {Mixed} opts
 * @api public
 */

function Client(opts) {
  events.EventEmitter.call(this);
  this.parseOptions(opts);
  this.initState();
  this.createConnection();
}

/**
 * Connect to a nats-server and return the client.
 * Argument can be a url, or an object with a 'url'
 * property and additional options.
 *
 * @params {Mixed} opts
 *
 * @api public
 */

exports.connect = function(opts) {
  return new Client(opts);
};

/**
 * Connected clients are event emitters.
 */

util.inherits(Client, events.EventEmitter);

/**
 * Allow createInbox to be called on a client.
 *
 * @api public
 */

Client.prototype.createInbox = createInbox;

Client.prototype.assignOption = function(opts, prop, assign) {
  if (assign === undefined) {
    assign = prop;
  }
  if (opts[prop] !== undefined) {
    this.options[assign] = opts[prop];
  }
};

function shuffle(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

/**
 * Parse the conctructor/connect options.
 *
 * @param {Mixed} opts
 * @api private
 */

Client.prototype.parseOptions = function(opts) {
  var options = this.options = {
    'verbose'              : false,
    'pedantic'             : false,
    'reconnect'            : true,
    'maxReconnectAttempts' : DEFAULT_MAX_RECONNECT_ATTEMPTS,
    'reconnectTimeWait'    : DEFAULT_RECONNECT_TIME_WAIT,
    'encoding'             : 'utf8'
  };

  if (undefined === opts) {
    options.url = DEFAULT_URI;
  } else if ('number' === typeof opts) {
    options.url = DEFAULT_PRE + opts;
  } else if ('string' === typeof opts) {
    options.url = opts;
  } else if ('object' === typeof opts) {
    if (opts.port !== undefined) {
      options.url = DEFAULT_PRE + opts.port;
    }
    // Pull out various options here
    this.assignOption(opts, 'url');
    this.assignOption(opts, 'uri', 'url');
    this.assignOption(opts, 'user');
    this.assignOption(opts, 'pass');
    this.assignOption(opts, 'password', 'pass');
    this.assignOption(opts, 'verbose');
    this.assignOption(opts, 'pedantic');
    this.assignOption(opts, 'reconnect');
    this.assignOption(opts, 'maxReconnectAttempts');
    this.assignOption(opts, 'reconnectTimeWait');
    this.assignOption(opts, 'servers');
    this.assignOption(opts, 'urls', 'servers');
    this.assignOption(opts, 'noRandomize');
    this.assignOption(opts, 'NoRandomize', 'noRandomize');
    this.assignOption(opts, 'dontRandomize', 'noRandomize');
    this.assignOption(opts, 'encoding');
  }

  var client = this;

  // Set user/pass as needed if in options.
  client.user = options.user;
  client.pass = options.pass;

  // Encoding - make sure its valid.
  if (Buffer.isEncoding(options.encoding)) {
    client.encoding = options.encoding;
  } else {
    throw new Error('Invalid Encoding:' + options.encoding);
  }

  // For cluster support
  client.servers = [];

  if (Array.isArray(options.servers)) {
    options.servers.forEach(function(server) {
      client.servers.push(new Server(url.parse(server)));
    });
  } else {
    if (undefined === options.url) {
      options.url = DEFAULT_URI;
    }
    client.servers.push(new Server(url.parse(options.url)));
  }

  // Randomize if needed
  if (options.noRandomize !==  true) {
    shuffle(client.servers);
  }
};

/**
 * Create a new server.
 *
 * @api private
*/

function Server(url) {
  this.url = url;
  this.didConnect = false;
  this.reconnects = 0;
}

/**
 * Properly select the next server.
 * We rotate the server list as we go,
 * we also pull auth from urls as needed, or
 * if they were set in options use that as override.
 *
 * @api private
*/

Client.prototype.selectServer = function() {
  var client = this;
  var server = client.servers.shift();

  // Place in client context.
  client.currentServer = server;
  client.url = server.url;
  if ('auth' in server.url && !!server.url.auth) {
    var auth = server.url.auth.split(':');
    if (client.options.user === undefined) {
      client.user = auth[0];
    }
    if (client.options.pass === undefined) {
      client.pass = auth[1];
    }
  }
  client.servers.push(server);
};

/**
 * Properly setup a stream connection with proper events.
 *
 * @api private
*/

Client.prototype.createConnection = function() {
  var client = this;

  client.pongs   = [];
  client.pending = [];
  client.pSize   = 0;
  client.pstate  = AWAITING_CONTROL;

  client.selectServer();

  var stream = client.stream = net.createConnection(client.url.port, client.url.hostname);

  stream.on('connect', function() {
    var wasReconnecting = client.reconnecting;
    var event = wasReconnecting === true ? 'reconnect' : 'connect';
    client.connected = true;
    client.wasConnected = true;
    client.currentServer.didConnect = true;
    client.reconnecting = false;
    client.reconnects = 0;
    client.flushPending();
    if (wasReconnecting) {
      client.sendSubscriptions();
    }
    client.flush(function() {
      client.emit(event, client);
    });
  });

  stream.on('close', function(/*hadError*/) {
    client.closeStream();
    client.emit('disconnect');
    if (client.closed === true ||
        client.options.reconnect === false ||
        ((client.reconnects >= client.options.maxReconnectAttempts) && client.options.maxReconnectAttempts !== -1)) {
      client.emit('close');
    } else {
      client.scheduleReconnect();
    }
  });

  stream.on('error', function(exception) {
    // If we were connected just return, close event will process
    if (client.wasConnected === true && client.currentServer.didConnect === true) {
      return;
    }

    // if the current server did not connect at all, and we in
    // general have not connected to any server, remove it from
    // this list.
    if (client.wasConnected === false && client.currentServer.didConnect === false) {
      client.servers.splice(client.servers.length-1, 1);
    }

    // Only bubble up error if we never had connected
    // to the server and we only have one.
    if (client.wasConnected === false && client.servers.length === 0) {
      client.emit('error', 'Could not connect to server: ' + exception);
    }
    client.closeStream();
  });

  stream.on('data', function (data) {
    // If inbound exists, concat them together. We try to avoid this for split
    // messages, so this should only really happen for a split control line.
    // Long term answer is hand rolled parser and not regexp.
    if (client.inbound) {
      client.inbound = Buffer.concat([client.inbound, data]);
    } else {
      client.inbound = data;
    }

    // Hold any regex matches.
    var m;

    while (!client.closed && client.inbound && client.inbound.length > 0) {
      switch (client.pstate) {

      case AWAITING_CONTROL:
	// Regex only works on strings, so convert once to be more efficient.
	// Long term answer is a hand rolled parser, not regex.
	var buf = client.inbound.toString('binary', 0, MAX_CONTROL_LINE_SIZE);
        if ((m = MSG.exec(buf)) !== null) {
          client.payload = {
            subj : m[1],
            sid : m[2],
            reply : m[4],
            size : parseInt(m[5], 10)
          };
	  client.payload.psize = client.payload.size + CR_LF_LEN;
          client.pstate = AWAITING_MSG_PAYLOAD;
        } else if ((m = OK.exec(buf)) !== null) {
          // Ignore for now..
        } else if ((m = ERR.exec(buf)) !== null) {
          client.emit('error', m[1]);
        } else if ((m = PONG.exec(buf)) !== null) {
          var cb = client.pongs.shift();
          if (cb) { cb(); } // FIXME: Should we check for exceptions?
        } else if ((m = PING.exec(buf)) !== null) {
          client.sendCommand(PONG_RESPONSE);
        } else if ((m = INFO.exec(buf)) !== null) {
          // Ignore for now..
        } else {
          // FIXME, check line length for something weird.
          // Nothing here yet, return
          return;
        }
        break;

      case AWAITING_MSG_PAYLOAD:

	// If we do not have the complete message, hold onto the chunks
	// and assemble when we have all we need. This optimizes for
	// when we parse a large buffer down to a small number of bytes,
	// then we receive a large chunk. This avoids a big copy with a
	// simple concat above.
        if (client.inbound.length < client.payload.psize) {
	  if (undefined === client.payload.chunks) {
	    client.payload.chunks = [];
	  }
	  client.payload.chunks.push(client.inbound);
	  client.payload.psize -= client.inbound.length;
          client.inbound = null;
	  return;
	}

	// If we are here we have the complete message.
	// Check to see if we have existing chunks
	if (client.payload.chunks) {
	  client.payload.chunks.push(client.inbound.slice(0, client.payload.psize));
	  var mbuf = Buffer.concat(client.payload.chunks, client.payload.size+CR_LF_LEN);
	  client.payload.msg = mbuf.toString(client.encoding, 0, client.payload.size);
	} else {
	  client.payload.msg = client.inbound.toString(client.encoding, 0, client.payload.size);
	}

	// Eat the size of the inbound that represents the message.
        if (client.inbound.length === client.payload.psize) {
          client.inbound = null;
        } else {
          client.inbound = client.inbound.slice(client.payload.psize);
        }

        // process the message
        client.processMsg();

	// Reset
	client.pstate = AWAITING_CONTROL;
	client.payload = null;

	break;
      }

      // This is applicable for a regex match to eat the bytes we used from a control line.
      if (m) {
        // Chop inbound
        var psize = m[0].length;
        if (psize >= client.inbound.length) {
          client.inbound = null;
        } else {
          client.inbound = client.inbound.slice(psize);
        }
      }
      m = null;
    }
  });

  // Queue the connect command.
  var cs = {
    'lang'    : 'node',
    'version' : VERSION,
    'verbose' : this.options.verbose,
    'pedantic': this.options.pedantic
  };
  if (this.user !== undefined) {
    cs.user = this.user;
    cs.pass = this.pass;
  }
  this.sendCommand(CONNECT + SPC + JSON.stringify(cs) + CR_LF);
};

/**
 * Initialize client state.
 *
 * @api private
 */

Client.prototype.initState = function() {
  this.ssid         = 1;
  this.subs         = {};
  this.reconnects   = 0;
  this.connected    = false;
  this.wasConnected = false;
  this.reconnecting = false;
  this.server       = null;
};

/**
 * Close the connection to the server.
 *
 * @api public
 */

Client.prototype.close = function() {
  this.closed = true;
  this.removeAllListeners();
  this.closeStream();
  this.ssid     = -1;
  this.subs     = null;
  this.pstate   = -1;
  this.pongs    = null;
  this.pending  = null;
  this.pSize    = 0;
};

/**
 * Close down the stream and clear state.
 *
 * @api private
 */

Client.prototype.closeStream = function() {
  if (this.stream !== null) {
    this.stream.end();
    this.stream.destroy();
    this.stream  = null;
  }
  if (this.connected === true || this.closed === true) {
    this.pongs     = null;
    this.pending   = null;
    this.pSize     = 0;
    this.connected = false;
  }
  this.inbound = null;
};

/**
 * Flush all pending data to the server.
 *
 * @api private
 */

Client.prototype.flushPending = function() {
  if (this.connected === false ||
      this.pending === null ||
      this.pending.length === 0) { return; }

  this.stream.write(this.pending.join(EMPTY));
  this.pending = [];
  this.pSize   = 0;
};

/**
 * Send commands to the server or queue them up if connection pending.
 *
 * @api private
 */

Client.prototype.sendCommand = function(cmd) {
  // Buffer to cut down on system calls, increase throughput.
  // When receive gets faster, should make this Buffer based..

  if (this.closed || this.pending === null) { return; }

  this.pending.push(cmd);
  this.pSize += Buffer.byteLength(cmd);

  if (this.connected === true) {
    // First one let's setup flush..
    if (this.pending.length === 1) {
      var self = this;
      process.nextTick(function() {
        self.flushPending();
      });
    } else if (this.pSize > FLUSH_THRESHOLD) {
      // Flush in place when threshold reached..
      this.flushPending();
    }
  }
};

/**
 * Sends existing subscriptions to new server after reconnect.
 *
 * @api private
 */

Client.prototype.sendSubscriptions = function() {
  var proto;
  for (var sid in this.subs) {
    if (this.subs.hasOwnProperty(sid)) {
      var sub = this.subs[sid];
      if (sub.qgroup) {
	proto = [SUB, sub.subject, sub.qgroup, sid + CR_LF];
      } else {
	proto = [SUB, sub.subject, sid + CR_LF];
      }
      this.sendCommand(proto.join(SPC));
    }
  }
};

/**
 * Process a delivered message and deliver to appropriate subscriber.
 *
 * @api private
 */

Client.prototype.processMsg = function() {
  var sub = this.subs[this.payload.sid];
  if (sub !== undefined) {
    sub.received += 1;
    // Check for a timeout, and cancel if received >= expected
    if (sub.timeout) {
      if (sub.received >= sub.expected) {
        clearTimeout(sub.timeout);
        sub.timeout = null;
      }
    }
    // Check for auto-unsubscribe
    if (sub.max !== undefined) {
      if (sub.received === sub.max) {
        delete this.subs[this.payload.sid];
      } else if (sub.received > sub.max) {
        this.unsubscribe(this.payload.sid);
        sub.callback = null;
      }
    }

    if (sub.callback) {
      sub.callback(this.payload.msg, this.payload.reply, this.payload.subj, this.payload.sid);
    }
  }
};

/**
 * Flush outbound queue to server and call optional callback when server has processed
 * all data.
 *
 * @param {Function} opt_callback
 * @api public
 */

Client.prototype.flush = function(opt_callback) {
  if (typeof opt_callback === 'function') {
    this.pongs.push(opt_callback);
    this.sendCommand(PING_REQUEST);
  }
};

/**
 * Publish a message to the given subject, with optional reply and callback.
 *
 * @param {String} subject
 * @param {String} msg
 * @param {String} opt_reply
 * @param {Function} opt_callback
 * @api public
 */

Client.prototype.publish = function(subject, msg, opt_reply, opt_callback) {
  if (!msg) { msg = EMPTY; }
  if (typeof msg === 'function') {
    if (opt_callback || opt_reply) {
      throw(new Error('Message can\'t be a function'));
    }
    opt_callback = msg;
    msg = EMPTY;
    opt_reply = undefined;
  }
  if (typeof opt_reply === 'function') {
    if (opt_callback) {
      throw(new Error('Reply can\'t be a function'));
    }
    opt_callback = opt_reply;
    opt_reply = undefined;
  }

  // Hold PUB SUB [REPLY]
  var psub;
  if (opt_reply === undefined) {
    psub = 'PUB ' + subject + SPC;
  } else {
    psub = 'PUB ' + subject + SPC + opt_reply + SPC;
  }
  this.sendCommand(psub + Buffer.byteLength(msg) + CR_LF + msg + CR_LF);

  if (opt_callback !== undefined) {
    this.flush(opt_callback);
  }
};

/**
 * Subscribe to a given subject, with optional options and callback. opts can be
 * ommitted, even with a callback. The Subscriber Id is returned.
 *
 * @param {String} subject
 * @param {Object} opts
 * @param {Function} callback
 * @return {Mixed}
 * @api public
 */

Client.prototype.subscribe = function(subject, opts, callback) {
  var qgroup, max;
  if (typeof opts === 'function') {
    callback = opts;
    opts = null;
  } else if (opts && typeof opts === 'object') {
    // FIXME, check exists, error otherwise..
    qgroup = opts.queue;
    max = opts.max;
  }
  this.ssid += 1;
  this.subs[this.ssid] = { 'subject':subject, 'callback':callback, 'received':0 };

  var proto;
  if (typeof qgroup === 'string') {
    this.subs[this.ssid].qgroup = qgroup;
    proto = [SUB, subject, qgroup, this.ssid + CR_LF];
  } else {
    proto = [SUB, subject, this.ssid + CR_LF];
  }
  this.sendCommand(proto.join(SPC));

  if (max) {
    this.unsubscribe(this.ssid, max);
  }
  return this.ssid;
};

/**
 * Unsubscribe to a given Subscriber Id, with optional max parameter.
 *
 * @param {Mixed} sid
 * @param {Number} opt_max
 * @api public
 */

Client.prototype.unsubscribe = function(sid, opt_max) {
  if (!sid) { return; }

  var proto;
  if (opt_max) {
    proto = [UNSUB, sid, opt_max + CR_LF];
  } else {
    proto = [UNSUB, sid + CR_LF];
  }
  this.sendCommand(proto.join(SPC));

  var sub = this.subs[sid];
  if (sub === undefined) {
    return;
  }
  sub.max = opt_max;
  if (sub.max === undefined || (sub.received >= sub.max)) {
    delete this.subs[sid];
  }
};

/**
 * Set a timeout on a subscription.
 *
 * @param {Mixed} sid
 * @param {Number} timeout
 * @param {Number} expected
 * @api public
 */

Client.prototype.timeout = function(sid, timeout, expected, callback) {
  if (!sid) { return; }
  var sub = this.subs[sid];
  if (sub === null) { return; }
  sub.expected = expected;
  sub.timeout = setTimeout(function() { callback(sid); }, timeout);
};

/**
 * Publish a message with an implicit inbox listener as the reply. Message is optional.
 * This should be treated as a subscription. You can optionally indicate how many
 * messages you only want to receive using opt_options = {max:N}. Otherwise you
 * will need to unsubscribe to stop the message stream.
 * The Subscriber Id is returned.
 *
 * @param {String} subject
 * @param {String} opt_msg
 * @param {Object} opt_options
 * @param {Function} callback
 * @return {Mixed}
 * @api public
 */

Client.prototype.request = function(subject, opt_msg, opt_options, callback) {
  if (typeof opt_msg === 'function') {
    callback = opt_msg;
    opt_msg = EMPTY;
    opt_options = null;
  }
  if (typeof opt_options === 'function') {
    callback = opt_options;
    opt_options = null;
  }
  var inbox = createInbox();
  var s = this.subscribe(inbox, opt_options, function(msg, reply) {
    callback(msg, reply);
  });
  this.publish(subject, opt_msg, inbox);
  return s;
};

/**
 * Report number of outstanding subscriptions on this connection.
 *
 * @return {Number}
 * @api public
 */

Client.prototype.numSubscriptions = function() {
  return Object.keys(this.subs).length;
};

/**
 * Reconnect to the server.
 *
 * @api private
 */

Client.prototype.reconnect = function() {
  if (this.closed) { return; }
  this.reconnects += 1;
  this.createConnection();
  if (this.currentServer.didConnect === true) {
    this.emit('reconnecting');
  }
};

/**
 * Setup a timer event to attempt reconnect.
 *
 * @api private
 */

Client.prototype.scheduleReconnect = function() {
  var client = this;
  // Just return if no more servers
  if (client.servers.length === 0) {
    return;
  }
  // Don't set reconnecting state if we are just trying
  // for the first time.
  if (client.wasConnected === true) {
    client.reconnecting = true;
  }
  // Only stall if we have connected before.
  var wait = 0;
  if (client.servers[0].didConnect === true) {
    wait = this.options.reconnectTimeWait;
  }
  setTimeout(function() { client.reconnect(); }, wait);
};
