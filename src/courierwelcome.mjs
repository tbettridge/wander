// The dispatcher's welcome: on the courier's first morning they walk over
// from the board and talk the new courier through the work, then hold out
// the first errand. Authored and pure, so it reads the same with or without
// a model, and every place and person in it comes from the save.

const first = name => String(name || '').split(' ')[0];

/**
 * The welcome, in order: the greeting, how the work goes, the board, the
 * country round about, and the first errand. `home`, `up` and `out` are
 * `{ name, walk, station }` for the start village, the next village on the
 * line and the rural place; `guide` is `{ name, address }`.
 */
export function welcomeLines({ ada, home, up, out, guide }) {
  const station = home.station && up?.station;
  return [
    'There you are! You must be our new courier. Welcome to ' + home.name + '. I am ' + first(ada)
      + ', and I keep the post desk here. Nobody has walked the round since the autumn, so I am very glad to see you. Shall I tell you how it works?',
    'It is simple enough. People hand you letters and parcels, and you carry them to whoever they are for. You get a name and an address, never a line on a map. '
      + 'Addresses are told from the village well, so you ask the way, read the road posts, and keep your own map in your book. Your satchel holds three things at a time.',
    'This is our Post & Errands board, and every village has one. When the morning bell rings, new notices go up: who has something to send, and where to. '
      + 'Stand by a board and press E to read it, and the notices go into your book. You collect from the sender, not from the board, and nothing is yours to carry until you say yes.',
    'As for the country round about: '
      + (up ? up.name + ' is ' + (station ? 'up the line, ' + up.walk + ' on foot or a short ride on the regional train from our station' : up.walk + ' away on foot') : '')
      + (up && out ? ', and ' : '') + (out ? out.name + ' is out past the fields, ' + out.walk + ' along the road' : '') + '. '
      + first(guide.name) + ', our riding guide, will lend you a horse and show you how to ride. And listen for church bells and look for chimney smoke: they tell you a village is near before you can see it.',
    'Now, your first errand, if you will have it. A short note across the village for ' + guide.name + ', ' + guide.address
      + '. It is a good way to learn the lanes. Will you take it?',
  ];
}
export const WELCOME_OFFER_STEP = 4;
/** Said as the courier takes the first errand, or turns it down, or says goodbye part way. */
export const WELCOME_PARTING = Object.freeze({
  accepted: 'Good luck out there, courier.',
  declined: 'No matter. It will be on the board whenever you want it. Good luck, and welcome to the round.',
  goodbye: 'Off already? Then good luck, courier. The board is here whenever you want work, and so am I.',
  skipped: 'Then I will not keep you with the rest.',
});
/** Anyone else, when the courier says goodbye. */
export const PARTING = Object.freeze(['Goodbye, then. Safe travels.', 'Mind how you go.', 'Good luck on the road.', 'Come back soon.']);

/** "Goodbye", "bye", "see you", "I have to go": the courier is leaving the conversation. */
export function goodbyeIntent(text) {
  const value = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value || value.split(' ').length > 12) return false;
  if (/\b(?:not|dont|never) (?:say )?(?:goodbye|bye|leaving|going)\b/.test(value)) return false;
  return /\b(?:good ?bye|goodbye|bye(?: bye| for now| now)?|farewell|cheerio|see (?:you|ya)(?: later| soon| around| then)?|take care|so long|catch you later|later then|i (?:have|need|ought|got) to (?:go|be going|get going)|ive got to go|i must (?:go|be going|be off)|im off|ill be off|ill be going|ill leave you|im (?:going|heading) (?:now|off))\b/.test(value);
}
/** "No thanks", "I know", "skip it": a courier who does not want the rest of the explanation. */
export function skipIntent(text) {
  const value = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:no|nah|nope|no thanks|no thank you|not really|not now)\b/.test(value)
    || /\b(?:i know|i already know|skip|ive done this before|i get it|got it already|just give me (?:the|a) (?:job|errand|work|delivery))\b/.test(value);
}
