async function loadCoverage() {
  const el = document.getElementById('coverage');
  try {
    const r = await fetch('/playground/coverage');
    const j = await r.json();
    el.textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    el.textContent = String(e);
  }
}

async function loadScenarios() {
  const suite = document.getElementById('suite').value;
  const sel = document.getElementById('scenario');
  const r = await fetch(`/playground/scenarios?suite=${encodeURIComponent(suite)}`);
  const list = await r.json();
  sel.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.id} — ${s.name}`;
    sel.appendChild(opt);
  }
}

document.getElementById('suite').addEventListener('change', loadScenarios);

document.getElementById('runBtn').addEventListener('click', async () => {
  const scenarioId = document.getElementById('scenario').value;
  const suite = document.getElementById('suite').value;
  document.getElementById('verdicts').textContent = 'Running…';
  document.getElementById('result').textContent = '';
  const r = await fetch('/playground/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId, suite, profile: 'offline' }),
  });
  const j = await r.json();
  document.getElementById('verdicts').textContent = JSON.stringify(
    {
      overall: j.overallVerdict ?? j.overall,
      application: j.applicationVerdict,
      fidelity: j.captureFidelityVerdict,
      contract: j.contractVerdict,
      blocked: j.blockedReason,
    },
    null,
    2,
  );
  document.getElementById('result').textContent = JSON.stringify(j, null, 2);
});

loadCoverage();
loadScenarios();
