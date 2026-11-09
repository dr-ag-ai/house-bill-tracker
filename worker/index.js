// ============================================================================
// House Bill Tracker — the back end (a Cloudflare Worker)
// ----------------------------------------------------------------------------
// The webpage and the data files are served by Cloudflare directly. This code
// only runs for one address:
//
//     /api/lookup?address=350 Fifth Avenue, New York, NY 10118
//
// It also answers /api/district?geoid=3612&layer=120th Congressional Districts
// with the district's outline (from the Census Bureau's TIGERweb map
// service), for the map on the page.
//
// The lookup does three things:
//   1. Asks the US Census geocoder which congressional district the address
//      is in.
//   2. Looks up that district in data/index.json (made by the nightly job).
//   3. Sends back the district and the representative's ID. The webpage then
//      loads that representative's file, data/members/<ID>.json.
//
// Privacy: addresses are not logged or stored anywhere.
// ============================================================================

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lookup') return lookup(url, request, env);
    if (url.pathname === '/api/district') return district(url, ctx);
    return reply(404, { error: 'not_found', message: 'Nothing here.' });
  },
};

// ---------------------------------------------------------------------------
// District outline for the map. Outlines are public and rarely change, so
// answers are kept by Cloudflare for a week to save repeat trips to the Census.
// ---------------------------------------------------------------------------

const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';

async function district(url, ctx) {
  const geoid = url.searchParams.get('geoid') || '';
  const layerName = url.searchParams.get('layer') || '';
  if (!/^\d{4}$/.test(geoid) || !/^\d{2,3}(st|nd|rd|th) Congressional Districts$/i.test(layerName)) {
    return reply(400, { error: 'bad_request', message: 'Unknown district.' });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // Find the map layer with the same name the address lookup used
    // (its number changes when the Census adds a new Congress's districts).
    const info = await (await fetch(`${TIGERWEB}?f=json`, { signal: AbortSignal.timeout(20_000) })).json();
    const layer = (info.layers || []).find(l => l.name?.toLowerCase() === layerName.toLowerCase());
    if (!layer) throw new Error('layer not found');

    const q = new URL(`${TIGERWEB}/${layer.id}/query`);
    q.searchParams.set('where', `GEOID='${geoid}'`);
    q.searchParams.set('outFields', 'GEOID,NAME');
    q.searchParams.set('returnGeometry', 'true');
    q.searchParams.set('outSR', '4326');
    q.searchParams.set('maxAllowableOffset', '0.0005'); // simplify the outline a little; plenty for a small map
    q.searchParams.set('geometryPrecision', '5');
    q.searchParams.set('f', 'json');
    const json = await (await fetch(q, { signal: AbortSignal.timeout(20_000) })).json();
    const rings = json.features?.[0]?.geometry?.rings;
    if (!rings?.length) throw new Error('no outline');

    const res = new Response(JSON.stringify({ type: 'Feature', properties: { geoid }, geometry: ringsToGeoJSON(rings) }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=604800' },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch {
    return reply(502, { error: 'outline_unavailable', message: 'The district outline could not be loaded.' });
  }
}

// The Census sends outlines as "rings" (lists of points). Outer edges run
// clockwise and holes run counter-clockwise; maps need them grouped into
// polygons (GeoJSON), so each hole is attached to the outer edge before it.
function ringsToGeoJSON(rings) {
  const clockwise = ring => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
    return sum > 0;
  };
  const polygons = [];
  for (const ring of rings) {
    if (clockwise(ring) || !polygons.length) polygons.push([ring]);
    else polygons.at(-1).push(ring);
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

// Sends a JSON answer. "no-store" tells browsers and Cloudflare never to keep
// a copy, because the answer is tied to someone's address.
function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function lookup(url, request, env) {
  const address = (url.searchParams.get('address') || '').trim();
  if (address.length < 5) {
    return reply(400, { error: 'bad_address', message: 'Please enter a full street address, including city and state or ZIP code.' });
  }
  if (/^\d{5}(-\d{4})?$/.test(address)) {
    return reply(400, { error: 'zip_only', message: "A ZIP code alone isn't enough, because many ZIP codes cross district lines. Please enter a full street address, such as 123 Main St, Springfield, IL 62701." });
  }
  if (address.length > 200) {
    return reply(400, { error: 'bad_address', message: 'That address is too long.' });
  }

  // ---- 1. Address -> district (US Census geocoder) ----
  const census = new URL(CENSUS);
  census.searchParams.set('address', address);
  census.searchParams.set('benchmark', 'Public_AR_Current');
  census.searchParams.set('vintage', 'Current_Current');
  census.searchParams.set('layers', 'all');
  census.searchParams.set('format', 'json');

  let geo;
  try {
    const res = await fetch(census, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Census status ${res.status}`);
    geo = await res.json();
  } catch {
    return reply(502, { error: 'census_unavailable', message: 'The Census address service is not responding right now. Please try again in a minute.' });
  }

  const match = geo?.result?.addressMatches?.[0];
  if (!match) {
    return reply(404, { error: 'address_not_found', message: "We couldn't find that address. Check the spelling, and include the city and state or ZIP code." });
  }

  // The Census names this layer after the Congress ("120th Congressional
  // Districts"), and the name changes every two years. So look for any layer
  // whose name contains "Congressional".
  const layers = match.geographies || {};
  const cdLayer = Object.keys(layers).find(name => /Congressional Districts/i.test(name));
  const cd = cdLayer && layers[cdLayer]?.[0];
  if (!cd?.GEOID) {
    return reply(404, { error: 'no_district', message: 'That address was found, but it is not inside a congressional district.' });
  }

  // GEOID = 2-digit state code + 2-digit district ("3612" = New York, 12th).
  // At-large states use "00"; DC and the territories use "98".
  const stateCode = String(cd.GEOID).slice(0, 2);
  const districtCode = String(cd.GEOID).slice(2);
  const district = /^\d+$/.test(districtCode) ? Number(districtCode) : null;
  const atLarge = district === 0 || district === 98 || /at large/i.test(cd.NAME || '');

  const result = {
    matchedAddress: match.matchedAddress || null,
    coordinates: match.coordinates ? { lon: match.coordinates.x, lat: match.coordinates.y } : null,
    stateCode,
    districtName: cd.NAME || null,
    district,
    atLarge,
    geoid: String(cd.GEOID),
    districtSource: cdLayer,
    representative: null,
  };

  // ---- 2. District -> representative (our own data/index.json) ----
  let index;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/index.json', url)));
    if (!res.ok) throw new Error(`index status ${res.status}`);
    index = await res.json();
  } catch {
    return reply(500, { error: 'data_unavailable', message: 'Our representative data could not be loaded. Please try again later.' });
  }
  result.dataUpdated = index.updated || null;

  const inState = index.states?.[stateCode] || [];
  let rep = null;
  if (inState.length === 1) {
    // One seat in this state or territory (an at-large state, DC, or a
    // territory): that person represents the whole place.
    rep = inState[0];
  } else {
    // Match on the district the person represents NOW. (Searching Congress.gov
    // by district also returns people who held it in the past.)
    const found = inState.filter(p => Number(p.district) === district);
    if (found.length >= 1) rep = found[0];
  }

  if (rep) {
    result.representative = { bioguideId: rep.bioguideId, name: rep.name };
  } else {
    result.note = 'No current representative was found for this district. The seat may be vacant.';
  }
  return reply(200, result);
}
