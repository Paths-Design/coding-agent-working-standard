'use strict';

// Component-level offline probe only. It uses real pinned Qwen provider and
// decision functions but a private loopback fixture, not an ACP session or model.
// A caller must supervise the process; an event-loop timer cannot bound sync I/O.
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setTimeout, clearTimeout } = require('node:timers');
const { verifyHostTree } = require('./native-qualification-host-tree.cjs');

async function probe(root, digest) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('Invalid host root');
  const before = verifyHostTree(root, digest);
  if (require(path.join(root, '@qwen-code/qwen-code/package.json')).version !== '0.21.14')
    throw new Error('Unexpected host version');
  const chunks = path.join(root, '@qwen-code/qwen-code/chunks');
  const { RequiredExternalToolGuard } = await import(
    pathToFileURL(path.join(chunks, 'external-tool-guard-provider-TE4DRY36.js')).href
  );
  const { evaluateToolInvocationGuard } = await import(
    pathToFileURL(path.join(chunks, 'chunk-OFTPCOGR.js')).href
  );
  if (
    typeof RequiredExternalToolGuard !== 'function' ||
    typeof evaluateToolInvocationGuard !== 'function'
  )
    throw new Error('Missing managed guard components');
  const token = randomBytes(32).toString('hex');
  let mode = 'allow',
    requestCount = 0,
    allBoundArguments = true;
  const server = http.createServer((request, response) => {
    const pieces = [];
    let received = 0;
    request.on('error', () => {});
    request.on('data', (bytes) => {
      received += bytes.length;
      if (received > 65536) request.destroy();
      else pieces.push(bytes);
    });
    request.on('end', () => {
      try {
        if (request.headers.authorization !== 'Bearer ' + token)
          throw new Error('Bad fixture token');
        const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/handshake') {
          if (
            body.protocolVersion !== 1 ||
            body.client !== 'qwen-code' ||
            typeof body.nonce !== 'string'
          )
            throw new Error('Invalid fixture handshake');
          response.end(
            JSON.stringify({
              protocolVersion: 1,
              nonce: body.nonce,
              capabilities: { prepare: true },
            })
          );
          return;
        }
        if (request.url !== '/v1/prepare') throw new Error('Unexpected fixture request');
        requestCount++;
        allBoundArguments &&=
          body.protocolVersion === 1 &&
          typeof body.requestId === 'string' &&
          body.sessionId === 'fixture-session' &&
          body.promptId === 'fixture-prompt' &&
          body.toolCallId === 'fixture-call' &&
          body.toolName === 'write_file' &&
          body.arguments?.file_path === '/fixture/allowed' &&
          Object.keys(body).sort().join(',') ===
            'arguments,promptId,protocolVersion,requestId,sessionId,toolCallId,toolName';
        if (mode === 'timeout') return;
        if (mode === 'http-error') {
          response.statusCode = 500;
          response.end('{}');
          return;
        }
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            requestId: mode === 'mismatch' ? 'wrong-id' : body.requestId,
            allowed: mode === 'allow',
          })
        );
      } catch {
        response.statusCode = 400;
        response.end('{}');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const provider = new RequiredExternalToolGuard({
      endpoint: 'http://127.0.0.1:' + port,
      token,
      timeoutMs: 100,
    });
    await provider.initialize();
    const signal = new globalThis.AbortController().signal;
    const context = {
      callId: 'fixture-call',
      toolName: 'write_file',
      args: { file_path: '/fixture/allowed' },
      signal,
      sessionId: 'fixture-session',
      cwd: '/fixture',
    };
    const guard = (input) =>
      provider.prepare({
        sessionId: input.sessionId,
        promptId: 'fixture-prompt',
        toolCallId: input.callId,
        toolName: input.toolName,
        arguments: input.args,
      });
    const decisions = {};
    for (const selected of ['allow', 'deny', 'mismatch', 'http-error', 'timeout']) {
      mode = selected;
      decisions[selected] = (await evaluateToolInvocationGuard(guard, context)).allowed;
    }
    const cancelled = new globalThis.AbortController();
    cancelled.abort();
    decisions.cancelled = (
      await evaluateToolInvocationGuard(guard, { ...context, signal: cancelled.signal })
    ).allowed;
    const after = verifyHostTree(root, digest);
    const passed =
      requestCount === 5 &&
      allBoundArguments &&
      decisions.allow === true &&
      ['deny', 'mismatch', 'http-error', 'timeout', 'cancelled'].every(
        (key) => decisions[key] === false
      );
    return {
      schema: 'caws.qualification.qwen-managed-guard.v1',
      hostTreeDigest: before.digest,
      hostTreeReadback: after.digest,
      nodeVersion: process.version,
      boundary: 'real-provider-and-evaluator-with-loopback-fixture',
      requestCount,
      allBoundArguments,
      decisions,
      passed,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  process.exitCode = 2;
  const [root, digest, ...extra] = process.argv.slice(2);
  if (!root || !digest || extra.length || process.execArgv.length || process.env.NODE_OPTIONS) {
    process.stderr.write('Expected a fresh process, absolute host tree and digest\n');
  } else {
    const timer = setTimeout(() => {
      process.stderr.write('Managed guard component probe did not settle\n');
      process.exit(2);
    }, 5000);
    probe(root, digest).then(
      (result) => {
        clearTimeout(timer);
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exitCode = result.passed ? 0 : 1;
      },
      (error) => {
        clearTimeout(timer);
        process.stderr.write('Managed guard component probe incomplete: ' + String(error) + '\n');
        process.exitCode = 2;
      }
    );
  }
}
