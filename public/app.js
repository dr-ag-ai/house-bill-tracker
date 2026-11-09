// ============================================================================
// House Bill Tracker — the code that runs in the visitor's browser
// ----------------------------------------------------------------------------
// 1. Sends the address to our back end (/api/lookup) to find the district
//    and representative.
// 2. Loads that representative's file plus the shared vote and bill lists
//    made by the nightly job, and puts them together into one row per bill.
// 3. Shows the representative, the district map, contact details and the
//    bill table, with filters.
// ============================================================================

const $ = id => document.getElementById(id);
const PAGE_SIZE = 50;

let allRows = [];    // every bill for this representative
let shownCount = PAGE_SIZE;
let map = null;

// ---------- Small helpers ---------------------------------------------------

// "2025-03-14" -> "03/2025"
const monthYear = d => (d ? `${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

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
  const [congress, type, number] = id.split('-');
  const [label, slug] = BILL_TYPES[type] || [type.toUpperCase(), null];
  const page = slug ? `https://www.congress.gov/bill/${ordinal(Number(congress))}-congress/${slug}/${number}` : null;
  return { label: `${label} ${number}`, congress: Number(congress), summaryUrl: page, textUrl: page && `${page}/text` };
}

// Procedural "rules": resolutions that set the terms of debate for other bills.
const RULE_TITLE = /^(providing for|relating to) (the )?(further )?consideration/i;

// The vote that counts as "final": the latest vote to pass or agree to the
// bill, accept the Senate's changes, or override a veto. If there was none,
// the latest vote of any kind.
const FINAL_VOTE = /passage|suspend the rules and (pass|agree)|agreeing to the resolution|concur|override/i;

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

  // member.votes: { vote key: position }; votes[key] = [date, question, bill ID]
  for (const [key, position] of Object.entries(member.votes || {})) {
    const v = votes[key];
    if (!v || !v[2]) continue;
    rowFor(v[2]).votes.push({ date: v[0], question: v[1], position });
  }

  return [...rows.values()].map(row => {
    row.votes.sort((a, b) => a.date.localeCompare(b.date));
    const final = row.votes.filter(v => FINAL_VOTE.test(v.question)).at(-1) || row.votes.at(-1) || null;
    const sponsored = Boolean(row.sponsoredDate);
    const voted = row.votes.length > 0;
    return {
      ...row,
      ...billInfo(row.id),
      final,
      sponsored,
      voted,
      role: sponsored && voted ? 'Sponsored and voted' : sponsored ? 'Sponsored' : 'Voted',
      isRule: RULE_TITLE.test(row.title || ''),
      latest: [final?.date, row.sponsoredDate].filter(Boolean).sort().at(-1) || '',
    };
  });
}

// ---------- Filters ---------------------------------------------------------

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
  const select = $('f-subject');
  select.replaceChildren(el('option', { value: '' }, 'All subjects'), ...subjects.map(s => el('option', { value: s }, s)));
}

// ---------- Draw the bill table ---------------------------------------------

function renderTable() {
  const list = filteredRows();
  const body = $('rows');
  body.replaceChildren();

  for (const r of list.slice(0, shownCount)) {
    const voteCell = r.final
      ? el('td', { 'data-label': 'Vote' },
          el('span', { class: `vote ${voteClass(r.final.position)}` }, r.final.position),
          r.votes.length > 1 || r.final
            ? el('button', {
                type: 'button', class: 'all-votes-btn', 'aria-expanded': 'false',
                onclick: e => toggleVotes(e.currentTarget, r),
              }, r.votes.length === 1 ? 'See the vote' : `See all ${r.votes.length} votes`)
            : null)
      : el('td', { 'data-label': 'Vote' }, el('span', { class: 'no-vote' }, 'No House vote'));

    body.append(el('tr', { class: 'bill-row' },
      el('td', { class: 'cell-bill', 'data-label': 'Bill' },
        el('span', { class: 'bill-label' }, r.label),
        el('p', { class: r.title ? 'bill-title' : 'bill-title untitled' }, r.title || 'Title not yet available')),
      el('td', { 'data-label': 'Role' }, r.role),
      voteCell,
      el('td', { 'data-label': 'Date' },
        r.sponsoredDate && el('span', { class: 'date-line' }, el('span', {}, 'Sponsored '), monthYear(r.sponsoredDate)),
        r.final && el('span', { class: 'date-line' }, el('span', {}, 'Voted '), monthYear(r.final.date))),
      el('td', { 'data-label': 'Subject', class: 'subject' }, r.subject || '—'),
      el('td', { 'data-label': 'Read', class: 'read' },
        r.summaryUrl && el('a', { href: r.summaryUrl, target: '_blank', rel: 'noopener' }, 'Summary'),
        r.textUrl && el('a', { href: r.textUrl, target: '_blank', rel: 'noopener' }, 'Full text')),
    ));
  }

  const total = list.length;
  $('count').textContent = total === 0 ? '' :
    total <= shownCount ? `${total} bill${total === 1 ? '' : 's'}` : `Showing ${shownCount} of ${total} bills`;
  $('empty').hidden = total > 0;
  $('more').hidden = total <= shownCount;
}

// Opens or closes the list of every vote on one bill, just under its row.
function toggleVotes(button, r) {
  const row = button.closest('tr');
  const open = button.getAttribute('aria-expanded') === 'true';
  if (open) {
    row.nextElementSibling?.classList.contains('vote-list-row') && row.nextElementSibling.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  const items = [...r.votes].reverse().map(v =>
    el('li', {},
      el('span', { class: 'when' }, monthYear(v.date)),
      el('span', {}, v.question || 'Vote'),
      el('span', { class: `vote ${voteClass(v.position)}` }, v.position)));
  row.after(el('tr', { class: 'vote-list-row' }, el('td', { colspan: '6' }, el('ul', { class: 'vote-list' }, items))));
  button.setAttribute('aria-expanded', 'true');
}

// ---------- Representative, contact, map ------------------------------------

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
  $('rep-address').textContent = info.matchedAddress ? `Matched address: ${info.matchedAddress}` : '';

  const photo = $('rep-photo');
  if (member.photo) { photo.src = member.photo; photo.alt = `Official photo of ${name}`; photo.hidden = false; }
  else photo.hidden = true;

  $('c-phone').replaceChildren(member.phone ? el('a', { href: `tel:${member.phone.replace(/[^\d+]/g, '')}` }, member.phone) : 'Not listed');
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
  if (!window.maplibregl || !info.coordinates) {
    $('map').replaceChildren(el('p', { class: 'fine', style: 'padding:16px' }, 'The map could not be loaded.'));
    return;
  }
  const center = [info.coordinates.lon, info.coordinates.lat];
  if (!map) {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center, zoom: 9,
      attributionControl: { compact: true },
      cooperativeGestures: true,   // scroll the page normally; use two fingers or Ctrl to zoom the map
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    await new Promise(r => map.once('load', r));
  }

  for (const id of ['district-fill', 'district-line']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('district')) map.removeSource('district');
  map._marker?.remove();
  map._marker = new maplibregl.Marker({ color: getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#0B5D5E' })
    .setLngLat(center).addTo(map);

  try {
    const q = new URLSearchParams({ geoid: info.geoid, layer: info.districtSource || '' });
    const shape = crossDateLine(await getJson(`/api/district?${q}`));
    map.addSource('district', { type: 'geojson', data: shape });
    map.addLayer({ id: 'district-fill', type: 'fill', source: 'district', paint: { 'fill-color': '#0B5D5E', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'district-line', type: 'line', source: 'district', paint: { 'line-color': '#0B5D5E', 'line-width': 2.5 } });
    const bounds = new maplibregl.LngLatBounds();
    for (const poly of shape.geometry.coordinates) for (const ring of poly) for (const pt of ring) bounds.extend(pt);
    map.fitBounds(bounds, { padding: 24, duration: 0 });
  } catch {
    map.jumpTo({ center, zoom: 11 });
    caption.textContent = `${info.districtName || ''}. The district outline couldn't be loaded; the pin shows the address.`;
  }
}

// ---------- The lookup ------------------------------------------------------

async function lookup(address) {
  $('go').disabled = true;
  setStatus('Looking up your district…');
  try {
    const info = await getJson(`/api/lookup?address=${encodeURIComponent(address)}`);
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
    $('rep-name').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    $('results').hidden = true;
    setStatus(err.message || 'Something went wrong. Please try again.', true);
  } finally {
    $('go').disabled = false;
  }
}

// ---------- Wire up the page ------------------------------------------------

$('lookup').addEventListener('submit', e => {
  e.preventDefault();
  lookup($('address').value.trim());
});

for (const id of ['f-period', 'f-role', 'f-subject', 'f-order', 'f-rules']) {
  $(id).addEventListener('change', () => { shownCount = PAGE_SIZE; renderTable(); });
}
let typing;
$('f-search').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => { shownCount = PAGE_SIZE; renderTable(); }, 200);
});
$('more').addEventListener('click', () => { shownCount += PAGE_SIZE; renderTable(); });
