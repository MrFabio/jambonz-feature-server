const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_FREESWITCH, 'missing JAMBONES_FREESWITCH env var');

const Srf = require('drachtio-srf');
const srf = new Srf();
const Mrf = require('drachtio-fsmrf');
srf.locals.mrf = new Mrf(srf);
const PORT = process.env.HTTP_PORT || 3000;
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const installSrfLocals = require('./lib/utils/install-srf-locals');
installSrfLocals(srf, logger);

const {
  initLocals,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
} = require('./lib/middleware')(srf, logger);

// HTTP
const express = require('express');
const app = express();
app.locals.logger = logger;
const httpRoutes = require('./lib/http-routes');

const InboundCallSession = require('./lib/session/inbound-call-session');

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  logger.info(`listening for drachtio requests on port ${process.env.DRACHTIO_PORT}`);
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

srf.use('invite', [initLocals, normalizeNumbers, retrieveApplication, invokeWebCallback]);

srf.invite((req, res) => {
  const session = new InboundCallSession(req, res);
  session.exec();
});

// HTTP
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/', httpRoutes);
app.use((err, req, res, next) => {
  logger.error(err, 'burped error');
  res.status(err.status || 500).json({msg: err.message});
});
app.listen(PORT);

logger.info(`listening for HTTP requests on port ${PORT}, serviceUrl is ${srf.locals.serviceUrl}`);

const sessionTracker = require('./lib/session/session-tracker');
setInterval(() => {
  srf.locals.stats.gauge('fs.sip.calls.count', sessionTracker.count);
}, 5000);

// report freeswitch stats periodically
const fsOpts = srf.locals.getFreeswitch();
const mrf = srf.locals.mrf;

async function pollFreeswitch(mrf) {
  const stats = srf.locals.stats;
  const ms = await mrf.connect(fsOpts);
  logger.info({freeswitch: fsOpts}, 'connected to freeswitch for metrics monitoring');
  setInterval(() => {
    try {
      stats.gauge('fs.media.channels.in_use', ms.currentSessions);
      stats.gauge('fs.media.channels.free', ms.maxSessions - ms.currentSessions);
      stats.gauge('fs.media.calls_per_second', ms.cps);
      stats.gauge('fs.media.cpu_idle', ms.cpuIdle);
    }
    catch (err) {
      logger.info(err, 'Error sending media server metrics');
    }
  }, 30000);
}

pollFreeswitch(mrf).catch((err) => logger.error(err, 'Error polling freeswitch'));

module.exports = {srf, logger};
