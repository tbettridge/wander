import { resolveNpcReference } from './npcspokenreferences.mjs';

const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'from', 'in', 'it', 'of', 'on', 'the', 'to', 'with']);

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
const normalize = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const personName = value => typeof value === 'string' ? value : value?.name || '';
const personId = value => typeof value === 'string' ? value : value?.id || '';
const placeName = value => typeof value === 'string' ? value : value?.name || '';
const placeId = value => typeof value === 'string' ? value : value?.key || value?.placeId || value?.id || '';

function phrasesFor(offer) {
  const recipient = personName(offer?.recipient);
  const recipientPhrase = recipient.trim().split(/\s+/).length > 1 ? recipient : '';
  return [offer?.title, offer?.id, offer?.jobId, recipientPhrase]
    .map(normalize)
    .filter(value => value.length >= 3);
}

function mentionsPhrase(text, phrase) {
  const haystack = ` ${normalize(text)} `, needle = ` ${normalize(phrase)} `;
  return needle.length > 2 && haystack.includes(needle);
}

function mentionsOffer(text, offer) {
  if (phrasesFor(offer).some(phrase => mentionsPhrase(text, phrase))) return true;
  const titleWords = normalize(offer?.title).split(' ').filter(word => word.length >= 3 && !STOP_WORDS.has(word));
  const playerWords = new Set(normalize(text).split(' '));
  const matched = titleWords.filter(word => playerWords.has(word)).length;
  return titleWords.length === 1 ? matched === 1 : matched >= 2;
}

function localOffers(context) {
  const publicOffers = context?.localOpportunities || context?.courier?.localOpportunities || [];
  const witnessedOffers = context?.offers || context?.courier?.offers || [];
  const offers = [];
  const byId = new Map();
  const add = (offer, own = false) => {
    if (!offer || !(offer.id || offer.jobId) || !offer.title) return;
    const id = offer.id || offer.jobId;
    const enriched = {
      ...offer,
      id,
      jobId: offer.jobId || id,
      sender: offer.sender || (own ? { id: context?.npc?.id, name: context?.npc?.name, place: context?.place } : null),
      destinationName: offer.destinationName || offer.destination || '',
    };
    if (byId.has(id)) {
      const prior = byId.get(id);
      byId.set(id, { ...prior, ...enriched, sender: enriched.sender || prior.sender,
        lastWitnessedState: enriched.lastWitnessedState || prior.lastWitnessedState });
    } else {
      byId.set(id, enriched);
      offers.push(enriched);
    }
  };
  if (Array.isArray(publicOffers)) for (const offer of publicOffers) add(offer);
  // This list contains offers the current sender knows about. It lets a
  // repeated request receive the controller's authoritative rejection after
  // the public board removes an accepted or completed job.
  if (context?.responsibility && context.responsibility !== 'neighbor' && Array.isArray(witnessedOffers)) {
    for (const offer of witnessedOffers) add(offer, true);
  } else if (Array.isArray(witnessedOffers)) {
    for (const offer of witnessedOffers) if (offer?.sender?.id === context?.npc?.id) add(offer);
  }
  return offers;
}

function available(offer) {
  if (offer.available === false) return false;
  const witnessed = String(offer.lastWitnessedState || '').toLocaleLowerCase();
  if (['accepted', 'delivered'].includes(witnessed)) return false;
  return ['offered', 'available', 'declined', ''].includes(String(offer.state || '').toLocaleLowerCase());
}

function isNegativeOrHypothetical(text) {
  const value = normalize(text);
  if (!value) return true;
  if (/^(?:no\b(?!\s+problem)|nah\b|not really\b|maybe\b|perhaps\b|might\b|if\b|what if\b|suppose\b|pretend\b|hypothetically\b|imagine\b|quote\b|quoted\b|say\b|if i said\b)/.test(value)) return true;
  if (/\b(?:what if|suppose|hypothetically|imagine if|if i were to|if i said|unless|but not)\b/.test(value)) return true;
  if (/\b(?:do not|don't|does not|doesn't|did not|didn't|cannot|can't|will not|won't|would not|wouldn't|should not|shouldn't|never|refuse|decline|pass on|not accept|not take|not carry|not deliver)\b/.test(clean(text).toLocaleLowerCase())) return true;
  const quoted = clean(text).match(/"[^\"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g) || [];
  if (quoted.some(part => explicitCommitment(part) || /\b(?:yes|yeah|yep|sure|okay|ok)\b/i.test(part))) return true;
  const trimmed = clean(text);
  if (/^["“‘']/.test(trimmed) && /["”’']$/.test(trimmed)) return true;
  return false;
}

function explicitCommitment(text) {
  const value = normalize(text);
  return /\b(?:i accept|i ll take|i will take|i can take|i am taking|im taking|i ll carry|i will carry|i can carry|i am carrying|im carrying|i ll deliver|i will deliver|i can deliver|i am delivering|im delivering|i ll bring|i will bring|i can bring|i ll do|i will do|count me in|sign me up|let me take|let me carry|let me deliver|happy to take|glad to take|happy to carry|glad to carry|happy to deliver|glad to deliver)\b/.test(value);
}

function affirmative(text) {
  const value = normalize(text);
  return /^(?:yes|yeah|yep|yup|sure|okay|ok|all right|alright|please|absolutely|certainly|sounds good|that works|i agree|i will|i ll|i can|count me in|sign me up)(?:\b|$)/.test(value)
    || /\b(?:i ll take it|i will take it|i can take it|i ll do it|i will do it|i can do it|i accept|count me in|sign me up)\b/.test(value);
}

function isWorkQuestion(text) {
  const value = normalize(text);
  // Conditional or quoted language can mention an errand, but it is not a
  // request for current work and should stay ordinary conversation.
  if (isNegativeOrHypothetical(text)) return false;
  if (isBoardQuestion(text)) return true;
  const courierWords = '(?:work|jobs?|errands?|deliver(?:y|ies)|courier|post|letters?|parcels?|messages?|job board|notice board|postings?|tasks?|help)';
  return new RegExp(`\\b(?:any|anything to do|something to do|looking for|need|want|where|what|who|how|do you know|can you|could you|would you|is there|are there|help me find|tell me about)\\b.{0,100}\\b${courierWords}\\b`).test(value)
    || new RegExp(`\\b${courierWords}\\b.{0,80}\\b(?:available|nearby|around here|around|local|board|start|find|ask|take|do|offer|have)\\b`).test(value)
    || /\b(?:how do i become a courier|how does the post work|where(?:'s| is) the (?:job|notice|public) board|where can i find (?:work|a job|an errand)|what is first post|can i help(?: with anything| around here)?|can i help with anything around here|anything i can do|something i can do|could i help|could use a hand|need a hand)\b/.test(value);
}

function isBoardQuestion(text) {
  const value = normalize(text);
  return /\b(?:where|find|point|show|nearby|near|this place|here)\b.{0,60}\b(?:job|notice|public)?\s*board\b|\b(?:job|notice|public)\s*board\b.{0,60}\b(?:where|find|nearby|near|here)\b/.test(value);
}

function recipientLabel(offer) {
  return personName(offer.recipient) || offer.recipientName || 'the recipient';
}

function senderLabel(offer) {
  return offer.sender?.name || 'the sender';
}

function senderPlaceLabel(offer) {
  if (offer.senderPlaceName || offer.sender?.placeName) return offer.senderPlaceName || offer.sender.placeName;
  return typeof offer.sender?.place === 'object' ? placeName(offer.sender.place) : '';
}

function targetForSender(offer) {
  const id = personId(offer.sender);
  return id || undefined;
}

function targetForBoard(boardTarget) {
  const id = typeof boardTarget === 'string' ? boardTarget : boardTarget?.id;
  return typeof id === 'string' && id ? id : undefined;
}

function jobStatusLine(offer) {
  const state = String(offer.state || '').toLocaleLowerCase();
  if (state === 'active') return `${offer.title} is already underway.`;
  if (state === 'delivered') return `${offer.title} has already been delivered.`;
  if (offer.available === false || !['offered', 'available', 'declined', ''].includes(state)) {
    return `${offer.title} is not available now.`;
  }
  return '';
}

function learnHere(controller, npcId, place) {
  if (typeof controller?.learnReferrals !== 'function') return true;
  const resolvedPlace = place || placeId(controller.contextForNpc?.(npcId)?.place) || controller.placeForNpc?.(npcId);
  const result = controller.learnReferrals(npcId, resolvedPlace);
  return result?.ok === true;
}

function boardName(context) {
  const board = context?.boardTarget || context?.courier?.boardTarget;
  return { board, name: typeof board === 'string' ? 'the nearby public board' : board?.name || 'the nearby public board' };
}

function referralReply(context, npcId, offers, text) {
  const { board, name } = boardName(context);
  const boardRequested = isBoardQuestion(text);
  const sortedOffers = [...offers].sort((a, b) => Number(b.id === 'village-note' && b.local === true)
    - Number(a.id === 'village-note' && a.local === true));
  const ownOffer = sortedOffers.find(offer => personId(offer.sender) === npcId && available(offer));
  const lines = [];
  if (boardRequested) {
    if (board) return { text: `The public job board is at ${name}. It carries the local postings.`, ...(targetForBoard(board) ? { targetId: targetForBoard(board) } : {}) };
    return { text: 'I do not have a reliable location for a public job board to give you.' };
  }
  if (ownOffer) {
    const destination = ownOffer.destinationName ? `, addressed to ${recipientLabel(ownOffer)} at ${ownOffer.destinationName}` : `, for ${recipientLabel(ownOffer)}`;
    lines.push(`I can offer ${ownOffer.title}${destination}.`);
    lines.push('If you would like to carry it, say so here and I can give it to you.');
  }
  const referrals = sortedOffers.filter(offer => available(offer) && personId(offer.sender) !== npcId);
  if (referrals.length) {
    const descriptions = referrals.slice(0, 4).map(offer => {
      const place = senderPlaceLabel(offer);
      return `${offer.title} from ${senderLabel(offer)}${place ? ` at ${place}` : ''}, for ${recipientLabel(offer)}${offer.destinationName ? ` at ${offer.destinationName}` : ''}`;
    });
    lines.push(`Nearby public work includes ${descriptions.join('; ')}.`);
    lines.push('Ask the named sender about the errand; I cannot accept it for them.');
  }
  if (!lines.length) {
    lines.push('First Post carries public letters and local errands when they are posted.');
    if (board) lines.push(`You can check ${name} for current postings.`);
    else lines.push('I do not have a specific public errand to point you toward right now.');
  } else if (board) {
    lines.push(`You can also check ${name} for current postings.`);
  }
  return { text: lines.join(' '), ...(referrals.length && targetForSender(referrals[0]) ? { targetId: targetForSender(referrals[0]) } : {}) };
}

/**
 * Handle only locally grounded courier dialogue and clear acceptances.
 * Ordinary conversation returns null so the normal resident dialogue can answer.
 */
export function handleCourierUtterance(controller, npcId, text, options = {}) {
  let content = clean(text);
  if (!controller || !npcId || !content) return null;
  const requestedPlace = placeId(options.place);
  let context;
  try { context = controller.contextForNpc?.(npcId, requestedPlace ? { place: requestedPlace } : {}); } catch { return null; }
  if (!context) return null;
  const reference = resolveNpcReference({ ...context, courier: context }, content);
  if (['ambiguous', 'unknown'].includes(reference.status)) return { handled: true, reply: { text: reference.clarification } };
  if (reference.status === 'resolved') content = reference.canonicalText;
  const place = placeId(context.place) || requestedPlace || controller.placeForNpc?.(npcId) || '';
  const offers = localOffers(context);
  const namedOffers = offers.filter(offer => mentionsOffer(content, offer));
  const committed = explicitCommitment(content);
  const safe = !isNegativeOrHypothetical(content);

  if (safe && (committed || (affirmative(content) && options.lastAssistantText))) {
    const discussed = offers.filter(offer => options.lastAssistantText && mentionsOffer(options.lastAssistantText, offer));
    const candidates = namedOffers.length ? namedOffers : discussed;
    if (candidates.length > 1) {
      const names = candidates.slice(0, 3).map(offer => offer.title).join(', ');
      return { handled: true, reply: { text: `Which errand do you mean: ${names}?` } };
    }
    if (candidates.length === 1) {
      const offer = candidates[0];
      const status = jobStatusLine(offer);
      if (status) return { handled: true, reply: { text: status }, jobId: offer.id };
      if (!learnHere(controller, npcId, place)) {
        return { handled: true, reply: { text: 'I cannot confirm that this public errand is available here. Please ask its sender directly.' }, jobId: offer.id };
      }
      if (personId(offer.sender) !== npcId) {
        const senderPlace = senderPlaceLabel(offer);
        return { handled: true, reply: { text: `You will need to ask ${senderLabel(offer)} about ${offer.title}${senderPlace ? ` at ${senderPlace}` : ''}.`, ...(targetForSender(offer) ? { targetId: targetForSender(offer) } : {}) }, jobId: offer.id };
      }
      let result;
      try { result = controller.accept(offer.jobId || offer.id, npcId); }
      catch (error) { result = { ok: false, reason: clean(error?.message || 'I could not hand over that errand.') }; }
      if (result?.ok === true && result.applied === true) {
        const next = offer.destinationName ? ` Take it to ${recipientLabel(offer)} at ${offer.destinationName}.` : ` Take it to ${recipientLabel(offer)}.`;
        const receipt = typeof result.message === 'string' && result.message.trim() ? result.message.trim() : `${offer.title} is in your satchel.`;
        return { handled: true, reply: { text: `${receipt}${next}` }, result, jobId: offer.id };
      }
      const failure = result?.reason || result?.message || 'I could not hand over that errand.';
      return { handled: true, reply: { text: failure }, result, jobId: offer.id };
    }
  }

  if (isWorkQuestion(content)) {
    if (!learnHere(controller, npcId, place)) return { handled: true, reply: { text: 'I cannot confirm local courier postings from here. Please check the public board in this place.' } };
    return { handled: true, reply: referralReply(context, npcId, offers, content) };
  }
  return null;
}
