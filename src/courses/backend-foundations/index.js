import indexes from './01-indexes.js';
import transactions from './02-transactions.js';
import idempotency from './03-idempotency.js';
import pooling from './04-pooling.js';
import caching from './05-caching.js';
import queues from './06-queues.js';
import rateLimiting from './07-rate-limiting.js';
import auth from './08-auth.js';
import pagination from './09-pagination.js';
import retries from './10-retries.js';
import observability from './11-observability.js';
import docker from './12-docker.js';

// Order matters: each lesson starts from a problem the previous one left open.
export const lessons = [indexes, transactions, idempotency, pooling, caching, queues, rateLimiting, auth, pagination, retries, observability, docker];
