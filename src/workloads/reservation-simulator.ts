/**
 * Local reservation simulator — authoritative receipts for uncertain writes.
 * Deliberate fault: commit then drop HTTP response.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { IndependentCounters } from '../providers/types';

export type Receipt = {
  receiptId: string;
  idempotencyKey: string;
  resource: string;
  status: 'held' | 'confirmed' | 'denied';
  committedAt: string;
};

type DbShape = { receipts: Receipt[] };

function dbPath(dir: string) {
  return join(dir, 'receipts.json');
}

function loadDb(dir: string): DbShape {
  const p = dbPath(dir);
  if (!existsSync(p)) return { receipts: [] };
  return JSON.parse(readFileSync(p, 'utf8')) as DbShape;
}

function saveDb(dir: string, db: DbShape) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(dbPath(dir), JSON.stringify(db, null, 2) + '\n');
}

export class ReservationSimulator {
  constructor(
    private readonly dataDir: string,
    private readonly counters: IndependentCounters,
    private readonly dropResponseAfterCommit: boolean,
  ) {
    mkdirSync(dataDir, { recursive: true });
  }

  /** Authoritative lookup — independent of agent response. */
  getByIdempotencyKey(key: string): Receipt | undefined {
    return loadDb(this.dataDir).receipts.find((r) => r.idempotencyKey === key);
  }

  list(): Receipt[] {
    return loadDb(this.dataDir).receipts;
  }

  async hold(args: {
    resource: string;
    idempotencyKey: string;
  }): Promise<
    | { ok: true; receipt: Receipt }
    | { ok: false; uncertain: true; message: string }
    | { ok: false; error: string }
  > {
    this.counters.reservationWrites += 1;
    const existing = this.getByIdempotencyKey(args.idempotencyKey);
    if (existing) {
      return { ok: true, receipt: existing };
    }
    const receipt: Receipt = {
      receiptId: `rcpt_${randomUUID().slice(0, 8)}`,
      idempotencyKey: args.idempotencyKey,
      resource: args.resource,
      status: 'held',
      committedAt: new Date().toISOString(),
    };
    const db = loadDb(this.dataDir);
    db.receipts.push(receipt);
    saveDb(this.dataDir, db);
    this.counters.reservationCommits += 1;

    if (this.dropResponseAfterCommit) {
      this.counters.reservationResponseDrops += 1;
      return {
        ok: false,
        uncertain: true,
        message:
          'Write committed but response lost — reconcile via receipt store before retry',
      };
    }
    return { ok: true, receipt };
  }

  async confirm(receiptId: string): Promise<Receipt | undefined> {
    const db = loadDb(this.dataDir);
    const r = db.receipts.find((x) => x.receiptId === receiptId);
    if (!r) return undefined;
    r.status = 'confirmed';
    saveDb(this.dataDir, db);
    return r;
  }

  startHttp(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer(async (req, res) => {
      await this.handle(req, res);
    });
    return new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const p = typeof addr === 'object' && addr ? addr.port : port;
        resolve({
          port: p,
          close: () =>
            new Promise((r, j) => server.close((err) => (err ? j(err) : r()))),
        });
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      const key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      const receipt = this.getByIdempotencyKey(key);
      res.writeHead(receipt ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(receipt ?? { error: 'not_found' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/holds') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as {
        resource?: string;
        idempotencyKey?: string;
      };
      if (!parsed.resource || !parsed.idempotencyKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_ARGS' }));
        return;
      }
      const result = await this.hold({
        resource: parsed.resource,
        idempotencyKey: parsed.idempotencyKey,
      });
      if ('uncertain' in result && result.uncertain) {
        // Simulate dropped response: close without body after commit
        res.destroy();
        return;
      }
      if (!result.ok) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.receipt));
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function receiptFingerprint(r: Receipt): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
}
