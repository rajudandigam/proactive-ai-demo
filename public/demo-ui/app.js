const STAGES = [
  'bind_context',
  'policy_envelope',
  'resolve_deterministic',
  'required_alerts',
  'investigate_agent',
  'validate_result',
  'record_result',
];

const DEFAULT_REQUESTS = {
  'jordan-before-departure': {
    eventId: 'trip-review-001',
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId: 'jordan-before-departure',
    signals: [
      { id: 'preparation-1', type: 'TRIP_PREPARATION' },
      { id: 'weather-1', type: 'WEATHER_UPDATE' },
      { id: 'route-1', type: 'DESTINATION_EVENT' },
      { id: 'search-1', type: 'HOTEL_SEARCH_ABANDONED' },
    ],
  },
  'jordan-arrival-affected': {
    eventId: 'arrival-affected-001',
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId: 'jordan-arrival-affected',
    signals: [{ id: 'route-1', type: 'DESTINATION_EVENT' }],
  },
  'jordan-arrival-unaffected': {
    eventId: 'arrival-unaffected-001',
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId: 'jordan-arrival-unaffected',
    signals: [{ id: 'route-1', type: 'DESTINATION_EVENT' }],
  },
  'jordan-quiet-hours': {
    eventId: 'quiet-001',
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId: 'jordan-quiet-hours',
    signals: [
      { id: 'preparation-1', type: 'TRIP_PREPARATION' },
      { id: 'weather-1', type: 'WEATHER_UPDATE' },
    ],
  },
  'jordan-consent-disabled': {
    eventId: 'consent-001',
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId: 'jordan-consent-disabled',
    signals: [
      { id: 'preparation-1', type: 'TRIP_PREPARATION' },
      { id: 'weather-1', type: 'WEATHER_UPDATE' },
    ],
  },
  'jordan-flight-change': {
    eventId: 'flight-change-001',
    tripId: 'trip-jordan',
    type: 'FLIGHT_CHANGE_CONFIRMED',
    scenarioId: 'jordan-flight-change',
    signals: [
      {
        id: 'flight-change-1',
        type: 'FLIGHT_CHANGE_CONFIRMED',
        claimedSourceVersion: 'flight-status-v2',
      },
    ],
  },
};

let sessionId = null;
let lastRequest = null;
let lastRunId = null;
let config = null;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadConfig() {
  config = await fetch('/demo/config').then((r) => r.json());
  sessionId = config.newSessionId;
  const badge = document.getElementById('modeBadge');
  badge.textContent = config.labels.modeLabel;
  badge.className =
    'badge ' + (config.decisionProvider === 'live' ? 'live' : 'fixture');
  document.getElementById('runMeta').textContent =
    `model=${config.model} · session=${sessionId.slice(0, 8)}…`;
}

async function loadScenarios() {
  const presets = await fetch('/demo/scenarios').then((r) => r.json());
  const sel = document.getElementById('scenarioSelect');
  sel.innerHTML = '';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.scenarioId;
    opt.textContent = p.label || p.scenarioId;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => fillIntake(sel.value));
  if (presets[0]) fillIntake(presets[0].scenarioId);
}

function fillIntake(scenarioId) {
  const req = DEFAULT_REQUESTS[scenarioId] || {
    eventId: `${scenarioId}-001`,
    tripId: 'trip-jordan',
    type: 'TRIP_REVIEW',
    scenarioId,
    signals: [{ id: 'preparation-1', type: 'TRIP_PREPARATION' }],
  };
  document.getElementById('intakeJson').value = JSON.stringify(req, null, 2);
}

function renderGraph(events) {
  const el = document.getElementById('execGraph');
  el.innerHTML = STAGES.map((s) => {
    const hit = [...events].reverse().find((e) => e.stage === s);
    const cls = hit ? `node ${hit.status}` : 'node';
    return `<div class="${cls}">${esc(s)}</div>`;
  }).join('');
}

function renderPolicy(rules) {
  const el = document.getElementById('policyTable');
  if (!rules?.length) {
    el.innerHTML = '<p class="muted">No policy rules yet.</p>';
    return;
  }
  el.innerHTML = `<table><thead><tr><th>Rule</th><th>Observed</th><th>Limit</th><th>Result</th></tr></thead><tbody>${rules
    .map(
      (r) =>
        `<tr><td>${esc(r.id)}</td><td>${esc(r.observed)}</td><td>${esc(r.constraint)}</td><td class="${esc(r.result)}">${esc(r.result)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderAgent(events, result) {
  const el = document.getElementById('agentActivity');
  const lines = events
    .filter((e) =>
      ['model_investigate', 'model_finalize', 'tool', 'agent_fixture', 'investigate_agent'].includes(
        e.stage,
      ),
    )
    .map(
      (e) =>
        `<div class="event-line">[${esc(e.sequence)}] ${esc(e.stage)} · ${esc(e.status)} — ${esc(e.summary)}</div>`,
    );
  const proposal = result?.modelDecisionSet
    ? `<details><summary>Final proposal</summary><pre>${esc(JSON.stringify(result.modelDecisionSet, null, 2))}</pre></details>`
    : '';
  el.innerHTML = lines.join('') + proposal || '<p>Waiting for agent events…</p>';
}

function renderDecisions(result) {
  const el = document.getElementById('decisions');
  if (!result?.decisions?.length) {
    el.innerHTML = '<p>No decisions yet.</p>';
    return;
  }
  el.innerHTML = result.decisions
    .map((d) => {
      const head = `<div class="decision"><strong>${esc(d.outcome)}</strong> · ${esc(d.reason)} · ${esc((d.candidates || []).join(', '))}<div>by ${esc(d.decidedBy)}${d.proposedBy ? ` (proposed: ${esc(d.proposedBy)})` : ''}</div>`;
      if (d.notificationPreview) {
        return `${head}<div class="preview"><strong>Preview</strong><div>${esc(d.notificationPreview.body)}</div></div></div>`;
      }
      if (d.outcome === 'wait') {
        return `${head}<div class="wait">Wait until ${esc(d.recheckAt)}</div></div>`;
      }
      if (d.outcome === 'silent') {
        return `${head}<div class="silent">Stay silent</div></div>`;
      }
      return `${head}</div>`;
    })
    .join('');
}

function renderStats(result, started) {
  const a = result?.accounting || {};
  const usage = a.tokenUsage?.known
    ? `tokens=${a.tokenUsage.total}`
    : 'tokens=unknown';
  document.getElementById('stats').textContent = [
    `runStatus=${result?.runStatus}`,
    `mode=${result?.modelMode}`,
    `liveAttempts=${a.liveAttempts ?? 0}`,
    `liveOk=${a.liveSuccesses ?? 0}`,
    `liveFail=${a.liveFailures ?? 0}`,
    `fixtureInvocations=${a.fixtureInvocations ?? 0}`,
    `tools=${a.toolExecutions ?? 0}`,
    `cacheHits=${a.toolCacheHits ?? 0}`,
    usage,
    `elapsedMs=${Date.now() - started}`,
    `outboxWrites=${result?.outboxWrites ?? 0}`,
  ].join(' · ');
}

async function runOnce(request, { newSession } = {}) {
  if (newSession) {
    const cfg = await fetch('/demo/config').then((r) => r.json());
    sessionId = cfg.newSessionId;
  }
  request = { ...request, sessionId };
  lastRequest = request;
  const started = Date.now();
  document.getElementById('runMeta').textContent = `running… session=${sessionId.slice(0, 8)}…`;

  if (config?.decisionProvider === 'live' && !config.model) {
    alert('LIVE mode configured but model identity missing.');
    return;
  }

  const created = await fetch('/demo/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, sessionId }),
  }).then((r) => r.json());

  lastRunId = created.runId;
  const events = [];
  const es = new EventSource(`/demo/runs/${created.runId}/events`);

  await new Promise((resolve) => {
    es.onmessage = async (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === 'run_complete') {
        es.close();
        const record = await fetch(`/demo/runs/${created.runId}`).then((r) =>
          r.json(),
        );
        renderGraph(events);
        renderPolicy(record.result?.policyRules);
        renderAgent(events, record.result);
        renderDecisions(record.result);
        renderStats(record.result, started);
        document.getElementById('runMeta').textContent =
          `run=${created.runId.slice(0, 8)}… · ${record.status} · session=${sessionId.slice(0, 8)}…`;
        if (record.result?.agentInspectTraceId) {
          document.getElementById('inspectHint').textContent =
            `Trace id: ${record.result.agentInspectTraceId}`;
        }
        resolve();
        return;
      }
      events.push(data);
      renderGraph(events);
      if (data.stage === 'policy_envelope' && data.detail?.rules) {
        // full rules arrive with result
      }
      renderAgent(events, null);
    };
    es.onerror = () => {
      es.close();
      resolve();
    };
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('largeText').addEventListener('change', (e) => {
  document.body.classList.toggle('large', e.target.checked);
});

document.getElementById('runBtn').addEventListener('click', async () => {
  const request = JSON.parse(document.getElementById('intakeJson').value);
  await runOnce(request, { newSession: true });
});

document.getElementById('repeatBtn').addEventListener('click', async () => {
  if (!lastRequest) {
    alert('Run a scenario first.');
    return;
  }
  await runOnce({ ...lastRequest }, { newSession: false });
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  const res = await fetch('/demo/reset', { method: 'POST' }).then((r) => r.json());
  alert(res.message || JSON.stringify(res));
  await loadConfig();
});

(async function init() {
  await loadConfig();
  await loadScenarios();
})();
