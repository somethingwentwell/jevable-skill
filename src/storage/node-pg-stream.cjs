// Node-only release bundle transport. Never select a worker adapter from ambient globals.
const net = require('node:net')
const tls = require('node:tls')
exports.getStream = () => new net.Socket()
exports.getSecureStream = options => tls.connect(options)
