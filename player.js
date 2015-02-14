var ok = require('assert').ok
var fs = require('fs')
var path = require('path')
var cadence = require('cadence/redux')

function Player (options) {
    this.directory = options.directory
    this.framer = options.framer
    this.deserializers = options.deserializers
}

// todo: outgoing
Player.prototype.io = cadence(function (async, direction, filename) {
    async(function () {
        fs.open(filename, direction[0], async())
    }, function (fd) {
        async(function () {
            fs.fstat(fd, async())
        }, function (stat) {
            var io = cadence(function (async, buffer, position) {
                var offset = 0

                var length = stat.size - position
                var slice = length < buffer.length ? buffer.slice(0, length) : buffer

                var loop = async(function (count) {
                    if (count < slice.length - offset) {
                        offset += count
                        fs[direction](fd, slice, offset, slice.length - offset, position + offset, async())
                    } else {
                        return [ loop, slice, position ]
                    }
                })(0)
            })
            return [ fd, stat, io ]
        })
    })
})

Player.prototype.read = cadence(function (async, sheaf, page) {
    page.entries = page.ghosts = page.position = 0
    var rotation = 0, loop = async([function () {
        var filename = path.join(this.directory, 'pages', page.address + '.' + rotation)
        this.io('read', filename, async())
    }, function (error) {
        if (rotation === 0 || error.code !== 'ENOENT') {
            throw error
        }
        return [ loop, page ]
    }], function (fd, stat, read) {
        page.rotation = rotation++
        this.play(sheaf, fd, stat, read, page, async())
    })()
})

Player.prototype._play = function (sheaf, slice, start, page) {
    var leaf = page.address % 2 === 1,
        deserialize = leaf ? this.deserializers.record : this.deserializers.key,
        framer = this.framer
    for (var i = 0, I = slice.length; i < I; i += entry.length) {
        var entry = framer.deserialize(deserialize, slice, i, I)
        if (entry == null) {
            return i
        }
        page.position += entry.length
        var header = entry.header
        if (header[1] === 0) {
            page.right = {
                address: header[2],
                key: entry.body || null
            }
            if (header[3] === 0 && page.ghosts) {
                page.splice(0, 1)
                page.ghosts = 0
            }
            page.entries++
        } else {
            ok(header[0] === ++page.entries, 'entry count is off')
            var index = header[1]
            if (leaf) {
                // todo: see if it is faster to perform the slices here directly.
                if (index > 0) {
                    page.splice(index - 1, 0, {
                        key: sheaf.extractor(entry.body),
                        record: entry.body,
                        heft: entry.heft
                    })
                } else if (~index === 0 && page.address !== 1) {
                    ok(!page.ghosts, 'double ghosts')
                    page.ghosts++
                } else if (index < 0) {
                    page.splice(-(index + 1), 1)
                }
            } else {
                var address = header[2], key = null, heft = 0
                if (index - 1) {
                    key = entry.body
                    heft = entry.heft
                }
                page.splice(index - 1, 0, {
                    key: key, address: address, heft: heft
                })
            }
        }
    }
    return i
}

Player.prototype.play = cadence(function (async, sheaf, fd, stat, read, page) {
    var buffer = new Buffer(sheaf.options.readLeafStartLength || 1024 * 1024)
    // todo: really want to register a cleanup without an indent.
    async([function () {
        fs.close(fd, async())
    }], function () {
        var loop = async(function (buffer, position) {
            read(buffer, position, async())
        }, function (slice, start) {
            var offset = this._play(sheaf, slice, start, page)
            if (start + buffer.length < stat.size) {
                if (offset == 0) {
                    buffer = new Buffer(buffer.length * 2)
                    read(buffer, start, async())
                } else {
                    read(buffer, start + offset, async())
                }
            } else {
                return [ loop ]
            }
        })(buffer, 0)
    })
})

module.exports = Player