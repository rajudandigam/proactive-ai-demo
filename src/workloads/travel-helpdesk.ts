import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const requireAdv = createRequire(__filename);
const { getCurrentRunId } = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
};

export type PolicyDoc = {
  sourceId: string;
  title: string;
  version: string;
  hash: string;
  text: string;
};

export type HelpdeskResult = {
  status: 'answered' | 'insufficient' | 'conflict';
  answer?: string;
  citations: Array<{ sourceId: string; version: string; hash: string }>;
  agentInspectRunId?: string;
};

function loadCorpus(): PolicyDoc[] {
  const dir = join(process.cwd(), 'fixtures', 'policy-corpus');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const version = (text.match(/Version:\s*([^\n]+)/)?.[1] ?? '1').trim();
      const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? f).trim();
      return {
        sourceId: f.replace(/\.md$/, ''),
        title,
        version,
        hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
        text,
      };
    });
}

function retrieve(question: string, docs: PolicyDoc[]): PolicyDoc[] {
  const tokens = question
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 4);
  return docs
    .map((d) => ({
      doc: d,
      score: tokens.reduce(
        (n, t) => n + (d.text.toLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.doc);
}

export async function runTravelHelpdesk(
  question: string,
  opts?: { traceDir?: string; executionId?: string; injectConflict?: boolean },
): Promise<HelpdeskResult> {
  return inspectRun(
    'travel-helpdesk',
    async () => {
      const docs = await step.tool('retrieve_policy', async () => {
        const corpus = loadCorpus();
        if (opts?.injectConflict) {
          return [
            ...corpus,
            {
              sourceId: 'conflict-policy',
              title: 'Conflicting quiet hours',
              version: '9.9.9',
              hash: 'deadbeef',
              text: 'Quiet hours never apply. Always notify immediately.',
            },
          ];
        }
        return corpus;
      });

      const hits = retrieve(question, docs);
      if (!hits.length) {
        await observeOutcome('helpdesk_insufficient', {
          expectation: 'no grounded sources',
          status: 'failed',
          method: 'custom',
        });
        return {
          status: 'insufficient' as const,
          citations: [],
          agentInspectRunId: getCurrentRunId(),
        };
      }

      if (opts?.injectConflict && hits.some((h) => h.sourceId === 'conflict-policy')) {
        return {
          status: 'conflict' as const,
          citations: hits.slice(0, 2).map((h) => ({
            sourceId: h.sourceId,
            version: h.version,
            hash: h.hash,
          })),
          agentInspectRunId: getCurrentRunId(),
        };
      }

      const top = hits[0]!;
      const answer = `Based on ${top.sourceId}@${top.version}: ${top.text
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .slice(0, 2)
        .join(' ')}`;

      await observeOutcome('helpdesk_answered', {
        expectation: 'cited local policy answer',
        status: 'passed',
        method: 'custom',
        actual: { sourceId: top.sourceId, hash: top.hash },
      });

      return {
        status: 'answered' as const,
        answer,
        citations: hits.slice(0, 3).map((h) => ({
          sourceId: h.sourceId,
          version: h.version,
          hash: h.hash,
        })),
        agentInspectRunId: getCurrentRunId(),
      };
    },
    {
      silent: true,
      traceDir: opts?.traceDir ?? '.agent-inspect',
      correlationId: opts?.executionId ?? `helpdesk-${Date.now()}`,
      metadata: { workload: 'helpdesk' },
    },
  );
}
