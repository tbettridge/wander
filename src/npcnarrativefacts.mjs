// Pure contracts for turning a NPC's explicit statements about another known
// NPC into conservative, provenance-bearing narrative facts. This module does
// not call a model, consult a clock, mutate world state, or touch rendering.

export const NPC_NARRATIVE_FACTS_VERSION = 1;
export const NPC_NARRATIVE_FACT_LIMIT = 14;

/**
 * The traveller, as a subject the village can hold facts about.
 *
 * The same id the transcript already uses for the player's own turns, so a
 * claim about them and the messages they sent agree on who they are.
 */
export const PLAYER_NARRATIVE_SUBJECT_ID = 'player:local';

// A claim about the traveller must be namespaced. It costs the model one
// prefix and buys a hard, mechanical separation: nothing said in passing to a
// traveller can land in the same key space as a resident's life, and a glance
// at the graph shows exactly what the village believes about the player.
const PLAYER_FACT_KEY = /^traveller\.[a-z0-9.-]+$/;

const CLAIM_KEYS = new Set([
  'subjectId', 'factKey', 'value', 'statement', 'classification', 'evidence', 'visibility',
]);
const EVIDENCE_KEYS = new Set(['messageIndex', 'quote']);
const VISIBILITIES = new Set(['private', 'shared', 'public']);
const RESERVED_FACT_KEYS = /(?:^|[.-])(?:id|kind|type|name|role|tombstone|deleted|residence|location|position|coordinates|household|householdid|home|homekey|building|settlement|itinerary|intransit|activity|health|alive|inventory|access|memberids)(?:$|[.-])/i;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|(?:^|\s)(?:javascript:|data:text\/html)/i;
const UNCERTAIN = /\b(?:maybe|perhaps|possibly|probably|apparently|seem(?:s|ed)?|might|may|could|would|if|unless|suppose|imagine|hypothetical(?:ly)?|rumou?r(?:ed|s| has it)?|allegedly|reportedly|not sure|uncertain|as far as i know|i (?:think|guess|believe|feel|heard)|we (?:think|guess|believe|feel|heard)|you (?:say|said|claim(?:ed)?|told)|someone (?:said|told)|they (?:say|said|claim(?:ed)?)|was told|according to|in my opinion|jok(?:e|ing|ed)|kidding)\b/i;
const HEARSAY = /\b[\p{L}'’-]+\s+(?:says|said|claims|claimed|told me)\b/iu;

/**
 * Normalize untrusted synthesis output into the versioned envelope shape.
 * Invalid claims are retained as null-free plain data only when their basic
 * shape is safe; semantic acceptance is exclusively the validator's job.
 */
export function normalizeNarrativeClaimSynthesis(value) {
  const source = isPlainObject(value) ? value : {};
  const claims = Array.isArray(source.thirdPartyClaims) ? source.thirdPartyClaims : [];
  return {
    version: NPC_NARRATIVE_FACTS_VERSION,
    thirdPartyClaims: claims.slice(0, 64).map(normalizeClaim).filter(Boolean),
  };
}

export function normalizeThirdPartyClaims(value) {
  const envelope = Array.isArray(value) ? { thirdPartyClaims: value } : value;
  return normalizeNarrativeClaimSynthesis(envelope).thirdPartyClaims;
}

/**
 * Validate an untrusted synthesis envelope and produce deterministic proposals.
 * Rejections are data, not exceptions, so one bad model claim cannot suppress
 * independent valid claims. Malformed call-level context still throws.
 */
export function planNpcNarrativeFacts({
  synthesis,
  transcript,
  speaker,
  allowedSubjects,
  narrativeFacts = [],
} = {}) {
  const speakerRecord = normalizePerson(speaker, 'speaker');
  const subjects = normalizeSubjects(allowedSubjects);
  if (!Array.isArray(transcript)) throw new TypeError('transcript must be an array.');
  if (!Array.isArray(narrativeFacts)) throw new TypeError('narrativeFacts must be an array.');

  const rawClaims = isPlainObject(synthesis) && Array.isArray(synthesis.thirdPartyClaims)
    ? synthesis.thirdPartyClaims : [];
  const wrongVersion = !isPlainObject(synthesis)
    || synthesis.version !== NPC_NARRATIVE_FACTS_VERSION;
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  if (wrongVersion) {
    return result([], [{ index: -1, reason: 'invalid-envelope' }]);
  }

  rawClaims.forEach((raw, index) => {
    const rejection = validateClaim(raw, {
      transcript, speaker: speakerRecord, subjects, seen, narrativeFacts,
    });
    if (rejection) {
      rejected.push({ index, reason: rejection });
      return;
    }
    const claim = normalizeClaim(raw);
    const semanticKey = factSemanticKey(claim.subjectId, claim.factKey, claim.value);
    seen.add(semanticKey);
    const conflicts = narrativeFacts
      .filter((fact) => fact?.subjectId === claim.subjectId && fact?.factKey === claim.factKey
        && canonicalValue(fact.value) !== canonicalValue(claim.value)
        && fact?.status !== 'retracted')
      .map((fact) => String(fact.id || ''))
      .filter(Boolean)
      .sort();
    accepted.push(makeProposal(claim, speakerRecord, conflicts));
  });
  return result(accepted, rejected);

  function result(proposals, failures) {
    return clonePlain({
      version: NPC_NARRATIVE_FACTS_VERSION,
      proposals,
      rejected: failures,
    });
  }
}

// Compatibility name emphasizing that validation and planning are one atomic,
// pure boundary operation.
export const validateAndPlanNarrativeClaims = planNpcNarrativeFacts;

/** Apply proposals to array collections without mutating any input. */
export function applyNpcNarrativeFacts({ narrativeFacts = [], receipts = [] } = {}, plan) {
  if (!Array.isArray(narrativeFacts) || !Array.isArray(receipts)) {
    throw new TypeError('narrativeFacts and receipts must be arrays.');
  }
  if (!isPlainObject(plan) || plan.version !== NPC_NARRATIVE_FACTS_VERSION
    || !Array.isArray(plan.proposals)) throw new TypeError('Invalid narrative fact plan.');

  const facts = clonePlain(narrativeFacts);
  const nextReceipts = clonePlain(receipts);
  const byReceipt = new Map(nextReceipts.map((receipt) => [receipt?.id, receipt]));
  const byFact = new Map(facts.map((fact) => [fact?.id, fact]));
  const applied = [];
  const duplicates = [];

  for (const proposal of plan.proposals) {
    validateProposal(proposal);
    const prior = byReceipt.get(proposal.receiptId);
    if (prior) {
      if (prior.factId !== proposal.fact.id || prior.proposalId !== proposal.id) {
        throw new Error(`Narrative fact receipt collision: ${proposal.receiptId}.`);
      }
      duplicates.push(clonePlain(prior));
      continue;
    }
    if (byFact.has(proposal.fact.id)) {
      throw new Error(`Narrative fact ID exists without its receipt: ${proposal.fact.id}.`);
    }

    const fact = clonePlain(proposal.fact);
    if (fact.contradicts.length) {
      for (const conflictId of fact.contradicts) {
        const conflict = byFact.get(conflictId);
        if (conflict && conflict.status !== 'retracted') conflict.status = 'disputed';
      }
    }
    facts.unshift(fact);
    byFact.set(fact.id, fact);
    const receipt = {
      version: NPC_NARRATIVE_FACTS_VERSION,
      id: proposal.receiptId,
      type: 'npc.narrative-fact.accepted',
      proposalId: proposal.id,
      factId: fact.id,
      subjectId: fact.subjectId,
    };
    nextReceipts.push(receipt);
    byReceipt.set(receipt.id, receipt);
    applied.push(clonePlain(receipt));
  }
  return clonePlain({ narrativeFacts: facts, receipts: nextReceipts, applied, duplicates });
}

export const applyNarrativeFactPlan = applyNpcNarrativeFacts;

/**
 * Mark matching facts confirmed by their subject. The caller supplies fact IDs
 * after obtaining authoritative subject consent; this function cannot invent it.
 */
export function confirmNpcNarrativeFacts({ narrativeFacts = [], receipts = [] } = {}, {
  subjectId, factIds,
} = {}) {
  const id = requiredText(subjectId, 'subjectId', 160);
  if (!Array.isArray(narrativeFacts) || !Array.isArray(receipts) || !Array.isArray(factIds)) {
    throw new TypeError('Narrative fact confirmation requires array collections and factIds.');
  }
  const selected = [...new Set(factIds.map((value) => requiredText(value, 'factId', 160)))].sort();
  const facts = clonePlain(narrativeFacts);
  const nextReceipts = clonePlain(receipts);
  const receiptIds = new Set(nextReceipts.map((receipt) => receipt?.id));
  const applied = [];
  for (const factId of selected) {
    const fact = facts.find((candidate) => candidate?.id === factId);
    if (!fact || fact.subjectId !== id) continue;
    const receiptId = `narrative-confirmation:${stableHash(`${id}\u0000${factId}`)}`;
    if (receiptIds.has(receiptId)) continue;
    fact.status = 'confirmed';
    fact.confidence = 1;
    fact.knownBy = [...new Set([...(Array.isArray(fact.knownBy) ? fact.knownBy : []), id])].sort();
    const receipt = {
      version: NPC_NARRATIVE_FACTS_VERSION, id: receiptId,
      type: 'npc.narrative-fact.confirmed', factId, subjectId: id,
    };
    nextReceipts.push(receipt);
    receiptIds.add(receiptId);
    applied.push(clonePlain(receipt));
  }
  return clonePlain({ narrativeFacts: facts, receipts: nextReceipts, applied });
}

/**
 * Project facts known by one target into its bounded memory, newest first.
 * meetingCount and every unrelated memory field are preserved byte-for-value.
 */
export function projectNarrativeFactsToMemory(memory, narrativeFacts, {
  targetNpcId = memory?.npcId,
  limit = NPC_NARRATIVE_FACT_LIMIT,
} = {}) {
  if (!isPlainObject(memory)) throw new TypeError('memory must be a plain object.');
  if (!Array.isArray(narrativeFacts)) throw new TypeError('narrativeFacts must be an array.');
  const target = requiredText(targetNpcId, 'targetNpcId', 160);
  const bound = Number.isInteger(limit) && limit >= 0 ? limit : NPC_NARRATIVE_FACT_LIMIT;
  const projected = [];
  const seen = new Set();
  for (const fact of narrativeFacts) {
    if (!isPlainObject(fact) || !['asserted', 'confirmed', 'disputed'].includes(fact.status)
      || !Array.isArray(fact.knownBy)
      || (fact.subjectId !== target && !fact.knownBy.includes(target))) continue;
    add(fact.statement);
  }
  for (const statement of Array.isArray(memory.npcFacts) ? memory.npcFacts : []) add(statement);
  const result = clonePlain(memory);
  result.npcFacts = projected;
  return result;

  function add(value) {
    if (projected.length >= bound || typeof value !== 'string') return;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, 220).trim();
    const key = text.toLocaleLowerCase();
    if (text && !seen.has(key)) { seen.add(key); projected.push(text); }
  }
}

export const projectNarrativeFactsIntoMemory = projectNarrativeFactsToMemory;

function validateClaim(raw, context) {
  if (!isPlainObject(raw) || !exactKeys(raw, CLAIM_KEYS)) return 'malformed-claim';
  if (!isPlainObject(raw.evidence) || !exactKeys(raw.evidence, EVIDENCE_KEYS)) return 'malformed-evidence';
  const claim = normalizeClaim(raw);
  if (!claim) return 'unsafe-value';
  if (raw.classification !== 'asserted-fact') return 'invalid-classification';
  if (!VISIBILITIES.has(raw.visibility)) return 'invalid-visibility';
  if (RESERVED_FACT_KEYS.test(claim.factKey)) return 'reserved-authoritative-field';
  const subject = context.subjects.get(claim.subjectId);
  if (!subject || subject.id === context.speaker.id) return 'invalid-subject';
  if (claim.subjectId === PLAYER_NARRATIVE_SUBJECT_ID || claim.subjectId.startsWith('player:')) {
    if (!PLAYER_FACT_KEY.test(claim.factKey)) return 'player-fact-key-required';
    // A traveller's business spreads by being passed along a chain of people
    // who trust each other, not by being posted at the station. Capping the
    // visibility is what makes it travel at the speed of gossip.
    if (raw.visibility === 'public') return 'player-visibility-too-broad';
  }
  const message = context.transcript[claim.evidence.messageIndex];
  if (!isPlainObject(message) || message.role !== 'assistant') return 'non-npc-evidence';
  if (message.speakerId !== undefined && message.speakerId !== context.speaker.id) return 'speaker-mismatch';
  if (message.source !== undefined && message.source !== 'edge') return 'non-generated-evidence';
  if (typeof message.content !== 'string' || !message.content.includes(claim.evidence.quote)) {
    return 'evidence-mismatch';
  }
  // The persisted human-readable assertion is evidence, not a model-authored
  // paraphrase. Otherwise an exact but unrelated quote could launder a claim.
  if (claim.statement !== claim.evidence.quote) return 'evidence-mismatch';
  if (!explicitlyNames(claim.evidence.quote, subject)) return 'subject-not-explicit';
  if (claim.evidence.quote.includes('?') || UNCERTAIN.test(claim.evidence.quote)
    || HEARSAY.test(claim.evidence.quote)) return 'non-asserted-evidence';
  const semanticKey = factSemanticKey(claim.subjectId, claim.factKey, claim.value);
  if (context.seen.has(semanticKey)
    || context.narrativeFacts.some((fact) => factSemanticKey(fact?.subjectId, fact?.factKey, fact?.value) === semanticKey)) {
    return 'duplicate';
  }
  return '';
}

function makeProposal(claim, speaker, conflicts) {
  const provenanceKey = `${speaker.id}\u0000${claim.evidence.messageIndex}\u0000${claim.evidence.quote}`;
  const factKey = `${claim.subjectId}\u0000${claim.factKey}\u0000${canonicalValue(claim.value)}\u0000${provenanceKey}`;
  const factId = `narrative-fact:${stableHash(factKey)}`;
  const proposalId = `narrative-proposal:${stableHash(factKey)}`;
  return {
    version: NPC_NARRATIVE_FACTS_VERSION,
    id: proposalId,
    receiptId: `narrative-receipt:${stableHash(proposalId)}`,
    fact: {
      version: NPC_NARRATIVE_FACTS_VERSION,
      id: factId,
      subjectId: claim.subjectId,
      factKey: claim.factKey,
      value: clonePlain(claim.value),
      statement: claim.statement,
      classification: 'asserted-fact',
      status: conflicts.length ? 'disputed' : 'asserted',
      confidence: conflicts.length ? 0.5 : 0.7,
      visibility: claim.visibility,
      knownBy: [speaker.id],
      contradicts: conflicts,
      provenance: {
        speakerId: speaker.id,
        speakerName: speaker.name,
        role: 'assistant',
        messageIndex: claim.evidence.messageIndex,
        quote: claim.evidence.quote,
      },
    },
  };
}

function validateProposal(value) {
  if (!isPlainObject(value) || value.version !== NPC_NARRATIVE_FACTS_VERSION
    || !safeId(value.id) || !safeId(value.receiptId) || !isPlainObject(value.fact)
    || value.fact.version !== NPC_NARRATIVE_FACTS_VERSION || !safeId(value.fact.id)
    || !safeId(value.fact.subjectId) || !safeFactKey(value.fact.factKey)
    || typeof value.fact.statement !== 'string' || UNSAFE_TEXT.test(value.fact.statement)
    || value.fact.classification !== 'asserted-fact'
    || !['asserted', 'disputed'].includes(value.fact.status)
    || !Number.isFinite(value.fact.confidence) || value.fact.confidence < 0 || value.fact.confidence > 1
    || !VISIBILITIES.has(value.fact.visibility) || !Array.isArray(value.fact.knownBy)
    || !value.fact.knownBy.every(safeId) || !Array.isArray(value.fact.contradicts)
    || !value.fact.contradicts.every(safeId) || !isPlainObject(value.fact.provenance)) {
    throw new TypeError('Malformed narrative fact proposal.');
  }
}

function normalizeClaim(value) {
  if (!isPlainObject(value) || !isPlainObject(value.evidence)) return null;
  if (!safeId(value.subjectId) || !safeFactKey(value.factKey)
    || !safeStatement(value.statement) || !safeClaimValue(value.value)
    || !Number.isInteger(value.evidence.messageIndex) || value.evidence.messageIndex < 0
    || !safeStatement(value.evidence.quote, 500)) return null;
  return {
    subjectId: value.subjectId,
    factKey: value.factKey,
    value: clonePlain(value.value),
    statement: value.statement,
    classification: value.classification,
    evidence: {
      messageIndex: value.evidence.messageIndex,
      quote: value.evidence.quote,
    },
    visibility: value.visibility,
  };
}

function normalizeSubjects(values) {
  if (!Array.isArray(values)) throw new TypeError('allowedSubjects must be an array.');
  const result = new Map();
  for (const value of values) {
    const person = normalizePerson(value, 'allowed subject');
    if (result.has(person.id)) throw new TypeError(`Duplicate allowed subject: ${person.id}.`);
    result.set(person.id, person);
  }
  return result;
}

function normalizePerson(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
  return {
    id: requiredText(value.id, `${label}.id`, 160),
    name: requiredText(value.name, `${label}.name`, 120),
    aliases: Array.isArray(value.aliases)
      ? value.aliases.map((item) => requiredText(item, `${label}.alias`, 120)) : [],
  };
}

function explicitlyNames(quote, subject) {
  return [subject.name, ...subject.aliases, subject.id]
    .some((name) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(quote));
}

function safeClaimValue(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1e12;
  return typeof value === 'string' && value.length > 0 && value.length <= 220
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

function safeStatement(value, max = 500) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

function safeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

function safeFactKey(value) {
  return typeof value === 'string' && value.length <= 80 && /^[a-z][a-z0-9.-]*$/.test(value);
}

function requiredText(value, label, max) {
  if (!safeId(value) || value.length > max) throw new TypeError(`${label} is invalid.`);
  return value;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function factSemanticKey(subjectId, factKey, value) {
  return `${String(subjectId || '')}\u0000${String(factKey || '')}\u0000${canonicalValue(value)}`;
}

function canonicalValue(value) {
  return typeof value === 'string' ? `s:${value.toLocaleLowerCase()}` : `${typeof value}:${String(value)}`;
}

// FNV-1a with Math.imul has stable specified 32-bit behaviour in JavaScript.
function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
