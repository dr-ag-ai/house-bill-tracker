// ============================================================================
// RepTracker — the code that runs in the visitor's browser
// ----------------------------------------------------------------------------
// 1. Finds the district and representative, by street address, by the
//    visitor's location, by a spot picked on a map, or from a district page
//    address like /ny-12.
// 2. Loads that representative's file plus the shared vote and bill lists
//    made by the nightly job, and puts them together into one row per bill.
// 3. Shows the representative (with a short snapshot), the district map,
//    contact details and the bill list, with filters.
// 4. Gives every result its own shareable link (/ny-12). The link never
//    contains a street address.
// ============================================================================

const $ = id => document.getElementById(id);
const PAGE_SIZE = 50;

let allRows = [];    // every bill for this representative
let shownCount = PAGE_SIZE;
let map = null;
let current = null;  // the district currently shown: { code, title }

// ---------- Small helpers ---------------------------------------------------

// "2025-03-14" -> "03/2025"
const monthYear = d => (d ? `${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const number = n => Number(n).toLocaleString('en-US');

// Builds an element: el('a', { href: '...' }, 'text', otherElement)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Request failed (${res.status})`), { body });
  return body;
}

// ---------- Bills: names and links ------------------------------------------

const BILL_TYPES = {
  hr:      ['H.R.',       'house-bill'],
  hres:    ['H.Res.',     'house-resolution'],
  hjres:   ['H.J.Res.',   'house-joint-resolution'],
  hconres: ['H.Con.Res.', 'house-concurrent-resolution'],
  s:       ['S.',         'senate-bill'],
  sres:    ['S.Res.',     'senate-resolution'],
  sjres:   ['S.J.Res.',   'senate-joint-resolution'],
  sconres: ['S.Con.Res.', 'senate-concurrent-resolution'],
};

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "119-hr-9497" -> label "H.R. 9497" and its Congress.gov pages
function billInfo(id) {
  const [congress, type, num] = id.split('-');
  const [label, slug] = BILL_TYPES[type] || [type.toUpperCase(), null];
  const page = slug ? `https://www.congress.gov/bill/${ordinal(Number(congress))}-congress/${slug}/${num}` : null;
  return { label: `${label} ${num}`, congress: Number(congress), summaryUrl: page, textUrl: page && `${page}/text` };
}

// Procedural "rules": resolutions that set the terms of debate for other bills.
const RULE_TITLE = /^(providing for|relating to) (the )?(further )?consideration/i;

// The vote that counts as "final": the latest vote to pass or agree to the
// bill, accept the Senate's changes, or override a veto. If there was none,
// the latest vote of any kind.
const FINAL_VOTE = /passage|suspend the rules and (pass|agree)|agreeing to the resolution|concur|override/i;

// Plain-language names for the House's official motion wording.
// "Fast-track" = "suspension of the rules": quicker, but needs two-thirds to pass.
function voteLabel(question) {
  const q = (question || '').toLowerCase();
  let label;
  if (/override|objections of the president/.test(q)) label = 'Overriding a veto';
  else if (/concur/.test(q)) label = "Accepting the Senate's changes";
  else if (/conference report/.test(q)) label = 'The final compromise version';
  else if (/passage|and pass/.test(q)) label = 'Final passage';
  else if (/agree(ing)? to the resolution|rules and agree/.test(q)) label = 'Approving the resolution';
  else if (/amendment/.test(q)) label = 'An amendment';
  else if (/recommit/.test(q)) label = 'Sending it back to committee';
  else if (/previous question/.test(q)) label = 'Ending debate (procedural)';
  else if (/table/.test(q)) label = 'Setting it aside (procedural)';
  else if (/consideration/.test(q)) label = 'Whether to take it up (procedural)';
  else if (/instruct/.test(q)) label = 'Instructions to negotiators';
  else if (/refer/.test(q)) label = 'Sending it to committee';
  else label = (question || 'A vote').replace(/^on (the )?/i, '');
  return /suspend the rules/.test(q) ? `${label}, fast-track` : label;
}

// "Passed", "Failed", "Agreed to", "Not Agreed to" -> lower case for sentences.
const resultText = r => (r ? String(r).toLowerCase() : '');

function voteClass(position) {
  const p = (position || '').toLowerCase();
  if (p === 'yea' || p === 'aye') return 'yea';
  if (p === 'nay' || p === 'no') return 'nay';
  if (p === 'present') return 'present';
  return 'absent';
}

// ---------- Put the pieces together: one row per bill -----------------------

function buildRows(member, votes, bills) {
  const rows = new Map();
  const rowFor = id => {
    if (!rows.has(id)) {
      const [title, subject] = bills[id] || [];
      rows.set(id, { id, title: title || null, subject: subject || null, sponsoredDate: null, votes: [] });
    }
    return rows.get(id);
  };

  // member.sponsored: [bill ID, title, subject, date introduced]
  for (const [id, title, subject, date] of member.sponsored || []) {
    const row = rowFor(id);
    row.title = title || row.title;
    row.subject = subject || row.subject;
    row.sponsoredDate = date;
  }

  // member.votes: { vote key: position }; votes[key] = [date, question, bill ID, result]
  for (const [key, position] of Object.entries(member.votes || {})) {
    const v = votes[key];
    if (!v || !v[2]) continue;
    rowFor(v[2]).votes.push({ date: v[0], question: v[1], result: v[3] || null, position });
  }

  return [...rows.values()].map(row => {
    row.votes.sort((a, b) => a.date.localeCompare(b.date));
    const final = row.votes.filter(v => FINAL_VOTE.test(v.question)).at(-1) || row.votes.at(-1) || null;
    return {
      ...row,
      ...billInfo(row.id),
      final,
      sponsored: Boolean(row.sponsoredDate),
      voted: row.votes.length > 0,
      isRule: RULE_TITLE.test(row.title || ''),
      latest: [final?.date, row.sponsoredDate].filter(Boolean).sort().at(-1) || '',
    };
  });
}

// ---------- Filters ---------------------------------------------------------

const DEFAULTS = { 'f-period': '2023', 'f-role': 'any', 'f-subject': '', 'f-order': 'new' };

function filtersActive() {
  return Object.entries(DEFAULTS).some(([id, v]) => $(id).value !== v)
    || $('f-rules').checked || $('f-search').value.trim() !== '';
}

function clearFilters() {
  for (const [id, v] of Object.entries(DEFAULTS)) $(id).value = v;
  $('f-rules').checked = false;
  $('f-search').value = '';
  shownCount = PAGE_SIZE;
  renderTable();
}

function filteredRows() {
  const period = $('f-period').value;
  const role = $('f-role').value;
  const subject = $('f-subject').value;
  const showRules = $('f-rules').checked;
  const words = $('f-search').value.trim().toLowerCase();

  const list = allRows.filter(r => {
    if (period === '2023' && r.latest < '2023-01-01') return false;
    if (role === 'sponsored' && !r.sponsored) return false;
    if (role === 'voted' && !r.voted) return false;
    if (subject && r.subject !== subject) return false;
    if (!showRules && r.isRule && !r.sponsored) return false;
    if (words && !`${r.label} ${r.title || ''}`.toLowerCase().includes(words)) return false;
    return true;
  });
  const dir = $('f-order').value === 'old' ? 1 : -1;
  return list.sort((a, b) => dir * a.latest.localeCompare(b.latest) || a.label.localeCompare(b.label));
}

function fillSubjects() {
  const subjects = [...new Set(allRows.map(r => r.subject).filter(Boolean))].sort();
  $('f-subject').replaceChildren(el('option', { value: '' }, 'All subjects'), ...subjects.map(s => el('option', { value: s }, s)));
}

// How many of the tucked-away filters are changed, shown on the button.
function updateMoreFiltersButton() {
  const n = ['f-period', 'f-role', 'f-order'].filter(id => $(id).value !== DEFAULTS[id]).length + ($('f-rules').checked ? 1 : 0);
  $('more-filters').textContent = n ? `More filters (${n})` : 'More filters';
}

// ---------- Draw the bill list ----------------------------------------------

const LONG_TITLE = 140;   // characters; longer titles are cut to two lines

function billCell(r) {
  const long = (r.title || '').length > LONG_TITLE;
  const title = r.title
    ? (r.summaryUrl
        ? el('a', { class: 'bill-title', href: r.summaryUrl, target: '_blank', rel: 'noopener' }, r.title)
        : el('span', { class: 'bill-title' }, r.title))
    : el('span', { class: 'bill-title untitled' }, 'Title not yet available');
  return el('td', { class: 'cell-bill' },
    el('div', { class: long ? 'title-wrap clamped' : 'title-wrap' }, title),
    long && el('button', {
      type: 'button', class: 'text-button small', 'aria-expanded': 'false',
      onclick: e => {
        const wrap = e.currentTarget.previousElementSibling;
        const open = wrap.classList.toggle('clamped') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.textContent = open ? 'Show less' : 'Show full title';
      },
    }, 'Show full title'),
    el('p', { class: 'bill-meta' },
      r.sponsored && el('span', { class: 'badge' }, 'Sponsored'),
      el('span', {}, r.label),
      r.subject && el('span', {}, r.subject),
      r.textUrl && el('a', { href: r.textUrl, target: '_blank', rel: 'noopener' }, 'Full text')));
}

function voteCell(r) {
  if (!r.final) return el('td', { class: 'cell-vote' }, el('span', { class: 'no-vote' }, 'No House vote yet'));
  const what = voteLabel(r.final.question);
  return el('td', { class: 'cell-vote' },
    el('span', { class: `vote ${voteClass(r.final.position)}` }, r.final.position),
    el('span', { class: 'vote-on' },
      `on ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
      r.final.result && el('span', { class: 'vote-result' }, ` · ${resultText(r.final.result)}`)),
    el('button', {
      type: 'button', class: 'text-button small', 'aria-expanded': 'false',
      onclick: e => toggleVotes(e.currentTarget, r),
    }, r.votes.length === 1 ? 'See the vote ▾' : `See all ${r.votes.length} votes ▾`));
}

function renderTable() {
  const list = filteredRows();
  const body = $('rows');
  body.replaceChildren();

  for (const r of list.slice(0, shownCount)) {
    body.append(el('tr', { class: 'bill-row' },
      billCell(r),
      voteCell(r),
      el('td', { class: 'cell-date' },
        r.sponsoredDate && el('span', { class: 'date-line' }, el('span', {}, 'Sponsored '), monthYear(r.sponsoredDate)),
        r.final && el('span', { class: 'date-line' }, el('span', {}, 'Voted '), monthYear(r.final.date))),
    ));
  }

  const total = list.length;
  $('count').textContent = total === 0 ? '' :
    `${total <= shownCount ? `${number(total)} bill${total === 1 ? '' : 's'}` : `Showing ${shownCount} of ${number(total)} bills`} · votes updated nightly`;
  $('bill-table').hidden = total === 0;
  $('more').hidden = total <= shownCount;
  $('clear-filters').hidden = !filtersActive();
  updateMoreFiltersButton();

  // Nothing matches: say what was searched, and offer a way out.
  const words = $('f-search').value.trim();
  $('empty').hidden = total > 0;
  $('empty-text').textContent = words ? `No bills match “${words}” with these filters.` : 'No bills match these filters.';
}

// Opens or closes the list of every vote on one bill, just under its row.
function toggleVotes(button, r) {
  const row = button.closest('tr');
  const open = button.getAttribute('aria-expanded') === 'true';
  if (open) {
    row.nextElementSibling?.classList.contains('vote-list-row') && row.nextElementSibling.remove();
    button.setAttribute('aria-expanded', 'false');
    button.textContent = button.textContent.replace('▴', '▾');
    return;
  }
  const items = [...r.votes].reverse().map(v =>
    el('li', {},
      el('span', { class: 'when' }, monthYear(v.date)),
      el('span', { class: 'what' },
        el('span', {}, voteLabel(v.question), v.result && el('span', { class: 'vote-result' }, ` · ${resultText(v.result)}`)),
        el('span', { class: 'official' }, v.question || '')),
      el('span', { class: `vote ${voteClass(v.position)}` }, v.position)));
  row.after(el('tr', { class: 'vote-list-row' }, el('td', { colspan: '3' }, el('ul', { class: 'vote-list' }, items))));
  button.setAttribute('aria-expanded', 'true');
  button.textContent = button.textContent.replace('▾', '▴');
}

// ---------- Representative, snapshot, contact, map --------------------------

function districtLabel(info, member) {
  if (info.atLarge) return member?.state ? `${member.state}, whole state or territory` : 'Whole state or territory';
  return `${member?.state || ''} ${ordinal(info.district)} District`.trim();
}

function showMember(info, member) {
  const [last, first] = (member.name || '').split(', ');
  const name = first ? `${first} ${last}` : member.name;
  // DC and the territories send non-voting members. Puerto Rico's is called
  // the Resident Commissioner; the others are Delegates.
  const title = info.stateCode === '72' ? 'Resident Commissioner'
    : (info.stateCode === '11' || Number(info.stateCode) >= 60) ? 'Delegate'
    : 'Representative';

  $('rep-role').textContent = `${title} for ${districtLabel(info, member)}`;
  $('rep-name').textContent = name;
  $('rep-party').textContent = member.party || '';

  // Where the lookup started, in normal case (the Census sends capitals).
  const tidy = s => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/, ([A-Z][a-z]),/g, (m, st) => `, ${st.toUpperCase()},`);
  $('rep-address-text').textContent = info.matchedAddress ? `Matched address: ${tidy(info.matchedAddress)}`
    : info.locationLabel ? `Looked up from ${info.locationLabel.toLowerCase()}` : '';
  $('rep-address').hidden = !info.matchedAddress && !info.locationLabel;

  const photo = $('rep-photo');
  if (member.photo) { photo.src = member.photo; photo.alt = `Official photo of ${name}`; photo.hidden = false; }
  else photo.hidden = true;

  // Snapshot: four plain counts from data already loaded.
  const positions = Object.values(member.votes || {});
  const missed = positions.filter(p => /not voting/i.test(p)).length;
  const cast = positions.length - missed;
  const stats = [
    member.houseSince && [String(member.houseSince), 'In the House since'],
    [number((member.sponsored || []).length), 'Bills sponsored, whole career'],
    [number(cast), 'Votes cast on bills since 2023'],
    [number(missed), 'Votes missed (“Not Voting”)'],
  ].filter(Boolean);
  $('snapshot').replaceChildren(...stats.map(([value, label]) =>
    el('div', { class: 'stat' }, el('span', { class: 'stat-value' }, value), el('span', { class: 'stat-label' }, label))));

  const phone = member.phone ? member.phone.replace(/[^\d+]/g, '') : null;
  $('c-phone').replaceChildren(member.phone ? el('a', { href: `tel:${phone}` }, member.phone) : 'Not listed');
  $('call-button').hidden = !phone;
  if (phone) $('call-button').href = `tel:${phone}`;
  $('c-office').textContent = member.office || 'Not listed';
  $('c-web').replaceChildren(member.website
    ? el('a', { href: member.website, target: '_blank', rel: 'noopener' }, member.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))
    : 'Not listed');
}

// Alaska's Aleutian Islands cross the 180° line, where longitude jumps from
// +180 to -180. Seen as-is, the district seems to stretch around the whole
// globe. If a shape spans more than half the world, move its eastern points
// 360° west so it reads as one piece (the map draws longitudes past -180 fine).
function crossDateLine(shape) {
  const lons = shape.geometry.coordinates.flat(2).map(pt => pt[0]);
  if (Math.max(...lons) - Math.min(...lons) <= 180) return shape;
  const shift = ring => ring.map(([lon, lat]) => [lon > 0 ? lon - 360 : lon, lat]);
  return { ...shape, geometry: { ...shape.geometry, coordinates: shape.geometry.coordinates.map(poly => poly.map(shift)) } };
}

async function showMap(info) {
  const caption = $('map-caption');
  caption.textContent = info.districtName || '';
  if (!window.maplibregl) {
    $('map').replaceChildren(el('p', { class: 'fine', style: 'padding:16px' }, 'The map could not be loaded.'));
    return;
  }
  // District pages (/ny-12) have no address, so no pin; the outline sets the view.
  const center = info.coordinates ? [info.coordinates.lon, info.coordinates.lat] : [-98.5, 39.8];
  if (!map) {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center, zoom: info.coordinates ? 9 : 3,
      attributionControl: { compact: true },
      cooperativeGestures: true,   // scroll the page normally; use two fingers or Ctrl to zoom the map
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    await new Promise(r => map.once('load', r));
  }

  for (const id of ['district-fill', 'district-line']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('district')) map.removeSource('district');
  map._marker?.remove();
  map._marker = null;
  if (info.coordinates) {
    map._marker = new maplibregl.Marker({ color: '#0B5D5E' }).setLngLat(center).addTo(map);
  }

  try {
    const q = new URLSearchParams({ geoid: info.geoid });
    if (info.districtSource) q.set('layer', info.districtSource);
    const shape = crossDateLine(await getJson(`/api/district?${q}`));
    map.addSource('district', { type: 'geojson', data: shape });
    map.addLayer({ id: 'district-fill', type: 'fill', source: 'district', paint: { 'fill-color': '#0B5D5E', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'district-line', type: 'line', source: 'district', paint: { 'line-color': '#0B5D5E', 'line-width': 2.5 } });
    const bounds = new maplibregl.LngLatBounds();
    for (const poly of shape.geometry.coordinates) for (const ring of poly) for (const pt of ring) bounds.extend(pt);
    map.fitBounds(bounds, { padding: 24, duration: 0 });
  } catch {
    map.jumpTo({ center, zoom: info.coordinates ? 11 : 3 });
    caption.textContent = `${info.districtName || ''}. The district outline couldn't be loaded.`;
  }
}

// ---------- The lookup ------------------------------------------------------

// "query" is { address }, { lat, lon }, or { code } (a district page like ny-12).
async function lookup(query, { fromPage = false } = {}) {
  $('go').disabled = true;
  setStatus('Looking up the district…');
  try {
    const { label, ...params } = query;   // the label is for this page only, not sent anywhere
    const info = await getJson(`/api/lookup?${new URLSearchParams(params)}`);
    if (label) info.locationLabel = label;

    // Give the result its own address (/ny-12) so it can be bookmarked,
    // shared, and survives a refresh. Never the street address.
    if (info.code && !fromPage && location.pathname !== `/${info.code}`) {
      history.pushState({ code: info.code }, '', `/${info.code}`);
    }

    if (!info.representative) {
      $('results').hidden = true;
      setStatus(`${info.districtName || 'This district'}: ${info.note || 'no current representative was found.'}`, true);
      return;
    }

    setStatus('Loading bills and votes…');
    const id = info.representative.bioguideId;
    const [member, votes, bills] = await Promise.all([
      getJson(`/data/members/${id}.json`),
      getJson('/data/votes.json'),
      getJson('/data/bills.json'),
    ]);

    showMember(info, member);
    const [last, first] = (member.name || '').split(', ');
    current = { code: info.code, title: `${first ? `${first} ${last}` : member.name} (${(info.code || '').toUpperCase()}) · RepTracker` };
    document.title = current.title;

    allRows = buildRows(member, votes, bills);
    fillSubjects();
    shownCount = PAGE_SIZE;
    renderTable();
    $('updated').textContent = info.dataUpdated
      ? `Last updated ${new Date(info.dataUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : '';

    $('results').hidden = false;
    setStatus(member.complete === false
      ? 'Contact details and sponsored bills for this representative are still being collected and will appear within a day.'
      : '');
    showMap(info);   // the map loads in the background
    if (!fromPage) $('rep-name').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    $('results').hidden = true;
    setStatus(err.message || 'Something went wrong. Please try again.', true);
  } finally {
    $('go').disabled = false;
  }
}

// ---------- Address form ----------------------------------------------------

$('lookup').addEventListener('submit', e => {
  e.preventDefault();
  const address = $('address').value.trim();
  if (!address) {
    // Our own message, in place of the browser's "Please fill out this field".
    $('address').setAttribute('aria-invalid', 'true');
    setStatus('Enter your street address to find your representative.', true);
    $('address').focus();
    return;
  }
  $('address').removeAttribute('aria-invalid');
  lookup({ address });
});
$('address').addEventListener('input', () => $('address').removeAttribute('aria-invalid'));

// "Not your address?" jumps back to the box.
$('change-address').addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('address').focus();
  $('address').select();
});

// ---------- Share -----------------------------------------------------------

$('share').addEventListener('click', async () => {
  const url = location.href;
  try {
    if (navigator.share) { await navigator.share({ title: current?.title || document.title, url }); return; }
    await navigator.clipboard.writeText(url);
    $('share-note').textContent = 'Link copied.';
  } catch {
    $('share-note').textContent = url;   // fallback: show the link to copy by hand
  }
  setTimeout(() => { $('share-note').textContent = ''; }, 4000);
});

// ---------- Filters ---------------------------------------------------------

for (const id of ['f-period', 'f-role', 'f-subject', 'f-order', 'f-rules']) {
  $(id).addEventListener('change', () => { shownCount = PAGE_SIZE; renderTable(); });
}
let typing;
$('f-search').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => { shownCount = PAGE_SIZE; renderTable(); }, 200);
});
$('more').addEventListener('click', () => { shownCount += PAGE_SIZE; renderTable(); });
$('more-filters').addEventListener('click', () => {
  const open = $('filter-panel').hidden;
  $('filter-panel').hidden = !open;
  $('more-filters').setAttribute('aria-expanded', String(open));
});
$('clear-filters').addEventListener('click', clearFilters);
$('empty-clear').addEventListener('click', clearFilters);

// ---------- Without an address: current location or a spot on the map -------

$('use-location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus("This browser can't share your location. Pick the spot on a map instead.", true);
    return;
  }
  setStatus('Asking your browser for your location…');
  navigator.geolocation.getCurrentPosition(
    pos => lookup({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your current location' }),
    () => setStatus("Your location couldn't be read. Check that location access is allowed for this site, or pick the spot on a map instead.", true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

let picker = null, pickerPin = null;
$('pick-on-map').addEventListener('click', () => {
  const wrap = $('picker-wrap');
  const open = wrap.hidden;
  wrap.hidden = !open;
  $('pick-on-map').setAttribute('aria-expanded', String(open));
  if (!open) return;
  if (!window.maplibregl) {
    $('picker').replaceChildren(el('p', { class: 'fine', style: 'padding:16px' }, 'The map could not be loaded.'));
    return;
  }
  if (picker) { picker.resize(); return; }
  picker = new maplibregl.Map({
    container: 'picker',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [-98.5, 39.8],   // the middle of the continental U.S.
    zoom: 3.3,
    attributionControl: { compact: true },
    cooperativeGestures: true,
  });
  picker.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  picker.on('click', e => {
    const { lng, lat } = e.lngLat.wrap();
    if (picker.getZoom() < 12) {
      // Too far out to be sure which side of a district line the spot is on.
      picker.easeTo({ center: [lng, lat], zoom: Math.min(picker.getZoom() + 4, 14) });
      setStatus('Zoom in a little more, then click the exact spot.');
      return;
    }
    pickerPin?.remove();
    pickerPin = new maplibregl.Marker({ color: '#0B5D5E' }).setLngLat([lng, lat]).addTo(picker);
    lookup({ lat: lat.toFixed(6), lon: lng.toFixed(6), label: 'The spot you picked on the map' });
  });
});

// ---------- District pages and the Back button -----------------------------

// /ny-12, /wy, /dc ... ; anything else is the home page.
const codeFromPath = () => {
  const m = /^\/([a-z]{2}(?:-\d{1,2})?)\/?$/i.exec(location.pathname);
  return m ? m[1].toLowerCase() : null;
};

function showHome() {
  $('results').hidden = true;
  setStatus('');
  document.title = 'RepTracker · Track your House Representative’s Activity on Capitol Hill';
  current = null;
}

window.addEventListener('popstate', () => {
  const code = codeFromPath();
  if (code) lookup({ code }, { fromPage: true }); else showHome();
});

// On arrival: a district page loads its result; the home page focuses the box
// on computers (on phones that would pop up the keyboard straight away).
{
  const code = codeFromPath();
  // An address typed on the "page not found" page is handed over once, then forgotten.
  let handed = null;
  try { handed = sessionStorage.getItem('rt-address'); sessionStorage.removeItem('rt-address'); } catch { /* storage blocked */ }
  if (code) lookup({ code }, { fromPage: true });
  else if (handed) { $('address').value = handed; lookup({ address: handed }); }
  else if (matchMedia('(pointer: fine) and (min-width: 701px)').matches) $('address').focus();
}
