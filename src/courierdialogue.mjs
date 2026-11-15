import { resolveNpcReference } from './npcspokenreferences.mjs';
import { PARTING, WELCOME_OFFER_STEP, WELCOME_PARTING, goodbyeIntent, skipIntent } from './courierwelcome.mjs';

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


// --- Delivering and taking work in conversation --------------------------
// The courier can hand a parcel over by saying so ("I've got something for
// you", "here's your letter"), and answer an offered job by saying yes or no
// in their own words, typed or spoken. The book still works for both.

const CARGO = '(?:package|parcel|letter|post|mail|delivery|envelope|basket|cup|manuscript|catalog|catalogue|seeds|note|something|this|it)';
function deliverIntent(text, delivery) {
  const value = normalize(text);
  if (!value) return false;
  if (mentionsOffer(text, delivery)) return true;
  return new RegExp(`\\b(?:got|have|brought|bring|bringing|carrying|delivering|deliver|dropping off)\\b.{0,40}\\b${CARGO}\\b.{0,20}\\b(?:for you|for ya|to you)\\b`).test(value)
    || new RegExp(`\\b${CARGO}\\b.{0,30}\\b(?:for you|for ya|from)\\b`).test(value)
    || new RegExp(`\\b(?:brought|bring|got|have)\\s+(?:you|ya)\\b.{0,25}\\b${CARGO}\\b`).test(value)
    || /\b(?:this is for you|here you go|here you are|here it is|that s for you|delivery for you|post for you|mail for you)\b/.test(value)
    || /\b(?:i m|i am|im) (?:here )?(?:with|delivering|dropping off)\b/.test(value)
    || (delivery?.unaddressed && foundIntent(text));
}
/** "I found a letter: is it yours?" */
function foundIntent(text) {
  const value = normalize(text);
  return /\b(?:is (?:this|it) yours|this yours|yours\b.{0,10}\?|belong to you|whose (?:letter|is this)|found (?:a|this|some) (?:letter|envelope|note))/.test(value)
    || /\b(?:found|picked up)\b.{0,30}\b(?:letter|envelope|note)\b/.test(value);
}
function notMineLine(controller, npcId, found) {
  const here = controller.placeForNpc?.(npcId), there = controller.placeOf(found.recipient);
  const initial = String(controller.npc(found.recipient)?.name || '').charAt(0).toUpperCase();
  const samePlace = here && there && (controller.place(here)?.id || here) === (controller.place(there)?.id || there);
  return 'They look it over. “Not mine. ' + (samePlace ? 'But ‘My dear ' + initial + '…’? That sounds like someone here. Keep asking.”'
    : 'And not from round here, I would guess. Does it say where it was going?”');
}
function acceptIntent(text) {
  const value = normalize(text);
  return affirmative(text) || explicitCommitment(text)
    || /\b(?:happy to|glad to|of course|why not|sounds good|sure thing|definitely|absolutely|go on then|i can do that|i could do that|no problem|leave it with me|hand it over|give it here)\b/.test(value);
}
function declineIntent(text) {
  const value = normalize(text);
  return /^(?:no|nah|nope|not now|not right now|not today|sorry|maybe later|another time|no thanks|no thank you|i ll pass|pass)\b/.test(value)
    || /\b(?:i can t|cannot|can t take|too busy|no time|not able|rather not|not this time|some other time)\b/.test(value);
}

/** "Have you any packages?", "Is there any work?", "Anything that needs delivering?" */
export function askWorkIntent(text) {
  const value = normalize(text);
  if (!value || /\bfor (?:you|ya)\b/.test(value)) return false;
  return /\b(?:any|got|have|has)\b.{0,30}\b(?:packages?|parcels?|letters?|post|mail|deliveries|delivery|errands?|work|jobs?)\b/.test(value)
    || /\b(?:anything|something)\b.{0,30}\b(?:deliver|delivering|delivered|carry|carried|carrying|take|taken|send|sent|sending)\b/.test(value)
    || /\bwhat (?:work|jobs|errands|deliveries|post)\b/.test(value)
    || /\b(?:looking for|need|want) (?:some )?(?:work|a job|an errand|a delivery|deliveries)\b/.test(value);
}
/**
 * Asked what they have to send: the parcel itself, with the yes or no held
 * out, or a plain answer that there is nothing, and where to look instead.
 */
export function courierWorkReply(controller, npcId) {
  const state = id => controller.story?.jobs?.[id]?.state;
  const mine = controller.jobs().filter(job => controller.npc(job.sender)?.id === npcId);
  const open = mine.filter(job => ['offered', 'returned'].includes(state(job.id)));
  const offer = open[0] || mine.find(job => state(job.id) === 'declined');
  if (offer) {
    controller.pendingOffers?.set(npcId, { jobId: offer.id });
    const recipient = controller.npc(offer.recipient), place = controller.placeName(controller.placeOf(offer.recipient));
    const more = mine.filter(job => job !== offer && ['offered', 'returned', 'declined'].includes(state(job.id))).length;
    return { handled: true, offer: offer.id, reply: { text: `I do. ${offer.title}, for ${recipient?.name || 'a neighbour'}${place ? ' in ' + place : ''}. Will you take it?`
      + (more ? ` I have ${more === 1 ? 'one more' : more + ' more'} after that, if you want ${more === 1 ? 'it' : 'them'}.` : '') } };
  }
  const carrying = mine.find(job => state(job.id) === 'active');
  if (carrying) return { handled: true, reply: { text: `You already have ${carrying.title} from me. That is all I have for now.` } };
  // Nothing of their own: the neighbours' referrals say who nearby does have work.
  return null;
}

/** The next job this person would send, if any. */
export function courierOfferFrom(controller, npcId) {
  return controller.jobs().find(job => controller.npc(job.sender)?.id === npcId
    && ['offered', 'returned'].includes(controller.story?.jobs[job.id]?.state)) || null;
}
function offerLine(controller, offer) {
  if (offer.replyTo) {
    const to = controller.npc(offer.recipient), where = controller.placeName(controller.placeOf(offer.recipient));
    return `Wait. Let me write back. They scribble a few lines and fold them. It is for ${to?.name || 'them'}${where ? ' in ' + where : ''}. Would you carry my answer?`;
  }
  const recipient = controller.npc(offer.recipient), place = controller.placeName(controller.placeOf(offer.recipient));
  return `While you're here, I have something to send myself. They hold out ${offer.title.replace(/^(?:A|The)\s/, 'the ')}. It is for ${recipient?.name || 'a neighbour'}${place ? ' in ' + place : ''}. Would you be able to take it?`;
}

/** Hand over the parcel for this person; offer their own next job if they have one. */
export function courierDeliver(controller, npcId, jobId) {
  const result = controller.handoff(jobId, npcId);
  if (!result?.ok) return { handled: true, reply: { text: result?.reason || 'That is not for me, I am afraid.' }, result };
  // The line the book shows, without the bookkeeping a person would not say aloud.
  let text = String(result.message || 'Thank you.').split('\n')[0].replace(/\s*\S+ has another errand if you want it:.*$/, '');
  const offer = courierOfferFrom(controller, npcId);
  if (offer) { controller.pendingOffers.set(npcId, { jobId: offer.id }); text += ' ' + offerLine(controller, offer); }
  return { handled: true, reply: { text }, result, delivered: jobId, offer: offer?.id || null };
}

/**
 * The first errand answered at the end of the welcome: the dispatcher wishes
 * the courier luck, the welcome is over, and so is the conversation.
 */
export function finishWelcome(controller, npcId, response) {
  if (!response || controller.welcome?.npcId !== npcId) return response;
  const accepted = !!response.result?.ok && !response.declined;
  if (!accepted && !response.declined) return response;
  controller.endWelcome?.(accepted ? 'easy' : 'explore');
  const parting = accepted ? WELCOME_PARTING.accepted : WELCOME_PARTING.declined;
  return { ...response, reply: { ...response.reply, text: (accepted && response.reply?.text ? response.reply.text.replace(/^Thank you\. /, 'Here you are. ') + ' ' : '') + parting }, endConversation: true };
}

/** Answer the job this person just held out. */
export function courierAnswerOffer(controller, npcId, yes) {
  const pending = controller.pendingOffers.get(npcId);
  if (!pending) return null;
  controller.pendingOffers.delete(npcId);
  const def = controller.jobDef(pending.jobId);
  if (!yes) {
    const result = controller.decline(pending.jobId, npcId);
    return { handled: true, reply: { text: 'Of course. It will keep, if you change your mind.' }, result, declined: pending.jobId };
  }
  const result = controller.accept(pending.jobId, npcId);
  if (!result?.ok) return { handled: true, reply: { text: result?.reason || 'I could not hand it over just now.' }, result };
  // The way there, said as they hand it over, and written into the book.
  if (!result.briefing && def) {
    const way = controller.wayTo(def.recipient);
    if (way) result.briefing = { text: way, directions: { id: 'route:job:' + def.id, title: 'Directions to ' + (controller.npc(def.recipient)?.name || 'the recipient') } };
  }
  // Just what was handed over: the directions follow once, below.
  const receipt = (def?.title || 'It') + ' is in your satchel.';
  return { handled: true, reply: { text: `Thank you. ${receipt}${result.briefing?.text ? ' ' + result.briefing.text : ''}` }, result, accepted: pending.jobId, jobId: pending.jobId };
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
  // Goodbye, at any point, ends the conversation.
  if (goodbyeIntent(content)) {
    controller.pendingOffers?.delete(npcId);
    const welcoming = controller.welcome?.npcId === npcId;
    if (welcoming) controller.endWelcome?.('explore');
    const text = welcoming ? WELCOME_PARTING.goodbye : PARTING[[...String(npcId)].reduce((sum, c) => sum + c.charCodeAt(0), 0) % PARTING.length];
    return { handled: true, reply: { text }, endConversation: true, goodbye: true };
  }
  // The dispatcher's welcome: each reply moves it on, and "no, I know" skips to the first errand.
  const welcome = controller.welcome?.npcId === npcId ? controller.welcome : null;
  if (welcome && !controller.pendingOffers?.has(npcId)) {
    // The courier spoke before she could: she answers with her greeting.
    if (!welcome.greeted) { welcome.greeted = true; return { handled: true, reply: { text: welcome.lines[0] }, welcomeStep: 0 }; }
    // Asking for work part way through goes straight to the first errand.
    const asked = welcome.step < WELCOME_OFFER_STEP && askWorkIntent(content);
    const skipped = asked || (welcome.step < WELCOME_OFFER_STEP && skipIntent(content));
    welcome.step = skipped ? WELCOME_OFFER_STEP : Math.min(WELCOME_OFFER_STEP, welcome.step + 1);
    if (welcome.step === WELCOME_OFFER_STEP) {
      const state = controller.story?.jobs?.['village-note']?.state;
      if (!['offered', 'declined', 'returned'].includes(state)) {
        controller.endWelcome?.('explore');
        return { handled: true, reply: { text: WELCOME_PARTING.goodbye.replace(/^Off already\? Then g/, 'G') }, endConversation: true };
      }
      controller.pendingOffers?.set(npcId, { jobId: 'village-note' });
    }
    return { handled: true, reply: { text: (asked ? 'I do, as it happens. ' : skipped ? WELCOME_PARTING.skipped + ' ' : '') + welcome.lines[welcome.step].replace(asked ? /^Now, your first errand, if you will have it\. / : /$^/, '') }, welcomeStep: welcome.step };
  }
  // A word this world does not have: asked about, and learned only from the courier.
  const word = typeof controller.teachWord === 'function' ? controller.teachWord(npcId, content, { lastAssistantText: options.lastAssistantText }) : null;
  if (word) return { handled: true, reply: { text: word.text }, ...(word.learned ? { learned: true } : {}) };
  const reference = resolveNpcReference({ ...context, courier: context }, content);
  if (['ambiguous', 'unknown'].includes(reference.status)) return { handled: true, reply: { text: reference.clarification } };
  if (reference.status === 'resolved') content = reference.canonicalText;
  const place = placeId(context.place) || requestedPlace || controller.placeForNpc?.(npcId) || '';
  // A job just held out is answered first: "no" here is an answer, not a negation to ignore.
  if (controller.pendingOffers?.has(npcId)) {
    if (declineIntent(content)) return finishWelcome(controller, npcId, courierAnswerOffer(controller, npcId, false));
    if (!isNegativeOrHypothetical(content) && acceptIntent(content)) return finishWelcome(controller, npcId, courierAnswerOffer(controller, npcId, true));
  }
  // A parcel for this person, handed over by saying so.
  const delivery = (context.deliveries || [])[0];
  if (delivery && controller.pendingOffers && !isNegativeOrHypothetical(content) && deliverIntent(content, delivery)) return courierDeliver(controller, npcId, delivery.id);
  // The letter with no address, shown to someone it does not belong to.
  const found = controller.jobs?.().find(job => job.unaddressed && controller.story?.jobs[job.id]?.state === 'active');
  if (found && !delivery?.unaddressed && foundIntent(content)) return { handled: true, reply: { text: notMineLine(controller, npcId, found) } };
  // "Have you any packages?": the real answer, said by the game, not guessed by the model.
  const work = !isNegativeOrHypothetical(content) && askWorkIntent(content) ? courierWorkReply(controller, npcId) : null;
  if (work) return work;
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
        // A sender who briefs the courier has already said where it goes.
        const next = result.briefing ? '' : offer.destinationName ? ` Take it to ${recipientLabel(offer)} at ${offer.destinationName}.` : ` Take it to ${recipientLabel(offer)}.`;
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
