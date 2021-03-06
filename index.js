var events = require('events')
  , mutex = require('level-mutex')
  , uuid = require('node-uuid')
  , byteslice = require('byteslice')
  , util = require('util')
  , events = require('events')
  , sleepref = require('sleep-ref')
  , levelup = require('levelup')
  , noop = function () {}
  ;

function BaseQuery () {}
util.inherits(BaseQuery, events.EventEmitter)
BaseQuery.prototype.map = function (func) {
  var q = new BaseQuery()
    , self = this
    ;
  self.on('row', function (row) {
    q.emit('row', func(row))
  })
  self.on('end', q.end.bind(q))
  self.on('error', q.emit.bind(q, 'error'))
  return q
}
BaseQuery.prototype.filter = function (func) {
  var q = new BaseQuery()
    , self = this
    ;
  self.on('row', function (row) {
    if (func(row)) q.emit('row', row)
  })
  self.on('end', q.end.bind(q))
  self.on('error', q.emit.bind(q, 'error'))
  return q
}
BaseQuery.prototype.reduce = function (func, cb, last) {
  var self = this
  self.on('row', function (row) {
    last = func(last, row)
  })
  self.on('end', function () {
    cb(null, last)
  })
}
BaseQuery.prototype.end = function () {
  this.emit('end')
}


function Query (index, opts, cb) {
  var self = this
  index.mutex.afterWrite(function () {
    self.init(index.mutex.lev.createReadStream(opts))
  })
  this.count = 0
  this.index = index
  if (cb) {
    var results = []
    this.on('row', function (r) {
      results.push(r)
    })
    this.on('end', function () {
      cb(null, results)
    })
    this.on('error', function (e) {
      cb(e)
    })
  }
}
util.inherits(Query, BaseQuery)
Query.prototype.init = function (stream) {
  var self = this
  stream.on('data', function (raw) {
    self.count += 1
    raw.rawkey = raw.key
    raw.key = self.index.bytes.decode(raw.key)[1][0]
    self.emit('row', raw)
  })
  stream.on('end', this.emit.bind(this, 'end'))
}

function Index (lev, name, map, opts) {
  if (typeof lev === 'string') lev = levelup(lev, {keyEncoding:'binary', valueEncoding:'json'})
  this.mutex = mutex(lev)
  this.name = name
  this.map = map
  this.bytes = byteslice([name, 'level-mapreduce'])
  this.opts = opts || {}
  if (!this.opts.id) this.opts.id = function (entry) { return entry.id }
}
util.inherits(Index, events.EventEmitter)
Index.prototype.query = function (opts, cb) {
  if (opts.start) {
    opts.start = this.bytes.encode(['index', [opts.start]])
  } else {
    opts.start = this.bytes.encode(['index', null])
  }
  if (opts.end) {
    opts.end = this.bytes.encode(['index', [opts.end]])
  } else {
    opts.end = this.bytes.encode(['index', {}])
  }

  if (opts.key) {
    opts.start = this.bytes.encode(['index', [opts.key], null])
    opts.end = this.bytes.encode(['index', [opts.key], {}])
    delete opts.key
  }

  return new Query(this, opts, cb)
}
Index.prototype.count = function (cb) {
  var q = this.query({})
    ;
  q.on('end', function ( ){
    cb(null, q.count)
  })
}

Index.prototype.get = function (key, opts, cb) {
  if (!cb) {
    cb = opts
    opts = {}
  }
  var self = this
  // var query =
  //   { start:
  //   , end:
  //   }
  self.mutex.lev.createReadStream()
}
Index.prototype.write = function (entry, ref, tuples, cb) {
  var self = this
    , id = self.opts.id(entry)
    ;

  function saveseq () {
    if (ref && entry.seq) self.mutex.put(self.bytes.encode(['seq', ref]), entry.seq, noop)
  }

  function writeall () {
    var inserts = tuples.map(function (t) { return [['index', [t[0]], uuid()], t[1]] })

    inserts.forEach(function (i) {
      self.mutex.put(self.bytes.encode(i[0]), i[1], noop)
    })
    saveseq()
    self.mutex.put(self.bytes.encode(['id', id]), inserts.map(function (i) {return i[0]}), function (e) {
      if (e) return cb(e)
      cb(null, tuples)
      self.emit('row', {id:id, remote:ref, data:tuples})
    })
  }

  self.mutex.get(self.bytes.encode(['id', id]), function (e, oldwrites) {
    if (e) oldwrites = []
    oldwrites.forEach(function (key) {
      self.mutex.del(self.bytes.encode(key), noop)
    })
    if (!entry.deleted) {
      writeall()
    } else {
      saveseq()
      self.mutex.del(self.bytes.encode(['id', id]), cb)
    }
  })
}
Index.prototype.pull = function (url, cb) {
  var s = sleepref.client(url, {include_data:true})
  this._pull(s, url, cb)
}
Index.prototype._pull = function (sleeper, ref, cb) {
  var self = this
  sleeper.on('entry', function (entry) {
    self.write(entry, ref, self.map(entry), function (e, tuples) {
      if (e) return sleeper.end()
    })
  })
  if (cb) sleeper.on('end', cb)
}
Index.prototype.from = function (getSequences, name, cb) {
  var self = this
  if (!cb) {
    cb = name
    name = null
  }

  function _do (seq) {
    self._pull(getSequences({include_data:true, since:seq}), name, cb)
  }
  if (!name) {
    _do(0)
  } else {
    self.mutex.get(self.bytes.encode(['seq', name]), function (e, seq) {
      if (e) seq = 0
      _do(seq)
    })
  }
}

function AsyncIndex () {
  Index.apply(this, arguments)
}
util.inherits(AsyncIndex, Index)
AsyncIndex.prototype.from = function (nextSequence, name, cb) {
  var self = this
  if (!cb) {
    cb = name
    name = null
  }

  function _do (seq) {
    nextSequence({include_data:true, since:seq}, function (e, entry) {
      if (e) return cb(null)
      self.map(entry, function (e, tuples) {
        if (e) console.error(e)
        self.write(entry, name, tuples, function (e) {
          if (e) console.error(e)
          _do(seq+1)
        })
      })
    })
  }
  if (!name) {
    _do(0)
  } else {
    self.mutex.get(self.bytes.encode(['seq', name]), function (e, seq) {
      if (e) seq = 0
      _do(seq)
    })
  }
}


module.exports = function (lev, name, map, opts) { return new Index(lev, name, map, opts) }
module.exports.async = function (lev, name, map, opts) {return new AsyncIndex(lev, name, map, opts) }
