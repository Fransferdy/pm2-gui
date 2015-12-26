var fs = require('fs'),
  path = require('path'),
  _ = require('lodash'),
  chalk = require('chalk'),
  ansiHTML = require('ansi-html'),
  totalmem = require('os').totalmem(),
  pidusage = require('pidusage'),
  pm = require('./pm'),
  stat = require('./stat'),
  conf = require('./util/conf'),
  layout = require('./blessed-widget/layout'),
  Log = require('./util/log'),
  defConf;

module.exports = Monitor;

/**
 * Monitor of project monitor web.
 * @param options
 * @returns {Monitor}
 * @constructor
 */
function Monitor(options) {
  if (!(this instanceof Monitor)) {
    return new Monitor(options);
  }

  // Initialize...
  this._init(options);
};

Monitor.ACCEPT_KEYS = ['pm2', 'refresh', 'statsd', 'node', 'log', 'daemonize', 'max_restarts', 'port'];
Monitor.DEF_CONF_FILE = 'pm2-gui.ini';
Monitor.PM2_DAEMON_PROPS = ['DAEMON_RPC_PORT', 'DAEMON_PUB_PORT', 'PM2_LOG_FILE_PATH'];

/**
 * Resolve home path.
 * @param {String} pm2Home
 * @returns {*}
 * @private
 */
Monitor.prototype._resolveHome = function (pm2Home) {
  if (pm2Home && pm2Home.indexOf('~/') == 0) {
    // Get root directory of PM2.
    pm2Home = process.env.PM2_HOME || path.resolve(process.env.HOME || process.env.HOMEPATH, pm2Home.substr(2));

    // Make sure exist.
    if (!pm2Home || !fs.existsSync(pm2Home)) {
      throw new Error('PM2 root can not be located, try to initialize PM2 by executing `pm2 ls` or set environment variable vi `export PM2_HOME=[ROOT]`.');
    }
  }
  return pm2Home;
}

/**
 * Initialize options and configurations.
 * @private
 */
Monitor.prototype._init = function (options) {
  options = options || {};

  defConf = conf.File(options.confFile || path.resolve(__dirname, '..', Monitor.DEF_CONF_FILE)).loadSync().valueOf();
  defConf = _.pick.call(null, defConf, Monitor.ACCEPT_KEYS);

  options = _.pick.apply(options, Monitor.ACCEPT_KEYS).valueOf();
  options = _.defaults(options, defConf);

  options.pm2 = this._resolveHome(options.pm2);
  Log(options.log);

  // Load PM2 config.
  var pm2ConfPath = path.join(options.pm2, 'conf.js'),
    fbMsg = '';
  try {
    options.pm2Conf = require(pm2ConfPath)(options.pm2);
    if (!options.pm2Conf) {
      throw new Error(404);
    }
  } catch (err) {
    fbMsg = 'Can not load PM2 config, the file "' + pm2ConfPath + '" does not exist or empty, fallback to auto-load by pm2 home. ';
    console.warn(fbMsg);
    options.pm2Conf = {
      DAEMON_RPC_PORT: path.resolve(options.pm2, 'rpc.sock'),
      DAEMON_PUB_PORT: path.resolve(options.pm2, 'pub.sock'),
      PM2_LOG_FILE_PATH: path.resolve(options.pm2, 'pm2.log')
    };
  }

  Monitor.PM2_DAEMON_PROPS.forEach(function (prop) {
    var val = options.pm2Conf[prop];
    if (!val || !fs.existsSync(val)) {
      throw new Error(fbMsg + 'Unfortunately ' + (val || prop) + ' can not found, please makesure that your pm2 is running and the home path is correct.');
    }
  });

  // Bind socket.io server to context.
  if (options.sockio) {
    this.sockio = options.sockio;
    delete options.sockio;
  }

  // Bind to context.
  this.options = options;
  Object.freeze(this.options);
};

/**
 * Run socket.io server.
 */
Monitor.prototype.run = function () {
  if (!this._sockio) {
    return;
  }

  this._noClient = true;

  this._tails = {};
  this._usages = {};

  // Observe PM2
  this._observePM2();

  // Listen connection event.
  this._sockio.of(conf.NSP.SYS).on('connection', this._connectSysSock.bind(this));
  this._sockio.of(conf.NSP.LOG).on('connection', this._connectLogSock.bind(this));
  this._sockio.of(conf.NSP.PROC).on('connection', this._connectProcSock.bind(this));
};

/**
 * Quit monitor.
 * @return {[type]} [description]
 */
Monitor.prototype.quit = function () {
  console.debug('Closing pm2 pub emitter socket.');
  this.pm2Sock && this.pm2Sock.close();
  console.debug('Closing socket.io server.');
  this._sockio.close();
  console.debug('Destroying tails.');
  this._killTailProcess();
};

/**
 * Monitor dashboard.
 */
Monitor.prototype.dashboard = function () {
  Log({
    level: 1000
  });
  // Socket.io server.
  var port = this.options.port;
  this.sockio = require('socket.io')();
  this._sockio.listen(port);
  this.run();

  // Render screen.
  layout({
    port: port
  }).render();
};

/**
 * Connection event of `sys` namespace.
 * @param {Socket} socket
 * @private
 */
Monitor.prototype._connectSysSock = function (socket) {
  var self = this;
  // Still has one client connects to server at least.
  this._noClient = false;

  socket.on('disconnect', function () {
    // Check connecting client.
    self._noClient = self._sockio.of(conf.NSP.SYS).sockets.length == 0;
  });

  // Trigger actions of process.
  socket.on('action', function (action, id) {
    console.info('[' + id + ']', action, 'sending to pm2 daemon...');
    pm.action(self.options.pm2Conf.DAEMON_RPC_PORT, action, id, function (err, forceRefresh) {
      if (err) {
        console.error(action, err.message);
        return socket.emit('action', id, err.message);
      }
      console.info('[' + id + ']', action, 'completed!');
      forceRefresh && self._throttleRefresh();
    });
  });

  // Get PM2 version and return it to client.
  this._pm2Ver(socket);

  // If processes have been fetched, emit the last to current client.
  this._procs && socket.emit(typeof this._procs == 'string' ? 'info' : 'procs', this._procs);
  // If sysStat have been fetched, emit the last to current client.
  this._sysStat && this._broadcast('system_stat', this._sysStat);

  // Grep system states once and again.
  (this._status != 'R') && this._nextTick(this.options.refresh || 5000);
  console.info('SYS socket connected!');
};

/**
 * Connection event of `log` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectLogSock = function (socket) {
  var self = this;

  // Emit error.
  function emitError(err, pm_id, keepANSI) {
    var data = {
      pm_id: pm_id,
      msg: keepANSI ? chalk.red(err.message) : '<span style="color: #ff0000">Error: ' + err.message + '</span>'
    };
    self._broadcast.call(self, 'log', data, conf.NSP.LOG);
  }

  function startTailProcess(pm_id, keepANSI) {
    socket._pm_id = pm_id;

    if (self._tails[pm_id]) {
      return;
    }

    // Tail logs.
    pm.tail({
      sockPath: self.options.pm2Conf.DAEMON_RPC_PORT,
      logPath: self.options.pm2Conf.PM2_LOG_FILE_PATH,
      pm_id: pm_id
    }, function (err, lines) {
      if (err) {
        return emitError(err, pm_id, keepANSI);
      }
      // Emit logs to clients.
      var data = {
        pm_id: pm_id,
        msg: lines.map(function (line) {
          if (!keepANSI) {
            line = line.replace(/\s/, '&nbsp;');
            return '<span>' + ansiHTML(line) + '</span>';
          } else {
            return line;
          }
        }).join(keepANSI ? '\n' : '')
      };
      self._broadcast.call(self, 'log', data, conf.NSP.LOG);
    }, function (err, tails) {
      if (err) {
        return emitError(err, pm_id, keepANSI);
      }

      console.info('[' + pm_id + ']', 'tail starting...');
      self._tails[pm_id] = tails;
    });
  }

  socket.on('disconnect', self._killTailProcess.bind(self));
  socket.on('tail_kill', self._killTailProcess.bind(self));
  socket.on('tail', startTailProcess);
  console.info('LOG socket connected!');
};

/**
 * Connection event of `proc` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectProcSock = function (socket) {
  var self = this;
  // Emit error.
  function emitError(err, pid) {
    var data = {
      pid: pid,
      msg: '<span style="color: #ff0000">Error: ' + err.message + '</span>'
    };
    self._broadcast.call(self, 'proc', data, conf.NSP.PROC);
  }

  function killObserver() {
    var socks = self._sockio.of(conf.NSP.PROC).sockets,
      canNotBeDeleted = {};
    if (socks && socks.length > 0) {
      socks.forEach(function (sock) {
        canNotBeDeleted[sock.pid.toString()] = 1;
      });
    }

    for (var pid in this._usages) {
      var timer;
      if (!canNotBeDeleted[pid] && (timer = this._usages[pid])) {
        clearInterval(timer);
        delete this._usages[pid];
        console.info('[' + pid + ']', 'cpu and memory observer destroyed!');
      }
    }
  }

  function runObserver(pid) {
    socket._pid = pid;

    var pidStr = pid.toString();
    if (self._usages[pidStr]) {
      return;
    }

    console.info('[' + pidStr + ']', 'cpu and memory observer is running...');

    function runTimer() {
      pidusage.stat(pid, function (err, stat) {
        if (err) {
          clearInterval(ctx._usages[pidStr]);
          delete ctx._usages[pidStr];
          return emitError.call(self, err, pid);
        }
        stat.memory = stat.memory * 100 / totalmem;

        var data = {
          pid: pid,
          time: Date.now(),
          usage: stat
        };
        self._broadcast.call(self, 'proc', data, conf.NSP.PROC);
      });
    }

    self._usages[pidStr] = setInterval(runTimer, 3000);
    runTimer(this);
  }

  socket.on('disconnect', killObserver);
  socket.on('proc', runObserver);
  console.info('PROC socket connected!');
};

/**
 * Grep system state loop
 * @param {Number} tick
 * @private
 */
Monitor.prototype._nextTick = function (tick, continuously) {
  // Return it if worker is running.
  if (this._status == 'R' && !continuously) {
    return;
  }
  // Running
  this._status = 'R';
  console.debug('monitor heartbeat per', tick + 'ms');
  // Grep system state
  this._systemStat(function () {
    // If there still has any client, grep again after `tick` ms.
    if (!this._noClient) {
      return setTimeout(this._nextTick.bind(this, tick, true), tick);
    }
    // Stop
    delete this._status;
    console.debug('monitor heartbeat destroyed!');
  });
};

/**
 * Grep system states.
 * @param {Function} cb
 * @private
 */
Monitor.prototype._systemStat = function (cb) {
  stat.cpuUsage(function (err, cpu_usage) {
    if (err) {
      // Log only.
      console.error('Can not load system/cpu/memory information: ', err.message);
    } else {
      // System states.
      this._sysStat = _.defaults(_(stat).pick('cpus', 'arch', 'hostname', 'platform', 'release', 'uptime', 'memory').clone(), {
        cpu: cpu_usage
      });
      this._broadcast.call(this, 'system_stat', this._sysStat);
    }
    cb.call(this);
  }, this);
};

/**
 * Observe PM2
 * @private
 */
Monitor.prototype._observePM2 = function () {
  var pm2Daemon = this.options.pm2Conf.DAEMON_PUB_PORT;
  console.info('Connecting to pm2 daemon:', pm2Daemon);
  this.pm2Sock = pm.sub(pm2Daemon, function (data) {
    console.info(chalk.magenta(data.event), data.process.name + '-' + data.process.pm_id);
    this._throttleRefresh();
  }, this);

  // Enforce a refresh operation if RPC is not online.
  this._throttleRefresh();
};

/**
 * Throttle the refresh behavior to avoid refresh bomb
 * @private
 */
Monitor.prototype._throttleRefresh = function () {
  if (this._throttle) {
    clearTimeout(this._throttle);
  }
  this._throttle = setTimeout(function (ctx) {
    ctx._throttle = null;
    ctx._refreshProcs();
  }, 500, this);
};

/**
 * Refresh processes
 * @private
 */
Monitor.prototype._refreshProcs = function () {
  pm.list(this.options.pm2Conf.DAEMON_RPC_PORT, function (err, procs) {
    if (err) {
      return this._broadcast('info', 'Can not connect to pm2 daemon, ' + err.message);
    }
    // Wrap processes and cache them.
    this._procs = procs.map(function (proc) {
      proc.pm2_env = proc.pm2_env || {
        USER: 'UNKNOWN'
      };
      var pm2_env = {
        user: proc.pm2_env.USER
      };

      for (var key in proc.pm2_env) {
        // Ignore useless fields.
        if (key.slice(0, 1) == '_' ||
          key.indexOf('axm_') == 0 || !!~['versioning', 'command'].indexOf(key) ||
          key.charCodeAt(0) <= 90) {
          continue;
        }
        pm2_env[key] = proc.pm2_env[key];
      }
      proc.pm2_env = pm2_env;
      return proc;
    });
    // Emit to client.
    this._broadcast('procs', this._procs);
  }, this)
};

/**
 * Get PM2 version and return it to client.
 * @private
 */
Monitor.prototype._pm2Ver = function (socket) {
  var pm2RPC = this.options.pm2Conf.DAEMON_RPC_PORT;
  console.info('Fetching pm2 version:', pm2RPC);
  pm.version(pm2RPC, function (err, version) {
    socket.emit('pm2_ver', (err || !version) ? '0.0.0' : version);
  });
};

/**
 * Broadcast to all connected clients.
 * @param {String} event
 * @param {Object} data
 * @param {String} nsp
 * @private
 */
Monitor.prototype._broadcast = function (event, data, nsp) {
  this._sockio.of(nsp || conf.NSP.SYS).emit(event, data);
};

/**
 * Destroy tails.
 * @param  {Number} pm_id
 * @return {[type]}
 */
Monitor.prototype._killTailProcess = function (pm_id) {
  var self = this;

  function killTail(id) {
    self._tails[id].forEach(function (tail) {
      try {
        tail.kill('SIGTERM');
      } catch (err) {}
    });
    delete self._tails[id];
    console.info('[' + id + ']', 'tail destroyed!');
  }
  if (!isNaN(pm_id)) {
    return killTail(pm_id);
  }
  var socks = self._sockio.of(conf.NSP.LOG).sockets,
    canNotBeDeleted = {};
  if (socks && socks.length > 0) {
    socks.forEach(function (sock) {
      canNotBeDeleted[sock._pm_id] = 1;
    });
  }

  for (var pm_id in self._tails) {
    if (!canNotBeDeleted[pm_id]) {
      killTail(pm_id);
    }
  }
};

Object.defineProperty(Monitor.prototype, 'sockio', {
  set: function (io) {
    if (this._sockio) {
      this._sockio.close();
    }
    this._sockio = io;
    this._sockio.use(function(socket, next){
      // console.log(socket.handshake);
      next();
    })
  },
  get: function () {
    return this._sockio;
  }
});