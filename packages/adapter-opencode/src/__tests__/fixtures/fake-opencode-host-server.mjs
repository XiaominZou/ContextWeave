const http = await import('node:http');

function parsePort(args) {
  const match = args.find((arg) => arg.startsWith('--port='));
  return match ? Number(match.slice('--port='.length)) : 4096;
}

function parseHostname(args) {
  const match = args.find((arg) => arg.startsWith('--hostname='));
  return match ? match.slice('--hostname='.length) : '127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      resolve(data ? JSON.parse(data) : {});
    });
    req.on('error', reject);
  });
}

function visibleTokens(system, text) {
  const source = `${system || ''}\n${text || ''}`;
  const matches = source.match(/[A-Z]+(?:_[A-Z]+)*_TOKEN_\d+/g);
  return matches ?? [];
}

const sessions = new Map();
const args = process.argv.slice(2);
if (!args.includes('serve')) {
  console.error('fake host server only supports serve');
  process.exit(2);
}
const port = parsePort(args);
const hostname = parseHostname(args);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${hostname}:${port}`);

  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req);
    const id = `fake_session_${sessions.size + 1}`;
    sessions.set(id, { id, title: body.title || id });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, title: body.title || id }));
    return;
  }

  const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === 'POST' && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    const body = await readBody(req);
    const text = Array.isArray(body.parts) ? body.parts.find((part) => part.type === 'text')?.text || '' : '';
    const system = typeof body.system === 'string' ? body.system : '';
    const tokens = visibleTokens(system, text);
    const responseText = tokens.length > 0 ? tokens.join(',') : `host:${text}`;
    const toolNameMatch = text.match(/platform_task_[a-z_]+/i);
    const parts = [];
    if (toolNameMatch) {
      parts.push({
        id: 'tool_1',
        type: 'tool',
        callID: 'call_1',
        tool: toolNameMatch[0],
        state: {
          status: 'completed',
          input: { note: 'fake tool call' },
          output: 'ok',
        },
      });
    }
    parts.push({ id: 'text_1', type: 'text', text: responseText });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      info: { id: `msg_${sessionId}`, finish: 'stop' },
      parts,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

server.listen(port, hostname, () => {
  process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
