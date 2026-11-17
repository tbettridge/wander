// What the people who work a station know about the railway.
//
// The regional line has no printed timetable: one train works a loop, and when
// it reaches each platform falls out of the schedule model's own physics. So a
// keeper's timetable is read from that model rather than written beside it. A
// copy of the live schedule is run forward, its arrival and departure events
// are collected, and the real seconds between them are turned into the game's
// clock exactly as the sky advances it. Change the train's speed, dwell or
// stops and what the keeper says changes with it; nothing here can drift.
//
// THREE-free and world-free, so Node tests can hold a keeper to the truth.

import { TrainScheduleModel, TRAIN_PHASE } from './railservice.mjs';
import { skyClockRate, SKY_DAY_LENGTH } from './skyclock.mjs';
import { bearingBetween, compassFromBearing, describeDistance } from './livingworldcontext.mjs';

/** Roles whose working day runs to the train, so they know its times. */
export const RAILWAY_STAFF_ROLES = Object.freeze([
  'station keeper', 'railway porter', 'platform vendor', 'ticket clerk',
]);

export function isRailwayStaff(npc) {
  const role = String(npc?.role || '').trim().toLowerCase();
  return RAILWAY_STAFF_ROLES.includes(role);
}

const SIM_STEP = 0.1;
const MAX_SIM_SECONDS = 4 * 3600;

function cloneSchedule(schedule) {
  const model = Object.create(TrainScheduleModel.prototype);
  for (const [key, value] of Object.entries(schedule)) model[key] = value;
  model.stops = schedule.stops.map((stop) => ({ ...stop }));
  model.arrivalEvent = null;
  model.departureEvent = null;
  return model;
}

/**
 * Run a copy of the live schedule forward and list every call it makes until
 * each station has seen `departuresPerStation` departures.
 *
 * Each event carries `seconds` (real seconds from now) and `day` (an unwrapped
 * day fraction on the game clock, starting from `skyTime`). A train already
 * standing at a platform is reported as an arrival at zero.
 */
export function projectRailCalls(schedule, {
  skyTime = 0.5,
  departuresPerStation = 2,
  step = SIM_STEP,
} = {}) {
  if (!schedule?.stops?.length || typeof schedule.step !== 'function') return null;
  const model = cloneSchedule(schedule);
  const events = [];
  const departures = new Map();
  let seconds = 0;
  let day = Number(skyTime) || 0;
  if (model.phase === TRAIN_PHASE.dwelling) {
    events.push({ type: 'arrival', stationIndex: model.currentStationIndex, seconds: 0, day });
  }
  const wanted = model.stopCount;
  const enough = () => departures.size >= wanted
    && [...departures.values()].every((count) => count >= departuresPerStation);
  while (seconds < MAX_SIM_SECONDS && !enough()) {
    model.step(step);
    seconds += step;
    day += (step * skyClockRate(day)) / SKY_DAY_LENGTH;
    if (model.justDeparted) {
      const stationIndex = model.departureEvent.stationIndex;
      events.push({ type: 'departure', stationIndex, seconds, day });
      departures.set(stationIndex, (departures.get(stationIndex) || 0) + 1);
    }
    if (model.justArrived) {
      events.push({ type: 'arrival', stationIndex: model.currentStationIndex, seconds, day });
    }
  }
  return {
    events,
    stopOrder: schedule.stops.map((stop) => stop.index),
    trainPhase: schedule.phase,
    atStationIndex: schedule.atStation ? schedule.currentStationIndex : -1,
    nextStationIndex: schedule.nextStationIndex,
  };
}

// --- how a keeper says a time ------------------------------------------------

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty'];

function words(n) {
  if (n <= 20) return SMALL[n];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'][Math.floor(n / 10)];
  return n % 10 ? `${tens}-${SMALL[n % 10]}` : tens;
}

function dayClock(day) {
  const minutes = Math.round((((day % 1) + 1) % 1) * 1440) % 1440;
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

export function clockLabel(day) {
  const { hour, minute } = dayClock(day);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "about twenty to four in the afternoon", rounded as people round. */
export function spokenTime(day, nowDay = day) {
  let total = Math.round((((day % 1) + 1) % 1) * 1440 / 5) * 5;
  let dayOffset = Math.floor(day) - Math.floor(nowDay) + (total >= 1440 ? 1 : 0);
  total %= 1440;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  if (total === 0) return dayOffset > 0 && nowDay % 1 < 0.75 ? 'about midnight tonight' : 'about midnight';
  if (total === 720) return dayOffset > 0 ? 'about noon tomorrow' : 'about noon';
  const twelve = (h) => SMALL[((h + 11) % 12) + 1];
  let phrase;
  if (minute === 0) phrase = `${twelve(hour)} o'clock`;
  else if (minute === 15) phrase = `quarter past ${twelve(hour)}`;
  else if (minute === 30) phrase = `half past ${twelve(hour)}`;
  else if (minute === 45) phrase = `quarter to ${twelve(hour + 1)}`;
  else if (minute < 30) phrase = `${words(minute)} past ${twelve(hour)}`;
  else phrase = `${words(60 - minute)} to ${twelve(hour + 1)}`;
  // The part of the day is the one the train arrives in, so "quarter to five"
  // at 16:45 is still the afternoon even though five is not.
  // Small hours belong to the night before, so they count a day less.
  const daysOn = hour < 5 ? dayOffset - 1 : dayOffset;
  if (daysOn === 1 && hour >= 5) {
    const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    return `about ${phrase} tomorrow ${part}`;
  }
  const part = hour < 5 ? 'in the small hours'
    : hour < 12 ? 'in the morning'
      : hour < 17 ? 'in the afternoon'
        : hour < 21 ? 'in the evening' : 'at night';
  if (daysOn === 1) return `about ${phrase} ${part} tomorrow night`;
  if (daysOn >= 2) return `about ${phrase} ${part} the day after tomorrow`;
  return `about ${phrase} ${part}`;
}

/** "about forty minutes", "about two and a half hours". */
export function spokenDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 3) return 'a couple of minutes';
  if (m < 53) return `about ${words(Math.max(5, Math.round(m / 5) * 5))} minutes`;
  const halves = Math.max(2, Math.round(m / 30));
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 1) return half ? 'about an hour and a half' : 'about an hour';
  return `about ${words(Math.min(whole, 59))}${half ? ' and a half' : ''} hours`;
}

// --- the keeper's knowledge -------------------------------------------------

function gameMinutes(fromDay, toDay) {
  return Math.round((toDay - fromDay) * 1440);
}

function nameOf(stations, index) {
  const station = stations.find((candidate) => candidate.index === index) || stations[index];
  return station?.name || `Station ${index + 1}`;
}

/**
 * Everything a member of station staff knows about the regional line, measured
 * from their own station and the current moment. Compact by design: it rides
 * in every prompt, so names and phrases, not raw numbers, wherever a person
 * would speak.
 */
export function railwayKnowledgeFor({
  schedule,
  stations = [],
  stationId = null,
  skyTime = 0.5,
} = {}) {
  if (!schedule || !Array.isArray(stations) || stations.length < 2) return null;
  const home = stations.find((station) => station.id === stationId);
  if (!home) return null;
  const projection = projectRailCalls(schedule, { skyTime });
  if (!projection) return null;
  const { events, stopOrder } = projection;
  const homeIndex = home.index;
  const orderAt = stopOrder.indexOf(homeIndex);
  if (orderAt < 0) return null;
  const calling = [...stopOrder.slice(orderAt + 1), ...stopOrder.slice(0, orderAt)];
  const nextStop = calling[0];
  const now = Number(skyTime) || 0;

  const homeDepartures = events.filter((event) => event.type === 'departure' && event.stationIndex === homeIndex);
  const boardingHere = projection.atStationIndex === homeIndex;
  const departures = homeDepartures.slice(0, 2).map((event, order) => ({
    at: spokenTime(event.day, now),
    clock: clockLabel(event.day),
    inMinutes: gameMinutes(now, event.day),
    ...(order === 0 && boardingHere ? { boardingNow: true } : {}),
  }));

  // A ride is timed from the first train out of here, so it carries that
  // train's real night or daytime pace.
  const firstOut = homeDepartures[0];
  const nextArrivalHere = events.find((event) => event.type === 'arrival'
    && event.stationIndex === homeIndex && event.seconds > 0);
  const destinations = firstOut ? calling.map((index, order) => {
    const arrival = events.find((event) => event.type === 'arrival'
      && event.stationIndex === index && event.seconds > firstOut.seconds);
    const station = stations.find((candidate) => candidate.index === index);
    const rideMinutes = arrival ? gameMinutes(firstOut.day, arrival.day) : null;
    const where = station && Number.isFinite(station.x) && Number.isFinite(home.x) ? {
      direction: compassFromBearing(bearingBetween(home.x, home.z, station.x, station.z)),
      distancePhrase: describeDistance(Math.hypot(station.x - home.x, station.z - home.z)),
    } : {};
    return {
      station: nameOf(stations, index),
      stopsBetween: order,
      ...(rideMinutes != null ? { ride: spokenDuration(rideMinutes) } : {}),
      ...(arrival ? { arrivesOnNextTrain: spokenTime(arrival.day, now) } : {}),
      ...where,
    };
  }) : [];
  const loop = firstOut && homeDepartures[1]
    ? spokenDuration(gameMinutes(firstOut.day, homeDepartures[1].day)) : null;

  let trainNow;
  if (boardingHere) {
    trainNow = `standing at ${home.name} now with its doors open, leaving for ${nameOf(stations, nextStop)} shortly`;
  } else if (projection.atStationIndex >= 0) {
    trainNow = `standing at ${nameOf(stations, projection.atStationIndex)}`;
  } else {
    trainNow = `running towards ${nameOf(stations, projection.nextStationIndex)}`;
  }
  if (!boardingHere && nextArrivalHere) {
    trainNow += `; due in here ${spokenTime(nextArrivalHere.day, now)}`;
  }

  return {
    line: 'the regional line',
    yourStation: home.name,
    howItRuns: `One train works a single loop of ${stopOrder.length} stations, always the same way round, so nobody ever needs to change trains. From here it runs on to ${nameOf(stations, nextStop)} and comes back round from ${nameOf(stations, calling.at(-1))}.`,
    callingOrderFromHere: calling.map((index) => nameOf(stations, index)),
    ...(destinations[0]?.direction ? { leavesHeading: destinations[0].direction } : {}),
    trainNow,
    nextDepartures: departures,
    ...(loop ? { roundTrip: loop } : {}),
    destinations,
    clockNow: clockLabel(now),
  };
}

/** Only what moves minute to minute, for a fresh per-turn game block. */
export function railwayNowDigest(railway) {
  if (!railway) return null;
  return {
    clockNow: railway.clockNow,
    trainNow: railway.trainNow,
    nextDepartures: railway.nextDepartures,
    arrivalsOnNextTrain: railway.destinations
      .filter((entry) => entry.arrivesOnNextTrain)
      .map((entry) => ({ station: entry.station, arrives: entry.arrivesOnNextTrain })),
  };
}

// --- answering without a model ------------------------------------------------

const STATION_WORD_NOISE = new Set(['halt', 'crossing', 'green', 'hollow', 'reach', 'gate', 'end',
  'fields', 'bank', 'moor', 'bay', 'strand', 'cove', 'harbour', 'point', 'sands', 'ford', 'bridge',
  'weir', 'mill', 'bourne', 'heights', 'ridge', 'fell', 'bluff', 'summit', 'the', 'station']);

/** Which station on the line the traveller named, if any. */
export function mentionedRailStation(railway, text) {
  const normalized = String(text || '').toLocaleLowerCase();
  const names = [railway.yourStation, ...railway.callingOrderFromHere];
  const full = names.filter((name) => normalized.includes(name.toLocaleLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (full.length) return { status: 'resolved', name: full[0] };
  const tokens = new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const partial = names.filter((name) => name.toLocaleLowerCase().split(/\s+/)
    .some((word) => word.length >= 3 && !STATION_WORD_NOISE.has(word) && tokens.has(word)));
  if (partial.length === 1) return { status: 'resolved', name: partial[0] };
  if (partial.length > 1) return { status: 'ambiguous', names: partial };
  return { status: 'none' };
}

function listWords(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function departureSentence(railway) {
  const [first, second] = railway.nextDepartures;
  if (!first) return '';
  const next = railway.callingOrderFromHere[0];
  const lead = first.boardingNow
    ? `The train is in now and leaves for ${next} ${first.at.replace(/^about /, 'at about ')}.`
    : `The next train leaves here for ${next} ${first.at.replace(/^about /, 'at about ')}.`;
  return second ? `${lead} After that, ${second.at.replace(/^about /, 'about ')}.` : lead;
}

/** One sentence for an opening line, or ''. */
export function railwayOpeningLine(railway) {
  if (!railway?.nextDepartures?.length) return '';
  const [first] = railway.nextDepartures;
  const next = railway.callingOrderFromHere[0];
  return first.boardingNow
    ? `The train is in, leaving for ${next} ${first.at.replace(/^about /, 'at about ')}.`
    : `Next train out is for ${next}, ${first.at.replace(/^about /, 'at about ')}.`;
}

/**
 * An authored answer to a travel question, or null when the question is not
 * about the railway. Every fact comes from `railway`, so it is the same
 * timetable the model is given.
 */
export function railwayFallbackReply(railway, userText = '') {
  if (!railway) return null;
  const text = String(userText || '').toLocaleLowerCase();
  const railNoun = /\b(?:trains?|rail|railway|timetable|schedule|departures?|platform|loop|tickets?|line|route|stops|stations)\b/.test(text);
  const travelAsk = /\b(?:how long|how far|get to|go to|reach|ride|journey|next|when|leave|leaves|leaving|depart\w*|arriv\w*|where|far|which way)\b/.test(text);
  const mention = mentionedRailStation(railway, text);
  if (mention.status === 'ambiguous' && (railNoun || travelAsk)) {
    return { text: `Do you mean ${listWords(mention.names).replace(/ and ([^,]+)$/, ' or $1')}? Both are on the line.` };
  }
  const named = mention.status === 'resolved' ? mention.name : null;

  if (railNoun && /\bchange\b|\bchanging\b|\bconnection|\binterchange|\btransfer/.test(text)) {
    return { text: `No changing needed. ${railway.howItRuns}` };
  }
  if (named && named !== railway.yourStation) {
    if (!railNoun && !travelAsk) return null;
    const entry = railway.destinations.find((candidate) => candidate.station === named);
    if (!entry) return null;
    const between = entry.stopsBetween === 0 ? 'It is the next stop.'
      : `The train calls at ${listWords(railway.callingOrderFromHere.slice(0, entry.stopsBetween))} on the way.`;
    const where = entry.direction ? `${named} lies ${entry.direction} of here, ${entry.distancePhrase} as the crow flies.` : '';
    const first = railway.nextDepartures[0];
    if (/\bwhere\b|\bfar\b|\bwhich way\b/.test(text) && !/\btrain|when|how long\b/.test(text)) {
      return { text: `${where} ${between} The ride is ${entry.ride || 'not long'}.`.trim() };
    }
    if (/\bhow long\b|\bride\b|\btake\b/.test(text)) {
      return { text: `${named} is ${entry.ride || 'a fair ride'} on the train. ${between}${first && entry.arrivesOnNextTrain ? ` Catch the one ${first.at.replace(/^about /, 'at about ')} and you'll be there ${entry.arrivesOnNextTrain}.` : ''}` };
    }
    return { text: `${first ? `${first.boardingNow ? 'The train in now' : 'The next train'} leaves ${first.at.replace(/^about /, 'at about ')}` : 'The next train'} and gets you to ${named} ${entry.arrivesOnNextTrain || 'in good time'}, ${entry.ride || 'a fair ride'} on board. ${between}` };
  }
  if (!railNoun) return null;
  if (/\bwhere\b.*\b(?:go|goes|going|run|runs)\b|\bstations?\b|\bstops\b|\broute\b|\bline\b|\bloop\b|\bwhich (?:way|direction)\b/.test(text)
    && !/\bnext\b|\bwhen\b/.test(text)) {
    const heading = railway.leavesHeading ? `Trains leave here heading ${railway.leavesHeading}. ` : '';
    return { text: `${heading}From ${railway.yourStation} the line calls at ${listWords(railway.callingOrderFromHere)}, then comes back round to us. One train, always the same way round${railway.roundTrip ? `, ${railway.roundTrip} for the whole loop` : ''}.` };
  }
  return { text: `${departureSentence(railway)} Right now the train is ${railway.trainNow}.`.replace(/\s+/g, ' ').trim() };
}
