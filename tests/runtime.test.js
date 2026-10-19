import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { errorHandler } from '../src/middlewares/error.js';
import { requestTimeout } from '../src/middlewares/timeout.js';
import { tryCatch } from '../src/utils/tryCatch.js';

test('a late controller failure preserves the timeout response and delegates the error', async () => {
  const app = express();
  app.use(requestTimeout(10));
  const failure = new Error('Late operation failed');
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  app.get('/', tryCatch(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    throw failure;
  }));
  app.use(errorHandler);
  app.use((error, _req, _res, _next) => report(error));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'REQUEST_TIMEOUT');
    assert.equal(await reported, failure);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// A small RESP peer exercises the actual Redis client connection handshake.
function command(buffer) {
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const count = Number(buffer.subarray(1, lineEnd).toString());
  const parts = [];
  let offset = lineEnd + 2;
  for (let i = 0; i < count; i++) {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    const length = Number(buffer.subarray(offset + 1, end).toString());
    if (buffer.length < end + 2 + length + 2) return null;
    parts.push(buffer.subarray(end + 2, end + 2 + length).toString());
    offset = end + 2 + length + 2;
  }
  return { parts, offset };
}

test('Redis accepts concurrent first commands before the connection is ready', { timeout: 10000 }, async () => {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      let parsed;
      while ((parsed = command(pending))) {
        pending = pending.subarray(parsed.offset);
        const name = parsed.parts[0].toLowerCase();
        if (name === 'info') {
          const info = 'redis_version:7.0.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (name === 'quit') socket.end('+OK\r\n');
        else socket.write(name === 'ping' ? '+PONG\r\n' : '+OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { getRedis, closeRedis } from './src/config/redis.js';
    try {
      const redis = getRedis();
      assert.deepEqual(await Promise.all([redis.ping(), redis.ping()]), ['PONG', 'PONG']);
    } finally { await closeRedis(); }
  `], { cwd: new URL('../', import.meta.url), env: {
    ...process.env, NODE_ENV: 'test', APP_ENV: 'development', DELIVERY_MODE: 'mock',
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
    JWT_ACCESS_SECRET: 'runtime-test-access-secret-32-characters',
    OTP_HMAC_SECRET: 'runtime-test-otp-secret-32-characters',
    RATE_LIMIT_REDIS_URL: `redis://127.0.0.1:${server.address().port}`, LOG_LEVEL: 'silent'
  }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000 });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, output);
  } finally {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
