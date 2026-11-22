// ============================================================================
// House Bill Tracker — the back end (a Cloudflare Worker)
// ----------------------------------------------------------------------------
// The webpage and the data files are served by Cloudflare directly. This code
// runs for everything else:
//
//     /api/lookup?address=...  or  ?lat=...&lon=...  or  ?code=ny-12
//         -> the district and its representative
//     /api/district?geoid=3612
//         -> the district's outline for the map (Census TIGERweb service)
//     /ny-12, /wy, /dc ...
//         -> a shareable page for one district, with a link preview
//     anything else
//         -> a friendly "page not found" page
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
const CENSUS_POINT = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';

// Shareable pages: each district has its own address, like /ny-12, and states
// or territories with a single seat use just their letters, like /wy or /dc.
// These links never contain anyone's street address.
const POSTAL_TO_FIPS = {
  al:'01', ak:'02', az:'04', ar:'05', ca:'06', co:'08', ct:'09', de:'10', dc:'11', fl:'12',
  ga:'13', hi:'15', id:'16', il:'17', in:'18', ia:'19', ks:'20', ky:'21', la:'22', me:'23',
  md:'24', ma:'25', mi:'26', mn:'27', ms:'28', mo:'29', mt:'30', ne:'31', nv:'32', nh:'33',
  nj:'34', nm:'35', ny:'36', nc:'37', nd:'38', oh:'39', ok:'40', or:'41', pa:'42', ri:'44',
  sc:'45', sd:'46', tn:'47', tx:'48', ut:'49', vt:'50', va:'51', wa:'53', wv:'54', wi:'55',
  wy:'56', as:'60', gu:'66', mp:'69', pr:'72', vi:'78',
};
const FIPS_TO_POSTAL = Object.fromEntries(Object.entries(POSTAL_TO_FIPS).map(([p, f]) => [f, p]));
// DC and the territories use "98" for their single seat; at-large states use "00".
const DELEGATE_FIPS = new Set(['11', '60', '66', '69', '72', '78']);

// "ny-12" -> { stateCode: "36", district: 12 };  "wy" -> { stateCode: "56", district: 0 }
function parseDistrictCode(code) {
  const m = /^([a-z]{2})(?:-(\d{1,2}))?$/.exec(String(code || '').toLowerCase());
  const stateCode = m && POSTAL_TO_FIPS[m[1]];
  if (!stateCode) return null;
  const single = m[2] == null;
  const district = single ? (DELEGATE_FIPS.has(stateCode) ? 98 : 0) : Number(m[2]);
  if (!single && (district < 1 || district > 60)) return null;
  return { stateCode, district };
}

// The reverse: what goes in the page address for a district.
function districtCode(stateCode, district, atLarge) {
  const postal = FIPS_TO_POSTAL[stateCode];
  if (!postal) return null;
  return atLarge ? postal : `${postal}-${district}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lookup') return lookup(url, request, env);
    if (url.pathname === '/api/district') return district(url, ctx);

    // A district page such as /ny-12: the normal page, with a link preview
    // (title, description, photo) for chat apps and social media.
    const code = url.pathname.replace(/^\/|\/$/g, '');
    if (parseDistrictCode(code)) return districtPage(url, env, code.toLowerCase());

    // Anything else: a friendly "page not found" page instead of raw data.
    return notFoundPage(url, env);
  },
};

async function notFoundPage(url, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/404.html', url)));
  return new Response(res.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function districtPage(url, env, code) {
  const page = await (await env.ASSETS.fetch(new Request(new URL('/', url)))).text();
  const { stateCode, district } = parseDistrictCode(code);
  let title = 'RepTracker', description = 'Bills sponsored and votes cast since 2023.', image = null;
  try {
    const index = await (await env.ASSETS.fetch(new Request(new URL('/data/index.json', url)))).json();
    // "/ny" alone isn't a district: New York has many seats.
    if (!code.includes('-') && (index.states?.[stateCode] || []).length > 1) return notFoundPage(url, env);
    const rep = findRep(index, stateCode, district);
    const label = code.toUpperCase();
    if (rep) {
      const [last, first] = rep.name.split(', ');
      title = `${first ? `${first} ${last}` : rep.name} (${label}) · RepTracker`;
      description = `Bills sponsored and House votes cast since 2023 by the representative for ${label}.`;
      const member = await (await env.ASSETS.fetch(new Request(new URL(`/data/members/${rep.bioguideId}.json`, url)))).json();
      image = member.photo || null;
    } else {
      title = `${label} · RepTracker`;
      description = `No current representative was found for ${label}. The seat may be vacant.`;
    }
  } catch { /* fall back to the general preview */ }

  const html = page
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${escapeHtml(title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${escapeHtml(description)}`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${escapeHtml(description)}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${escapeHtml(url.origin + '/' + code)}`)
    .replace('<!--og:image-->', image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '');
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

// Who represents a district right now, from data/index.json.
function findRep(index, stateCode, district) {
  const inState = index.states?.[stateCode] || [];
  // One seat in this state or territory: that person represents the whole place.
  if (inState.length === 1) return inState[0];
  // Otherwise match on the district the person represents NOW. (Searching
  // Congress.gov by district also returns people who held it in the past.)
  return inState.find(p => Number(p.district) === district) || null;
}

// ---------------------------------------------------------------------------
// District outline for the map. Outlines are public and rarely change, so
// answers are kept by Cloudflare for a week to save repeat trips to the Census.
// ---------------------------------------------------------------------------

const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';

async function district(url, ctx) {
  const geoid = url.searchParams.get('geoid') || '';
  const layerName = url.searchParams.get('layer') || '';
  // The layer name is optional: district pages (/ny-12) don't have one, and
  // then the newest set of congressional districts is used.
  if (!/^\d{4}$/.test(geoid) || (layerName && !/^\d{2,3}(st|nd|rd|th) Congressional Districts$/i.test(layerName))) {
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
    const cdLayers = (info.layers || []).filter(l => /^\d{2,3}(st|nd|rd|th) Congressional Districts$/i.test(l.name || ''));
    const layer = layerName
      ? cdLayers.find(l => l.name.toLowerCase() === layerName.toLowerCase())
      : cdLayers.sort((a, b) => parseInt(b.name) - parseInt(a.name))[0];
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

// Two ways to ask:
//   /api/lookup?address=350 Fifth Avenue, New York, NY 10118
//   /api/lookup?lat=40.748&lon=-73.985   (a spot picked on the map, or the
//                                         visitor's current location)
// The second helps where the Census address list is missing newer
// addresses, such as rural 911 addresses.
async function lookup(url, request, env) {
  // A district page (/ny-12) asks by district code; no Census lookup needed.
  const code = url.searchParams.get('code');
  if (code != null) {
    const parsed = parseDistrictCode(code);
    if (!parsed) return reply(404, { error: 'unknown_district', message: "That district doesn't exist. Look up your representative by address instead." });
    const atLarge = parsed.district === 0 || parsed.district === 98;
    return finishLookup(url, env, {
      matchedAddress: null,
      byLocation: false,
      coordinates: null,
      stateCode: parsed.stateCode,
      districtName: atLarge ? null : `Congressional District ${parsed.district}`,
      district: parsed.district,
      atLarge,
      geoid: `${parsed.stateCode}${String(parsed.district).padStart(2, '0')}`,
      districtSource: null,
    }, true);
  }

  const address = (url.searchParams.get('address') || '').trim();
  const latText = url.searchParams.get('lat');
  const lonText = url.searchParams.get('lon');
  const byPoint = latText != null && lonText != null;

  const census = new URL(byPoint ? CENSUS_POINT : CENSUS);
  if (byPoint) {
    const lat = Number(latText), lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return reply(400, { error: 'bad_location', message: 'That location could not be read. Please pick a spot on the map again.' });
    }
    census.searchParams.set('x', lon.toFixed(6));
    census.searchParams.set('y', lat.toFixed(6));
  } else {
    if (address.length < 5) {
      return reply(400, { error: 'bad_address', message: 'Please enter your full street address, with city, state, and ZIP code.' });
    }
    if (/^\d{5}(-\d{4})?$/.test(address)) {
      return reply(400, { error: 'zip_only', message: "A ZIP code alone isn't enough, because many ZIP codes cross district lines. Please enter a full street address, such as 123 Main St, Springfield, IL 62701." });
    }
    if (address.length > 200) {
      return reply(400, { error: 'bad_address', message: 'That address is too long.' });
    }
    census.searchParams.set('address', address);
  }

  // ---- 1. Address or location -> district (US Census geocoder) ----
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

  // An address search returns a list of matches; a location search returns
  // the areas at that spot directly.
  const match = byPoint
    ? { geographies: geo?.result?.geographies, coordinates: { x: Number(lonText), y: Number(latText) } }
    : geo?.result?.addressMatches?.[0];
  if (!match?.geographies) {
    return reply(404, byPoint
      ? { error: 'location_not_found', message: "That spot isn't inside a U.S. congressional district. Try picking a spot on land within the United States." }
      : { error: 'address_not_found', message: "We couldn't find that address. Check the spelling, and include the city, state, and ZIP code. If your address is new or rural, use your location or pick the spot on the map instead." });
  }

  // The Census names this layer after the Congress ("120th Congressional
  // Districts"), and the name changes every two years. So look for any layer
  // whose name contains "Congressional".
  const layers = match.geographies || {};
  const cdLayer = Object.keys(layers).find(name => /Congressional Districts/i.test(name));
  const cd = cdLayer && layers[cdLayer]?.[0];
  if (!cd?.GEOID || /ZZ$/.test(cd.GEOID)) {
    return reply(404, { error: 'no_district', message: byPoint
      ? "That spot isn't inside a U.S. congressional district. Try picking a spot on land within the United States."
      : 'That address was found, but it is not inside a congressional district.' });
  }

  // GEOID = 2-digit state code + 2-digit district ("3612" = New York, 12th).
  // At-large states use "00"; DC and the territories use "98".
  const stateCode = String(cd.GEOID).slice(0, 2);
  const districtCode = String(cd.GEOID).slice(2);
  const district = /^\d+$/.test(districtCode) ? Number(districtCode) : null;
  const atLarge = district === 0 || district === 98 || /at large/i.test(cd.NAME || '');

  return finishLookup(url, env, {
    matchedAddress: match.matchedAddress || null,
    byLocation: byPoint,
    coordinates: match.coordinates ? { lon: match.coordinates.x, lat: match.coordinates.y } : null,
    stateCode,
    districtName: cd.NAME || null,
    district,
    atLarge,
    geoid: String(cd.GEOID),
    districtSource: cdLayer,
  }, false);
}

// ---- 2. District -> representative (our own data/index.json) ----
async function finishLookup(url, env, result, fromCode) {
  let index;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/index.json', url)));
    if (!res.ok) throw new Error(`index status ${res.status}`);
    index = await res.json();
  } catch {
    return reply(500, { error: 'data_unavailable', message: 'Our representative data could not be loaded. Please try again later.' });
  }
  result.dataUpdated = index.updated || null;
  result.representative = null;

  const inState = index.states?.[result.stateCode] || [];
  // "/ny" alone isn't a district: New York has many seats.
  if (fromCode && result.atLarge && inState.length > 1) {
    return reply(404, { error: 'unknown_district', message: "That district doesn't exist. Look up your representative by address instead." });
  }
  result.code = districtCode(result.stateCode, result.district, result.atLarge);
  const rep = findRep(index, result.stateCode, result.district);

  if (rep) {
    result.representative = { bioguideId: rep.bioguideId, name: rep.name };
  } else {
    result.note = 'No current representative was found for this district. The seat may be vacant.';
  }
  return reply(200, result);
}
