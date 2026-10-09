export function retrievalQuality(facts, expectedIds) {
  const expected = new Set(expectedIds);
  if (!expected.size) return null;
  const found = facts.filter(fact => expected.has(fact.id)).length;
  const first = facts.findIndex(fact => expected.has(fact.id));
  return { recall: found / expected.size, precision: facts.length ? found / facts.length : 0,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1) };
}

/** Diagnostics stay outside the NPC prompt. No untrusted fact text is HTML. */
export function openNpcRetrievalDebug(service) {
  const existing = document.getElementById('npc-retrieval-debug');
  if (existing) { existing.showModal(); return; }
  const dialog = document.createElement('dialog');
  dialog.id = 'npc-retrieval-debug';
  dialog.style.cssText = 'width:min(1100px,90vw);max-height:85vh;overflow:auto;background:#162025;color:#edf1e8;border:1px solid #61746e;padding:24px;font:14px system-ui;z-index:100';
  const element = (tag, text, parent = dialog) => {
    const node = document.createElement(tag); if (text != null) node.textContent = text;
    parent.append(node); return node;
  };
  element('h2', 'NPC knowledge retrieval comparison');
  element('p', 'Replay runs both embedders against the captured world snapshot. It does not change the NPC reply. Costs and token counts are estimates.');
  const selector = element('select');
  selector.setAttribute('aria-label', 'Captured NPC question');
  const expected = element('input'); expected.placeholder = 'Expected relevant fact IDs, separated by commas';
  expected.setAttribute('aria-label', 'Expected relevant fact IDs');
  expected.style.cssText = 'width:55%;margin:8px;padding:6px';
  const actions = element('div');
  const replay = element('button', 'Replay both providers', actions);
  const score = element('button', 'Score expected facts', actions);
  const download = element('button', 'Download report', actions);
  const close = element('button', 'Close', actions);
  for (const button of actions.children) button.style.cssText = 'margin:6px;padding:8px';
  const status = element('p');
  const columns = element('div'); columns.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px';
  let selectedId = service.runs.at(-1)?.id;
  const render = () => {
    selector.replaceChildren();
    for (const run of [...service.runs].reverse()) {
      const option = element('option', `${run.id}: ${run.query.slice(0, 80)}`, selector);
      option.value = String(run.id);
    }
    if (!service.runs.some(run => run.id === selectedId)) selectedId = service.runs.at(-1)?.id;
    selector.value = String(selectedId);
    const run = service.runs.find(item => item.id === selectedId);
    status.textContent = run ? `Speaker: ${run.speakerId} · revision ${run.worldRevision} · supplied to NPC: ${run.actualProvider}` : 'Ask an NPC a question to capture a lookup.';
    if (run?.staleRevision) status.textContent += ` · world changed to revision ${run.currentWorldRevision}; displayed rankings are the older snapshot`;
    columns.replaceChildren();
    if (!run) return;
    const expectedIds = run.expectedFactIds || [];
    expected.value = expectedIds.join(', ');
    for (const provider of ['baseline', 'qwen', 'gemini']) {
      const column = element('section', null, columns);
      element('h3', provider === 'baseline' ? 'Current graph + words' : provider === 'qwen' ? 'Qwen hybrid' : 'Gemini hybrid', column);
      const result = provider === 'baseline' ? run.baseline : run.replay?.results[provider] || run.results[provider];
      if (!result) { element('p', 'Not evaluated. Use Replay both providers.', column); continue; }
      element('p', `${result.status} · ${Math.round(result.latencyMs)} ms`, column);
      if (provider !== 'baseline') {
        if (Number.isFinite(result.queryLatencyMs)) element('p', `Query embedding: ${Math.round(result.queryLatencyMs)} ms`, column);
        element('p', `${result.indexedFacts}/${result.eligibleFacts} facts indexed · ${result.queryCacheHit ? 'cached query' : 'fresh query'}`, column);
        element('p', `Query: ~${result.estimatedTokens || 0} tokens · ~$${(result.estimatedCostUsd || 0).toFixed(8)}`, column);
        element('p', `Index build: ${Math.round(result.indexingMs || 0)} ms · ~$${(result.indexingUsage?.estimatedCostUsd || 0).toFixed(8)}`, column);
      }
      if (result.error) element('p', result.error, column);
      const facts = result.facts || [];
      const quality = retrievalQuality(facts, expectedIds);
      if (quality) element('p', `Recall: ${(quality.recall * 100).toFixed(0)}% · precision: ${(quality.precision * 100).toFixed(0)}% · reciprocal rank: ${quality.reciprocalRank.toFixed(2)}`, column);
      const list = element('ol', null, column);
      for (const fact of facts) {
        const item = element('li', null, list); item.style.cssText = 'margin-bottom:16px;overflow-wrap:anywhere';
        element('div', fact.statement, item);
        element('small', `${fact.id} · ${fact.access}${Number.isFinite(fact.similarity) ? ` · similarity ${fact.similarity.toFixed(3)}` : ''}`, item);
      }
    }
  };
  selector.onchange = () => { selectedId = Number(selector.value); render(); };
  replay.onclick = async () => {
    replay.disabled = true;
    status.textContent = 'Indexing and replaying the captured question…';
    try { await service.replay(selectedId); render(); }
    catch (error) { status.textContent = error.message; }
    finally { replay.disabled = false; }
  };
  score.onclick = () => {
    const run = service.runs.find(item => item.id === selectedId);
    if (!run) return;
    run.expectedFactIds = [...new Set(expected.value.split(',').map(value => value.trim()).filter(Boolean))];
    render();
  };
  download.onclick = () => {
    const report = service.report();
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'wander-npc-retrieval.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  document.exitPointerLock?.();
  render(); dialog.showModal();
}
