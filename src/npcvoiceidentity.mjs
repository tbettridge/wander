// Voice identity uses independent hashes, never the appearance RNG or current location.
export const VOICE_ACCENTS = Object.freeze({
  yorkshire: { country: 'England', region: 'Yorkshire', accent: 'an everyday Yorkshire English accent' },
  lancashire: { country: 'England', region: 'Lancashire', accent: 'an everyday Lancashire English accent' },
  midlands: { country: 'England', region: 'the Midlands', accent: 'an everyday Midlands English accent' },
  westcountry: { country: 'England', region: 'the West Country', accent: 'an everyday West Country English accent' },
  london: { country: 'England', region: 'London', accent: 'an everyday working-class London English accent' },
  southern: { country: 'England', region: 'southern England', accent: 'an everyday southern English accent' },
  posh: { country: 'England', region: 'London', accent: 'a cultivated London English accent with Received Pronunciation' },
  scottish: { country: 'Scotland', region: 'Scotland', accent: 'a natural Scottish English accent' },
  irish: { country: 'Ireland', region: 'Ireland', accent: 'a natural Irish English accent' },
  welsh: { country: 'Wales', region: 'Wales', accent: 'a light Welsh English accent' },
  french: { country: 'France', region: 'France', accent: 'a light French accent while speaking fluent English' },
  spanish: { country: 'Spain', region: 'Spain', accent: 'a light Spanish accent while speaking fluent English' },
});

export const VOICE_GENDERS = Object.freeze({
  female: ['Zephyr', 'Kore', 'Leda', 'Aoede', 'Callirrhoe', 'Autonoe', 'Despina',
    'Erinome', 'Laomedeia', 'Achernar', 'Gacrux', 'Pulcherrima', 'Vindemiatrix', 'Sulafat'],
  male: ['Puck', 'Charon', 'Fenrir', 'Orus', 'Enceladus', 'Iapetus', 'Umbriel',
    'Algieba', 'Algenib', 'Rasalgethi', 'Alnilam', 'Schedar', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Sadaltager'],
});
export function voiceHash(value) {
  let result = 2166136261;
  for (const ch of String(value)) result = Math.imul(result ^ ch.charCodeAt(0), 16777619);
  return result >>> 0;
}
const roll = (key) => voiceHash(key) / 4294967296;
const clean = (value) => typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, 240) : '';
const localAccents = ['yorkshire', 'lancashire', 'midlands', 'westcountry', 'london', 'southern'];

export function npcVoiceDemographics(npc = {}) {
  const saved = npc.speech?.version >= 2 ? npc.speech : {};
  const explicit = npc.voiceGender || npc.gender;
  const presentation = npc.presentation;
  const gender = ['female', 'feminine', 'woman', 'girl'].includes(explicit) ? 'female'
    : ['male', 'masculine', 'man', 'boy'].includes(explicit) ? 'male'
      : typeof presentation === 'number' ? presentation >= 0.5 ? 'female' : 'male'
        : presentation === 'feminine' ? 'female' : presentation === 'masculine' ? 'male'
          : ['female', 'male'].includes(saved.gender) ? saved.gender
            : (roll(`${npc.id || npc.name}:voice-gender`) < 0.5 ? 'female' : 'male');
  const age = npc.age ?? saved.ageBand;
  const ageBand = ['youth', 'child', 'children'].includes(age) || (typeof age === 'number' && age < 16) ? 'youth'
    : ['elder', 'senior', 'elderly'].includes(age) || (typeof age === 'number' && age >= 65) ? 'elder' : 'adult';
  return { gender, ageBand };
}

export function npcVoiceBackground(npc = {}) {
  const saved = npc.speech?.version >= 2 ? npc.speech.background : null;
  if (saved?.accentId && Object.hasOwn(VOICE_ACCENTS, saved.accentId)) return Object.freeze({ ...saved });
  const authored = npc.voiceBackground || (typeof npc.background === 'object' ? npc.background : {}) || {};
  const id = npc.id || npc.name || 'resident';
  const family = npc.householdId || `${npc.stationId || 'home'}:${npc.surname || id}`;
  const home = npc.originSettlementId || npc.residence?.originSettlementId || npc.stationId || family;
  const traveller = authored.visitor === true || (!npc.householdId && /travell?er|visitor|tourist/i.test(npc.role || ''));
  const country = String(authored.originCountry || authored.country || '').toLowerCase();
  let accentId = Object.hasOwn(VOICE_ACCENTS, authored.accentId) ? authored.accentId
    : /france|french/.test(country) ? 'french' : /spain|spanish/.test(country) ? 'spanish'
      : /scotland|scottish/.test(country) ? 'scottish' : /ireland|irish/.test(country) ? 'irish'
        : /wales|welsh/.test(country) ? 'welsh' : null;
  const businessFamily = Boolean(authored.businessFamily ?? npc.businessFamily);
  const settlementKind = clean(authored.settlementKind || npc.settlementKind);
  if (!accentId) {
    const region = roll(`${home}:voice-region`);
    accentId = region < 0.76 ? localAccents[voiceHash(`${home}:english-region`) % localAccents.length]
      : region < 0.86 ? 'scottish' : region < 0.96 ? 'irish' : 'welsh';
    const familyRoll = roll(`${family}:voice-upbringing`);
    // A minority have a cultivated London upbringing; more among urban business families.
    const poshChance = settlementKind === 'town' && businessFamily ? 0.35
      : businessFamily ? 0.12 : settlementKind === 'town' ? 0.06 : 0.02;
    if (VOICE_ACCENTS[accentId].country === 'England' && familyRoll < poshChance) accentId = 'posh';
    // Overseas visitors are rare and always get a matching, explicit background story.
    if (traveller && roll(`${id}:overseas-visitor`) < 0.025) {
      accentId = roll(`${id}:overseas-origin`) < 0.5 ? 'french' : 'spanish';
    }
  }
  const info = VOICE_ACCENTS[accentId];
  const overseas = accentId === 'french' || accentId === 'spanish';
  const story = clean(authored.story) || (overseas
    ? `Grew up in ${info.country} and is visiting from there; speaks English fluently.`
    : accentId === 'posh' ? 'Grew up with a cultivated London accent.'
      : `Grew up speaking the everyday English of ${info.region}.`);
  return Object.freeze({ accentId, originCountry: info.country, originRegion: info.region,
    register: accentId === 'posh' ? 'cultivated' : 'everyday', visitor: overseas || traveller,
    businessFamily, settlementKind, story });
}

export function npcPresetVoice(gender, ageBand, id) {
  const elders = gender === 'female' ? ['Gacrux', 'Vindemiatrix', 'Achernar'] : ['Sadaltager', 'Rasalgethi', 'Algenib'];
  const youths = gender === 'female' ? ['Leda', 'Zephyr'] : ['Puck', 'Fenrir'];
  const pool = ageBand === 'elder' ? elders : ageBand === 'youth' ? youths : VOICE_GENDERS[gender];
  return pool[voiceHash(`${id}:preset-voice`) % pool.length];
}

// Only these 144 reusable cast slots may be configured. Public clients cannot invent a voice design.
export function npcCastVoice(key) {
  if (typeof key !== 'string') return null;
  const [accentId, gender, ageBand, variant, ...extra] = key.split(':');
  if (extra.length || !Object.hasOwn(VOICE_ACCENTS, accentId) || !['male', 'female'].includes(gender)
    || !['youth', 'adult', 'elder'].includes(ageBand) || !['0', '1'].includes(variant)) return null;
  const age = ageBand === 'elder' ? 'older adult in their seventies' : ageBand === 'youth' ? 'child around eleven years old' : 'adult';
  const texture = variant === '0' ? 'clear, warm and rounded' : 'lightly textured, soft and conversational';
  return { key, accentId, gender, ageBand, variant: Number(variant),
    prompt: `A ${gender} ${age} voice, ${texture}, with ${VOICE_ACCENTS[accentId].accent}. Natural conversational English, with an individual human cadence.` };
}

export function npcCastKeys() {
  return Object.keys(VOICE_ACCENTS).flatMap((accent) => ['female', 'male'].flatMap((gender) =>
    ['youth', 'adult', 'elder'].flatMap((age) => [0, 1].map((variant) => `${accent}:${gender}:${age}:${variant}`))));
}
