const { createMemoryDriver } = require('./sharedStore/memoryDriver');
const { createRedisDriver } = require('./sharedStore/redisDriver');

// One place for the state that must be the SAME for every API instance.
//
// Everything behind this used to be a module-level Map in whichever file
// needed it. That is correct for one container and quietly wrong for two:
//   - every rate limit becomes N times looser, because each instance counts
//     only its own share of the traffic;
//   - a document edit handled by instance A leaves instance B answering from
//     the knowledge it had cached, with no event that would ever clear it;
//   - the "one background job per tenant" locks stop meaning anything, so two
//     instances pay for the same audit or FAQ generation;
//   - alert throttles stop throttling, and the signup wizard's reviewed
//     readiness report is lost whenever /complete lands on the other instance.
//
// The interface is deliberately small and shaped around those four needs, so a
// Redis driver is a drop-in: a sliding-window counter, a claim-once flag, a
// value with a TTL, and a monotonic counter. Choose with SHARED_STORE
// (memory | redis); memory is the default, so a single-container deployment
// needs no extra infrastructure and behaves exactly as it always has.
//
// Every method is async because a networked driver has to be. Callers must
// await, including inside Express middleware — see utils/ipRateLimit.js.

const DRIVERS = {
  memory: createMemoryDriver,
  redis: createRedisDriver
};

let driver = null;

function driverName() {
  return String(process.env.SHARED_STORE || 'memory').trim().toLowerCase() || 'memory';
}

/** The process-wide store, built on first use. */
function store() {
  if (!driver) {
    const name = driverName();
    const make = DRIVERS[name];
    if (!make) {
      throw new Error(`Unknown SHARED_STORE "${name}". Choose one of: ${Object.keys(DRIVERS).join(', ')}`);
    }
    driver = make();
  }
  return driver;
}

/**
 * Drops the built driver so the next call re-reads SHARED_STORE. For tests
 * that exercise more than one driver; not used at runtime.
 */
function resetStore() {
  driver = null;
}

// ── Keyspace. One flat namespace with a prefix per concern, so a Redis
// instance shared with anything else can't collide and keys are greppable.
const keys = {
  rateLimit: (name, subject) => `rl:${name}:${subject}`,
  knowledgeGeneration: (tenantId) => `kg:${tenantId}`,
  alertSession: (tenantId, sessionId) => `al:s:${tenantId}:${sessionId}`,
  alertTenant: (tenantId) => `al:t:${tenantId}`,
  wizardAudit: (contentHash) => `wa:${contentHash}`,
  jobLock: (job, subject) => `lock:${job}:${subject}`,
  // Short-term memory of the product cards shown in a chat session's last
  // product turn, so a follow-up like "link as well" can carry them forward
  // (services/tenantChat.js). Scoped by tenant + session; expires on its own.
  productContext: (tenantId, sessionId) => `pc:${tenantId}:${sessionId}`
};

/**
 * Safe-to-log summary. Deliberately does NOT build the driver: boot logging
 * must not be what fails when REDIS_URL is missing.
 */
function describeSharedStore() {
  const name = driverName();
  return { driver: name, known: Object.prototype.hasOwnProperty.call(DRIVERS, name), shared: name !== 'memory' };
}

module.exports = {
  store, resetStore, resetSharedStore: resetStore, keys, driverName, describeSharedStore, DRIVERS
};
