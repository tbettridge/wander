// A small labelled smoke test, not a benchmark of actual player worlds.
// node scripts/evaluate-npc-embeddings.mjs [gateway URL] [report path]
import { writeFile } from 'node:fs/promises';
import { buildNpcNarrativeGraph, retrieveNpcNarrative } from '../src/npcnarrativegraph.mjs';
import { NpcEmbeddingClient } from '../src/npcembeddings.mjs';
import { NpcSemanticRetrieval } from '../src/npcsemanticretrieval.mjs';
import { retrievalQuality } from '../src/npcretrievaldebug.js';

const endpoint = process.argv[2] || 'https://wander-ai.departures-worker.workers.dev';
const outputPath = process.argv[3] || '/private/tmp/wander-live-embedding-evaluation.json';
const sourceFacts = [
  ['repair', 'mira', 'Mira is a wheelwright. She repairs damaged wagons and replaces their wooden wheels.'],
  ['debt', 'oren', 'Oren owes the miller three silver coins and cannot afford to repay the overdue loan.'],
  ['promise', 'alder', 'Alder promised the traveller to deliver a parcel to the mill tomorrow. The delivery is still pending.'],
  ['dispute', 'mira', 'Mira and Oren quarrelled about an unpaid invoice. Since then they have refused to speak to each other.'],
  ['bridge', 'wren', 'Floodwater washed away the eastern footbridge. Travellers must cross the river at the northern ford.'],
  ['medicine', 'wren', 'Wren grows medicinal herbs and prepares remedies for fever and minor wounds.'],
  ['lodging', 'oren', 'Oren rents a spare bedroom above the bakery to travellers who need a place to sleep.'],
  ['lost', 'mira', 'Mira found a brass pocket watch beside the station and gave it to Alder for safekeeping.'],
  ['weather', 'alder', 'A storm is approaching from the west. Heavy rain is expected before sunset.'],
  ['letter', 'wren', 'Wren is a courier who carries letters between Bellwater and Ash Gate.'],
  ['food', 'oren', 'Oren sells fresh bread and hot soup from the bakery each morning.'],
  ['absence', 'mira', 'Mira has been away visiting her ill mother in Ash Gate for the last three days.'],
];
const cases = [
  ['Who could mend a broken cart?', ['repair']],
  ['Has anybody been having money troubles?', ['debt']],
  ['Did you finish the favour you agreed to do for me?', ['promise']],
  ['Why are those neighbours avoiding each other?', ['dispute']],
  ['Can I still get across the river to the east?', ['bridge']],
  ['Where could I get help for a fever?', ['medicine']],
  ['Is there somewhere I can stay overnight?', ['lodging']],
  ['Someone lost a timepiece. Has it turned up?', ['lost']],
  ['Should I find shelter before it gets dark?', ['weather']],
  ['Who can take a message to another village?', ['letter']],
  ['Where can a hungry traveller get breakfast?', ['food']],
  ['Why have we not seen Mira recently?', ['absence']],
];
const graph = buildNpcNarrativeGraph({ revision: 1,
  residents: [['alder', 'Alder', 'station keeper'], ['mira', 'Mira', 'wheelwright'], ['oren', 'Oren', 'baker'], ['wren', 'Wren', 'courier']]
    .map(([id, name, role]) => ({ id, name, role })),
  facts: sourceFacts.map(([id, subjectId, statement]) => ({ id, subjectId, statement, visibility: 'public', privacy: 'public' })),
});
const client = new NpcEmbeddingClient({ endpoint, fetchImpl: (url, options) => fetch(url, {
  ...options, headers: { ...options.headers, Origin: 'https://tbettridge.github.io' },
}) });
const service = new NpcSemanticRetrieval({ client });
const report = { capturedAt: new Date().toISOString(), endpoint, fixture: '12 labelled fictional NPC questions; 16 indexed facts including profiles',
  dimensions: 768, replayDeadlineMs: 12000, gameplayDeadlineMs: 4000, cases: [], indexing: {}, summary: {} };
for (const provider of ['qwen', 'gemini']) {
  try {
    const index = await service.prepare(graph, 'alder', provider);
    report.indexing[provider] = { status: index.status, facts: index.indexed, latencyMs: index.indexingMs, usage: index.usage };
  } catch (error) { report.indexing[provider] = { status: 'unavailable', error: error.message }; }
  console.log(JSON.stringify({ provider, indexing: report.indexing[provider] }));
}
for (const [text, expected] of cases) {
  const request = { speakerId: 'alder', text, maxFacts: 8, maxHops: 2, conversationId: 'live-eval' };
  let baselineFacts;
  retrieveNpcNarrative(graph, { ...request, onRanking: facts => { baselineFacts = facts; } });
  const entry = { text, expected, baseline: { status: 'ready', facts: baselineFacts, quality: retrievalQuality(baselineFacts, expected) } };
  for (const provider of ['qwen', 'gemini']) {
    if (report.indexing[provider].status !== 'ready') { entry[provider] = { status: 'unavailable' }; continue; }
    const result = await service.evaluate(graph, request, provider, { waitForIndex: true, fresh: true, timeoutMs: 12000 });
    entry[provider] = { ...result, packet: undefined, quality: result.status === 'ready' ? retrievalQuality(result.facts, expected) : null };
  }
  report.cases.push(entry);
  console.log(JSON.stringify({ query: text, results: Object.fromEntries(['baseline', 'qwen', 'gemini'].map(provider => [provider, {
    status: entry[provider].status, quality: entry[provider].quality, latencyMs: entry[provider].latencyMs,
  }])) }));
}
for (const provider of ['baseline', 'qwen', 'gemini']) {
  const ready = report.cases.map(entry => entry[provider]).filter(result => result.status === 'ready');
  const latencies = ready.map(result => result.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const average = key => ready.length ? ready.reduce((sum, result) => sum + result.quality[key], 0) / ready.length : null;
  report.summary[provider] = { completed: ready.length, total: cases.length, recallAt8: average('recall'), meanReciprocalRank: average('reciprocalRank'),
    endToEndRecallAt8: ready.reduce((sum, result) => sum + result.quality.recall, 0) / cases.length,
    withinGameplayDeadline: provider === 'baseline' ? ready.length : ready.filter(result => Number.isFinite(result.latencyMs) && result.latencyMs <= 4000).length,
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    ...(provider !== 'baseline' ? { usage: service.totals[provider] } : {}) };
}
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: report.summary, reportPath: outputPath }));
