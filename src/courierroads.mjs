// Where road posts stand along a signed road. Pure, so the promises it makes
// (a post at every fork, one just past it, and never a long stretch without
// one) can be tested without terrain: the caller supplies the road as a
// polyline and says which ground a post may stand on.

/** Most a walker should go between posts, in metres. */
export const ROAD_POST_SPACING = 300;
/** How far past a junction the post that confirms the branch stands. */
export const ROAD_CONFIRM_AFTER = 55;
const FILL_SPACING = 220;           // planned gap, leaving room to slide a post to dry ground
const SLIDES = [0, 10, -10, 20, -20, 30, -30, 40, -40];
const OFFSETS = [2.4, 3.6, 5, -2.4, -3.6, -5];
const TOWARD = 30;                  // an arm points at the road this far ahead

/**
 * The route as one line of points with arc length, and where its junctions
 * are. `frameAt(leg, metres)` gives the point that far along a leg in the
 * direction of travel, with `perpX/perpZ` to the traveller's left.
 */
export function routePolyline(route, frameAt, step = 10) {
  const points = [], junctions = [];
  let base = 0;
  route.legs.forEach((leg, index) => {
    const length = leg.edge?.arcLength || 0;
    // Where the traveller arrives at this junction: the end of the road they came in on,
    // which every road arriving the same way shares, whichever branch it takes next.
    const arrive = index > 0 ? points.at(-1) : null;
    junctions.push({ arc: base, nodeKey: index === 0 ? route.keys?.[0] : route.keys?.[index], index, ...(arrive ? { arrive } : {}) });
    for (let d = 0; d <= length; d += step) {
      const frame = frameAt(leg, Math.min(d, length));
      if (Number.isFinite(frame?.x) && Number.isFinite(frame?.z)) points.push({ x: frame.x, z: frame.z, arc: base + d, perpX: frame.perpX || 0, perpZ: frame.perpZ || 0 });
    }
    // The last stretch of a leg ends exactly at its far end.
    if (length % step) {
      const frame = frameAt(leg, length);
      if (Number.isFinite(frame?.x)) points.push({ x: frame.x, z: frame.z, arc: base + length, perpX: frame.perpX || 0, perpZ: frame.perpZ || 0 });
    }
    base += length;
  });
  return { points, junctions, length: base };
}

/** The point at `arc` along a polyline, by linear interpolation. */
export function pointAtArc(line, arc) {
  const points = line.points;
  if (!points.length) return null;
  const at = Math.max(0, Math.min(line.length, arc));
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].arc <= at) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi], span = b.arc - a.arc || 1, t = Math.max(0, Math.min(1, (at - a.arc) / span));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, arc: at, perpX: a.perpX, perpZ: a.perpZ };
}

/**
 * Posts for one direction of one road. At every junction the route takes, a
 * fork post (if `isFork` says the node is one) and a post just past it on
 * the branch to follow; between them, posts no more than ~220 m apart. A post
 * the ground will not take is slid along the road and to either side to the
 * first place that will (`isGood`), then to anywhere dry (`isPossible`);
 * only water with nothing dry within forty metres goes without.
 */
export function placeRoadPosts(line, { isGood = () => true, isPossible = isGood, isFork = () => true, endMargin = 40 } = {}) {
  if (!line.points.length || line.length < 1) return [];
  const end = Math.max(0, line.length - endMargin);
  const wanted = [];
  for (const junction of line.junctions) {
    if (junction.arc > end) continue;
    if (junction.index === 0 || isFork(junction.nodeKey)) wanted.push({ arc: junction.arc, kind: 'fork', leg: junction.index, arrive: junction.arrive });
    if (junction.arc + ROAD_CONFIRM_AFTER <= end) wanted.push({ arc: junction.arc + ROAD_CONFIRM_AFTER, kind: 'confirm', leg: junction.index });
  }
  wanted.sort((a, b) => a.arc - b.arc);
  // Fill every stretch between required posts, and on to the end of the road.
  const marks = [...wanted.map(item => item.arc), end];
  const fills = [];
  let from = 0;
  for (const to of marks) {
    const gap = to - from;
    const count = Math.ceil(gap / FILL_SPACING) - 1;
    for (let i = 1; i <= count; i++) fills.push({ arc: from + gap * i / (count + 1), kind: 'fill' });
    from = Math.max(from, to);
  }
  const targets = [...wanted, ...fills].sort((a, b) => a.arc - b.arc);
  const posts = [];
  for (const target of targets) {
    const spot = target.arrive ? findArrivalSpot(line, target, isGood) || findArrivalSpot(line, target, isPossible)
      : findSpot(line, target.arc, isGood) || findSpot(line, target.arc, isPossible);
    if (!spot) continue;
    // A fill that lands on top of a required post adds nothing.
    if (target.kind === 'fill' && posts.some(post => Math.abs(post.arc - spot.arc) < 30)) continue;
    const ahead = pointAtArc(line, Math.min(line.length, spot.arc + (target.kind === 'fork' ? TOWARD * 2 : TOWARD)));
    const toward = Math.hypot(ahead.x - spot.x, ahead.z - spot.z) > 2 ? ahead : pointAtArc(line, line.length);
    posts.push({ x: spot.x, z: spot.z, arc: spot.arc, kind: target.kind, ...(target.leg !== undefined ? { leg: target.leg } : {}),
      toward: { x: toward.x, z: toward.z } });
  }
  return posts.sort((a, b) => a.arc - b.arc);
}

/** A fork post stands where the road in reaches the junction, or a little back along it. */
function findArrivalSpot(line, target, accept) {
  for (const back of [0, 10, 20, 30, 40]) {
    const point = back ? pointAtArc(line, target.arc - back) : target.arrive;
    for (const offset of OFFSETS) {
      const spot = { x: point.x + point.perpX * offset, z: point.z + point.perpZ * offset, arc: target.arc - back };
      if (accept(spot)) return spot;
    }
  }
  return null;
}
function findSpot(line, arc, accept) {
  for (const slide of SLIDES) {
    const at = arc + slide;
    if (at < 0 || at > line.length) continue;
    const point = pointAtArc(line, at);
    for (const offset of OFFSETS) {
      const spot = { x: point.x + point.perpX * offset, z: point.z + point.perpZ * offset, arc: at };
      if (accept(spot)) return spot;
    }
  }
  return null;
}

/** The largest stretch of road between posts, counting from the start to the end margin. */
export function largestPostGap(posts, length, endMargin = 40) {
  let last = 0, gap = 0;
  for (const post of [...posts].sort((a, b) => a.arc - b.arc)) { gap = Math.max(gap, post.arc - last); last = post.arc; }
  return Math.max(gap, Math.max(0, length - endMargin) - last);
}

/**
 * Put one arm on the post standing here, or a new post if there is none.
 * Two roads that pass the same spot share a post with an arm for each
 * destination. A fork post joins any other fork post at the same junction,
 * which can stand further off: each road's branch leaves the clearing at its
 * own edge, and one post there should name every way.
 */
export const ROAD_FORK_RADIUS = 40;
export function addRoadArm(posts, { x, z, destination, toward, owner = null, name = '', fork = false }, radius = 12) {
  const near = item => Math.hypot(item.x - x, item.z - z);
  let post = fork ? posts.filter(item => item.fork && near(item) <= ROAD_FORK_RADIUS).sort((a, b) => near(a) - near(b))[0] : null;
  post ||= posts.find(item => near(item) <= radius);
  if (post?.arms.some(arm => arm.destination === destination)) return { post, created: false, added: false };
  if (post && post.arms.length >= 4) post = null;
  const arm = { destination, toward: { x: toward.x, z: toward.z }, owner };
  if (post) { post.arms.push(arm); return { post, created: false, added: true }; }
  post = { x, z, name, arms: [arm], ...(fork ? { fork: true } : {}) };
  posts.push(post);
  return { post, created: true, added: true };
}
