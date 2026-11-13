// Resolve what a traveller called someone without changing the transcript or
// granting the speaker any new knowledge about that person.
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
const normalized = value => String(value || '').slice(0, 6000).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’]s\b/g, '').replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const boundaryWords = new Set('a an and are at about around back be by can do does for from has have he her here him his how i in is it live lives living looking may me my near now of on or over please she should that the their them there they this to today tomorrow was were what when where who will with work working you'.split(' '));
const personQuestion = text => /\b(?:where|find|looking for|look for|who is|who s|know|about|speak|talk|meet|seen|ask|deliver|delivery|letter|parcel|note|recipient|sender|which way|way to|get to|point|direct|directions|house|home|live|lives|door|visit|see|called|named|give|bring|take|for)\b/.test(normalized(text));
// Words that introduce a thing, not a person: "the hall" is never Hale.
const articles = new Set('the a an this that these those my your our their his its some any no every'.split(' '));
const honorifics = new Set('mr mrs ms miss mister missus master mistress madam sir old young dr doctor'.split(' '));
const values = value => Array.isArray(value) ? value : [];
// Ordinary words a recogniser or a typist produces all the time. They may sit
// one letter from a resident's name (will/Willa, not/Nott), so they are never
// treated as a misheard name.
const commonWords = new Set(`able also always another any anything away because been before being both bring came come could
  day did done down each even ever every find first give goes going gone good got had hello help home house into just keep
  kind know last left let like little long look made make many more most much must name need never new next nice not note
  off often once one only open other our out own part past people place post put quite rather read right road said same
  say see seen send she show side some soon still such sure take tell than thank thanks then these thing think those time
  told too took town try two under until upon use very village want way well went while whom whose why wish would yes yet
  your letter parcel delivery deliver errand job board book train horse walk talk speak meet ask
  yourself myself himself herself themselves ourselves everyone everybody someone somebody anyone anybody nobody
  something nothing everything it him us this that these those here work works business life news weather family
  hall hill hole hull mill inn shop farm field barn lane gate door fire fee few far fair fine full fall fell feel fill
  hello hi hey hail hell heal heel hall dial deal dull doll idea add aid odd line lane lean loan alone bar barn burn
  point which whats lives live get reach visit called named give direct directions`.split(/\s+/));
const genericRoles = new Set(['', 'resident', 'householder', 'neighbor', 'neighbour', 'villager', 'local']);

export function npcReferenceRoster(context = {}) {
  const people = new Map();
  let contact = false, speaker = false;
  const add = person => {
    const id = String(person?.id || person?.subjectId || '').trim().slice(0, 160), name = clean(person?.name);
    if (!id || !name) return;
    const previous = people.get(id);
    const offered = clean(person.role || person.responsibility);
    // Everything someone is known as: the courier's guide is also the village
    // smith, and either description should find them.
    const roles = [...new Set([...(previous?.roles || []), clean(person.responsibility), clean(person.role)]
      .filter(role => role && !genericRoles.has(role.toLowerCase())))].slice(0, 4);
    // A specific responsibility (the trail guide) outranks a census label (resident).
    const role = roles[0] || previous?.role || offered;
    people.set(id, { id, name, role, roles,
      // Someone on the courier's round matters more than a namesake down the lane.
      contact: !!(previous?.contact || contact), speaker: !!(previous?.speaker || speaker),
      place: clean(typeof person.place === 'string' ? person.place : person.place?.name) || previous?.place || '',
      aliases: [...new Set([...(previous?.aliases || []), ...values(person.aliases), ...values(person.nicknames)].map(clean).filter(Boolean))].slice(0, 8) });
  };
  // Courier contacts are useful even when they live beyond the streamed scene.
  contact = true;
  for (const person of values(context.courier?.people || context.people)) add(person);
  for (const offer of [...values(context.courier?.localOpportunities || context.localOpportunities), ...values(context.courier?.offers || context.offers)]) {
    add(offer.sender); add(offer.recipient);
  }
  contact = false;
  for (const person of values(context.homeCommunity?.residents)) add(person);
  for (const person of values(context.personWhereabouts)) add(person);
  for (const person of values(context.social?.relevantPeople)) add(person);
  speaker = true; add(context.npc); speaker = false;
  return [...people.values()].slice(0, 256);
}

export function npcSpeechVocabulary(context, transcript = [], limit = 100) {
  const roster = npcReferenceRoster(context);
  const recent = normalized(transcript.slice(-8).map(turn => turn.content || '').join(' '));
  // The recogniser takes a limited list: names just spoken, then the courier's
  // own contacts, then the person being spoken to, then the rest of the village.
  const priority = person => Number(recent.includes(normalized(person.name))) * 8 + Number(person.contact) * 4 + Number(person.id === context.npc?.id) * 2;
  const prioritized = [...roster].sort((a, b) => priority(b) - priority(a));
  const terms = [...prioritized.map(person => person.name), context.place?.name, context.station?.name,
    ...values(context.targets).map(place => place.name),
    ...values(context.courier?.routes).map(route => route.name),
    ...prioritized.map(person => person.name.split(/\s+/)[0]), ...prioritized.flatMap(person => person.aliases)];
  return [...new Set(terms.map(clean).filter(Boolean))].slice(0, Math.max(1, Math.min(100, limit)));
}

function tokensFor(text) {
  return [...String(text || '').slice(0, 1200).matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu)]
    .map(match => ({ word: normalized(match[0]), start: match.index, end: match.index + match[0].length }));
}

function sound(word) {
  if (!/^[a-z]+$/.test(word)) return '';
  const code = letter => 'bfpv'.includes(letter) ? '1' : 'cgjkqsxz'.includes(letter) ? '2'
    : 'dt'.includes(letter) ? '3' : letter === 'l' ? '4' : 'mn'.includes(letter) ? '5' : letter === 'r' ? '6' : '';
  let result = word[0], previous = code(word[0]);
  for (const letter of word.slice(1)) {
    const next = code(letter);
    if (next && next !== previous) result += next;
    if (!'hw'.includes(letter)) previous = next;
  }
  return result.padEnd(4, '0').slice(0, 4);
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
}

/**
 * How a word is said, roughly: its consonants in order, with spellings that
 * sound alike folded together and vowels dropped. A recogniser that mishears
 * a name nearly always keeps this (Hale/hail/hell, Lina/Leena, Faye/Fay).
 */
function skeleton(word) {
  if (!/^[a-z]+$/.test(word)) return '';
  let w = word.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w')
    .replace(/gh/g, '').replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
    .replace(/(?<=.)[wyh]/g, '').replace(/(.)\1+/g, '$1');
  const lead = /^[aeiou]/.test(w) ? 'a' : '';
  return lead + w.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}
const voiced = { b: 'p', d: 't', g: 'k', v: 'f', j: 's' };
const unvoice = text => text.replace(/[bdgvj]/g, letter => voiced[letter]);

/** How well what was heard matches a name word: 1 exact, about 0.9 sounds the same, 0.85 close, 0 not. */
function wordScore(a, b) {
  if (a === b || (a.length >= 3 && b === a + 's')) return 1; // "Hales house"
  if (Math.min(a.length, b.length) < 3) return 0;
  if (Math.abs(a.length - b.length) > 2) return 0;
  const distance = editDistance(a, b), longest = Math.max(a.length, b.length);
  const ka = skeleton(a), kb = skeleton(b);
  if (ka && ka === kb && a[0] === b[0]) {
    // One or no consonants carries little, so the spelling has to be close too.
    if (ka.length >= 2 || distance <= 2) return distance <= 1 ? 0.94 : 0.92;
  }
  if (sound(a) && sound(a) === sound(b) && distance <= Math.max(1, Math.floor(longest / 4))) return 0.94;
  if (distance === 1 && longest >= 4) return 0.85;
  // Gable/Cable, Barton/Parton: one sound swapped for its voiced twin.
  if (ka && kb && ka.length >= 2 && unvoice(ka) === unvoice(kb) && distance <= 2) return 0.85;
  return 0;
}

// Where a sentence expects a person: "looking for …", "where is …", "ask …".
// A word there was meant as a name even if it is also an everyday word.
function nameSlot(tokens, index) {
  const one = tokens[index - 1]?.word, two = tokens[index - 2]?.word;
  if (['find', 'ask', 'meet', 'visit', 'called', 'named', 'where', 'wheres'].includes(one)) return true;
  if (one === 'for') return ['looking', 'look', 'letter', 'note', 'parcel', 'delivery', 'is', 's', 'this', 'it'].includes(two);
  if (one === 'is' || one === 's') return ['where', 'who'].includes(two);
  if (one === 'to') return ['talk', 'speak', 'way', 'get', 'it', 'this'].includes(two);
  return false;
}
const sameWord = (word, heard) => word === heard || (word.length >= 3 && heard === word + 's');

function nameMatches(person, tokens, fuzzy, known = null) {
  const full = normalized(person.name).split(' ');
  const aliases = [{ words: full, tier: 3 },
    { words: normalized(person.name.replace(/['’]/g, ' ')).split(' '), tier: 3 },
    { words: normalized(person.name.replace(/[-’']/g, '')).split(' '), tier: 3 },
    ...person.aliases.map(alias => ({ words: normalized(alias).split(' '), tier: 2 }))];
  if (full.length > 1) aliases.push({ words: [full[0]], tier: 1 }, { words: [full.at(-1)], tier: 1 });
  let best = null;
  for (const { words, tier } of aliases) for (let start = 0; start <= tokens.length - words.length; start++) {
    const end = start + words.length;
    if (tier === 1 || tier === 2 && words.length === 1) {
      // Do not discard an unfamiliar surname and substitute a local namesake.
      if (tokens[end] && !boundaryWords.has(tokens[end].word) && !commonWords.has(tokens[end].word)) continue;
      if (words[0] === full.at(-1) && start > 0 && !boundaryWords.has(tokens[start - 1].word) && !commonWords.has(tokens[start - 1].word)) continue;
      if (boundaryWords.has(words[0])) continue;
    }
    const scores = words.map((word, index) => {
      const heard = tokens[start + index].word, before = tokens[start + index - 1]?.word;
      // Not a misheard name: an everyday word, a thing ("the hall"), or a word
      // that is exactly somebody else's name (Gable is not a slip for Sable).
      // A full name vouches for its own words: in "hail fallow" the surname
      // shows that "hail" was meant as a name.
      const vouched = nameSlot(tokens, start + index)
        || (words.length > 1 && words.some((other, i) => i !== index && sameWord(other, tokens[start + i].word)));
      const ordinary = !sameWord(word, heard) && (boundaryWords.has(heard) || (known?.has(heard) && skeleton(heard) !== skeleton(word))
        || (!vouched && (commonWords.has(heard) || (index === 0 && articles.has(before)))));
      const score = fuzzy && !ordinary ? wordScore(word, heard) : Number(sameWord(word, heard));
      // An unfamiliar surname might be another real person. Confirm it rather
      // than silently changing it to a similar local surname.
      return tier === 3 && words.length > 1 && index === words.length - 1 && score < 1 ? Math.min(score, 0.85) : score;
    });
    if (scores.some(score => !score)) continue;
    const similarity = Math.min(...scores), score = tier * 10 + similarity;
    if (!best || score > best.score) best = { person, score, similarity, start: tokens[start].start, end: tokens[end - 1].end };
  }
  return best;
}

export function npcReferenceClarification(resolution) {
  const labels = resolution.candidates.slice(0, 3).map(person => person.name + (person.role ? `, the ${person.role}` : ''));
  return labels.length ? `Do you mean ${labels.join(' or ')}?` : 'Who do you mean? Tell me their name, job, or village.';
}

export function resolveNpcReference(context, text, { lastPersonId = null, bindings = new Map() } = {}) {
  const raw = String(text || '').slice(0, 1200), roster = npcReferenceRoster(context), query = normalized(raw);
  // "Mr Fallow" and "old Hale" are just Fallow and Hale.
  const tokens = tokensFor(raw).filter((token, i, all) => !(honorifics.has(token.word) && all[i + 1]));
  const known = new Set(roster.flatMap(person => [person.name, ...person.aliases].flatMap(name => normalized(name).split(' '))));
  const result = (status, matches = [], kind = 'name') => {
    const best = matches[0];
    return { status, candidates: matches.map(match => match.person), kind,
      ...(status === 'resolved' ? { personId: best.person.id, name: best.person.name,
        heard: raw.slice(best.start, best.end), canonicalText: raw.slice(0, best.start) + best.person.name + raw.slice(best.end) } : {}),
      ...(status === 'ambiguous' ? { heard: raw.slice(best.start, best.end),
        clarification: npcReferenceClarification({ candidates: matches.map(match => match.person) }) } : {}) };
  };
  if (!tokens.length) return result('none');
  const exact = roster.map(person => nameMatches(person, tokens, false)).filter(Boolean);
  // Explicit full names beat learned spellings, so an alias never steals a
  // later reference to another real person with that name.
  if (!exact.some(match => match.score >= 31)) for (const [alias, id] of bindings) {
    const person = roster.find(person => person.id === id);
    if (!person) continue;
    const match = nameMatches({ ...person, name: alias, aliases: [] }, tokens, false);
    const following = match && tokens.find(token => token.start >= match.end);
    if (alias.split(' ').length === 1 && following && !boundaryWords.has(following.word)) continue;
    if (match) exact.push({ ...match, person, score: 32 });
  }
  const fuzzy = personQuestion(raw) || tokens.length <= 3 ? roster.map(person => nameMatches(person, tokens, true, known)).filter(Boolean) : [];
  const matches = [...exact, ...fuzzy].sort((a, b) => b.score - a.score || a.person.id.localeCompare(b.person.id));
  if (matches.length) {
    const best = matches[0];
    let selected = [...new Map(matches.filter(match => Math.floor(match.score / 10) === Math.floor(best.score / 10)
      && (best.similarity < 1 || match.similarity >= 0.9)).map(match => [match.person.id, match])).values()];
    // Namesakes: the one on the courier's round is meant, then the person
    // being spoken to; only then is it worth asking.
    const weight = match => Number(match.person.contact) * 2 + Number(match.person.speaker);
    selected.sort((a, b) => weight(b) - weight(a) || b.score - a.score);
    const top = selected.filter(match => weight(match) === weight(selected[0]));
    // (Unless a namesake was named exactly and the contact only sounds like
    // it: Fay Cole is not Faye Barton, so that is still worth asking.)
    if (selected.length > 1 && top.length === 1 && weight(top[0]) > 0
      && selected.every(match => match.similarity <= top[0].similarity)) selected = top;
    // One person fits: take it, even on a near miss. Asking "Do you mean Hale
    // Fallow?" when nobody else could be meant only gets in the way.
    return result(selected.length > 1 ? 'ambiguous' : 'resolved', selected);
  }
  const description = roster.flatMap(person => {
    for (const described of person.roles?.length ? person.roles : [person.role]) {
      const role = normalized(described).split(' ');
      if (!described || boundaryWords.has(normalized(described))) continue;
      for (let start = 1; start <= tokens.length - role.length; start++) {
        if (!role.every((word, i) => word === tokens[start + i].word)) continue;
        // "the guide", and "the trail guide" or "the post dispatcher".
        const the = tokens[start - 1].word === 'the' ? start - 1 : tokens[start - 2]?.word === 'the' && !known.has(tokens[start - 1].word) ? start - 2 : -1;
        if (the >= 0) return [{ person, start: tokens[the].start, end: tokens[start + role.length - 1].end }];
      }
    }
    return [];
  });
  if (description.length && (personQuestion(raw) || tokens.length <= 3)) return result(description.length === 1 ? 'resolved' : 'ambiguous', description, 'description');
  const recipient = raw.match(/\b(?:the )?(?:person (?:receiving|getting) my (?:letter|parcel|package)|recipient(?: of my (?:letter|parcel|package))?)\b/i);
  if (recipient) {
    const courier = context.courier || context;
    const offers = [...values(courier.offers), ...values(courier.localOpportunities)];
    const active = offers.filter(offer => ['active', 'accepted'].includes(offer.state || offer.lastWitnessedState)
      || ['active', 'accepted'].includes(courier.witnessedJobs?.[offer.id]?.state));
    const choices = active.length ? active : offers.filter(offer => !['delivered', 'declined'].includes(offer.state || offer.lastWitnessedState));
    const ids = new Set(choices.flatMap(offer => {
      const name = typeof offer.recipient === 'string' ? offer.recipient : offer.recipient?.name;
      return roster.filter(person => person.id === offer.recipient?.id || normalized(person.name) === normalized(name)).map(person => person.id);
    }));
    const recipients = roster.filter(person => ids.has(person.id)).map(person => ({ person, start: recipient.index, end: recipient.index + recipient[0].length }));
    if (recipients.length) return result(recipients.length === 1 ? 'resolved' : 'ambiguous', recipients, 'recipient');
  }
  if (lastPersonId && personQuestion(raw) && /\b(?:she|he|him|her|they|them|that person)\b/.test(query)) {
    const person = roster.find(person => person.id === lastPersonId);
    const pronoun = raw.match(/\b(?:she|he|him|her|they|them|that person)\b/i);
    if (person && pronoun) return result('resolved', [{ person, start: pronoun.index, end: pronoun.index + pronoun[0].length }], 'pronoun');
  }
  const requested = raw.match(/\b(?:where\s+is|where\s+can\s+i\s+find|who\s+is|(?:tell\s+me|know)\s+about|(?:speak|talk)\s+to|looking\s+for|(?:letter|parcel|delivery)\s+(?:for|to))\s+([^?.,;]+)/i);
  if (requested) {
    const name = normalized(requested[1]).split(/\b(?:now|today|please|currently|at|in|from)\b/)[0].trim();
    const words = name.split(' ');
    const places = [context.place?.name, context.station?.name, ...values(context.targets).map(place => place.name), ...values(context.courier?.routes).map(route => route.name)].filter(Boolean).map(normalized);
    const ordinary = /\b(?:the|a|an|bridge|road|trail|platform|station|train|village|town|tree|mill|cave|lighthouse|forest|well|inn|shop|book|work|job|way|weather|horse|boat|balloon|letter|parcel)\b/;
    // Only something that could be a name is "a name I cannot place":
    // "tell me about yourself" is ordinary talk.
    if (name && words.length <= 3 && !ordinary.test(name) && !words.some(word => boundaryWords.has(word) || commonWords.has(word) || articles.has(word))
      && !places.some(place => place === name || place.includes(name))) return {
      status: 'unknown', candidates: [], heard: requested[1],
      clarification: 'I could not place that name. Can you tell me their full name or what they do?',
    };
  }
  return result('none');
}

export class NpcReferenceSession {
  constructor() { this.lastPersonId = null; this.pending = null; this.bindings = new Map(); }
  resolve(context, text) {
    const query = normalized(text), pending = this.pending;
    if (pending && /^(?:yes|yes please|yeah|yep|correct|that s right|that one|exactly)$/.test(query)) {
      if (pending.resolution.candidates.length !== 1) return pending.resolution;
      const person = pending.resolution.candidates[0];
      if (this.bindings.size >= 32) this.bindings.delete(this.bindings.keys().next().value);
      this.bindings.set(normalized(pending.resolution.heard), person.id);
      this.lastPersonId = person.id; this.pending = null;
      return { status: 'resolved', kind: 'confirmed', candidates: [person], personId: person.id, name: person.name,
        canonicalText: pending.text + ` (${person.name})`, heard: text };
    }
    const resolution = resolveNpcReference(context, text, { lastPersonId: this.lastPersonId, bindings: this.bindings });
    if (resolution.status === 'ambiguous') this.pending = { text, resolution };
    else {
      this.pending = null;
      if (resolution.status === 'resolved') {
        this.lastPersonId = resolution.personId;
        if (pending && pending.resolution.candidates.some(person => person.id === resolution.personId)) {
          if (this.bindings.size >= 32) this.bindings.delete(this.bindings.keys().next().value);
          this.bindings.set(normalized(pending.resolution.heard), resolution.personId);
          resolution.canonicalText = pending.text + ` (${resolution.name})`;
        }
      }
    }
    return resolution;
  }
}
