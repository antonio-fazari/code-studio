import dns from './01-dns.js';
import cdn from './02-cdn.js';
import scaling from './03-scaling.js';
import loadBalancing from './04-load-balancing.js';
import caching from './05-caching.js';
import rateLimiting from './06-rate-limiting.js';
import sqlNoSql from './07-sql-nosql.js';
import indexing from './08-indexing.js';
import transactions from './09-distributed-tx.js';
import replication from './10-replication.js';
import sharding from './11-sharding.js';
import consistentHashing from './12-consistent-hashing.js';
import cap from './13-cap.js';
import eventual from './14-eventual.js';
import consensus from './15-consensus.js';
import microservices from './16-microservices.js';
import queues from './17-queues.js';
import idempotency from './18-idempotency.js';
import circuitBreakers from './19-circuit-breakers.js';
import observability from './20-observability.js';

// Order matters: each lesson starts from a problem the previous one left open.
export const lessons = [
  dns, cdn, scaling, loadBalancing, caching, rateLimiting,
  sqlNoSql, indexing, transactions, replication, sharding, consistentHashing,
  cap, eventual, consensus,
  microservices, queues, idempotency, circuitBreakers, observability,
];
