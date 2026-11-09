// ============================================================================
// House Bill Tracker — nightly data job
// ----------------------------------------------------------------------------
// What this does, in plain English:
//   1. Gets the list of everyone currently serving in the US House.
//   2. For each of them, gets their contact details and the bills they sponsored.
//   3. Gets every House roll-call vote since 2023, and how each member voted.
//      Votes already downloaded on a previous night are remembered (cached),
//      so after the first run only NEW votes are downloaded.
//   4. Looks up the title and subject of each bill that was voted on.
//   5. Saves the results as small files the website reads:
//        data/index.json          which representative serves which district
//        data/votes.json          every House vote: date, question, which bill
//        data/bills.json          title and subject of every bill voted on
//        data/members/<ID>.json   one per representative: contact details,
//                                 sponsored bills, and how they voted
//      Shared information (vote descriptions, bill titles) is stored once,
//      not copied into all 435 representative files. That keeps the data
//      small. The website puts the pieces together for the visitor.
//
// How to run it:
//   Test mode (one representative, 15 recent votes, saves into data-test/):
//       node scripts/nightly.mjs --test
//   Test a different representative:
//       node scripts/nightly.mjs --test --member=V000081
//   Full run (everyone, saves into data/):
//       node scripts/nightly.mjs
//
// It needs your Congress.gov key in an environment variable named
// CONGRESS_API_KEY. It never prints or saves the key.
// ============================================================================

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// ---------- Settings --------------------------------------------------------

const API = 'https://api.congress.gov/v3';
const KEY = process.env.CONGRESS_API_KEY;

const args = process.argv.slice(2);
const TEST = args.includes('--test');
const memberArg = args.find(a => a.startsWith('--member='));
const ONLY_MEMBER = memberArg ? memberArg.split('=')[1] : (TEST ? 'N000002' : null);
const TEST_VOTE_COUNT = 15;

// Test output goes in a separate folder so it never mixes with the real data.
const OUT = path.resolve(TEST ? 'data-test' : 'data');
const CACHE = path.join(OUT, 'cache');

// Congress.gov allows about 5,000 requests per hour. Waiting 0.75 seconds
// between requests keeps us safely under that (about 4,800 per hour).
const PAUSE_MS = 750;

// House vote data on Congress.gov starts with the 118th Congress (2023).
const FIRST_CONGRESS_WITH_VOTES = 118;

// ---------- Small helpers ---------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...m) => console.log(...m);
const toArray = x => (Array.isArray(x) ? x : x == null ? [] : [x]);

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

// Saves a file, but only if its contents actually changed. That way the
// nightly update only touches files with something new in them.
async function writeJson(file, data) {
  const text = JSON.stringify(data);
  let old = null;
  try { old = await readFile(file, 'utf8'); } catch { /* new file */ }
  if (old === text) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return true;
}

// "2025-03-14" or "2025-03-14T18:30:00-04:00"  ->  "03/2025"
function monthYear(dateText) {
  if (!dateText) return null;
  const [y, m] = dateText.slice(0, 10).split('-');
  return m && y ? `${m}/${y}` : null;
}

// Which Congress is in session today (a new one starts every odd year).
function currentCongress() {
  return Math.floor((new Date().getUTCFullYear() - 1789) / 2) + 1;
}

const normType = t => String(t || '').replace(/[\s.]/g, '').toLowerCase();

// How bill types are written for people (used only in the test summary;
// the website has its own copy of this list).
const BILL_LABELS = {
  hr: 'H.R.', hres: 'H.Res.', hjres: 'H.J.Res.', hconres: 'H.Con.Res.',
  s: 'S.', sres: 'S.Res.', sjres: 'S.J.Res.', sconres: 'S.Con.Res.',
};
function billLabel(billId) {
  const [, type, number] = billId.split('-');
  return `${BILL_LABELS[type] || type.toUpperCase()} ${number}`;
}

// State names (and postal codes) -> the 2-digit codes the Census uses.
// The website gets these codes from the Census geocoder (the "36" in "3612").
const STATE_FIPS = {
  Alabama:'01', Alaska:'02', Arizona:'04', Arkansas:'05', California:'06', Colorado:'08',
  Connecticut:'09', Delaware:'10', 'District of Columbia':'11', Florida:'12', Georgia:'13',
  Hawaii:'15', Idaho:'16', Illinois:'17', Indiana:'18', Iowa:'19', Kansas:'20', Kentucky:'21',
  Louisiana:'22', Maine:'23', Maryland:'24', Massachusetts:'25', Michigan:'26', Minnesota:'27',
  Mississippi:'28', Missouri:'29', Montana:'30', Nebraska:'31', Nevada:'32', 'New Hampshire':'33',
  'New Jersey':'34', 'New Mexico':'35', 'New York':'36', 'North Carolina':'37', 'North Dakota':'38',
  Ohio:'39', Oklahoma:'40', Oregon:'41', Pennsylvania:'42', 'Rhode Island':'44',
  'South Carolina':'45', 'South Dakota':'46', Tennessee:'47', Texas:'48', Utah:'49', Vermont:'50',
  Virginia:'51', Washington:'53', 'West Virginia':'54', Wisconsin:'55', Wyoming:'56',
  'American Samoa':'60', Guam:'66', 'Northern Mariana Islands':'69', 'Puerto Rico':'72',
  'Virgin Islands':'78', 'U.S. Virgin Islands':'78',
  AL:'01', AK:'02', AZ:'04', AR:'05', CA:'06', CO:'08', CT:'09', DE:'10', DC:'11', FL:'12',
  GA:'13', HI:'15', ID:'16', IL:'17', IN:'18', IA:'19', KS:'20', KY:'21', LA:'22', ME:'23',
  MD:'24', MA:'25', MI:'26', MN:'27', MS:'28', MO:'29', MT:'30', NE:'31', NV:'32', NH:'33',
  NJ:'34', NM:'35', NY:'36', NC:'37', ND:'38', OH:'39', OK:'40', OR:'41', PA:'42', RI:'44',
  SC:'45', SD:'46', TN:'47', TX:'48', UT:'49', VT:'50', VA:'51', WA:'53', WV:'54', WI:'55',
  WY:'56', AS:'60', GU:'66', MP:'69', PR:'72', VI:'78',
};

// ---------- Talking to Congress.gov ----------------------------------------

let lastCall = 0;
let requestCount = 0;

// Asks Congress.gov one question. Waits politely between requests, and
// retries a few times if the site is busy. Returns null for "not found".
async function api(apiPath, params = {}) {
  const url = new URL(API + apiPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', KEY);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = lastCall + PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    requestCount++;

    let res = null;
    try { res = await fetch(url); } catch { /* network hiccup; retry below */ }
    if (res && res.ok) return res.json();
    if (res && res.status === 404) return null;
    if (res && (res.status === 401 || res.status === 403)) {
      throw new Error('Congress.gov rejected the API key. Check that CONGRESS_API_KEY is set correctly.');
    }
    const why = res ? `status ${res.status}` : 'network error';
    const delay = res && res.status === 429 ? 60_000 : 5_000 * attempt;
    log(`   (${why} on ${apiPath}; trying again in ${delay / 1000}s)`);
    await sleep(delay);
  }
  throw new Error(`Gave up on ${apiPath} after 5 tries.`);
}

// Some answers come in pages of up to 250 items. This collects every page.
// "listName" is the name Congress.gov gives the list (e.g. "members").
async function apiAll(apiPath, listName, params = {}) {
  const all = [];
  for (let offset = 0; ; offset += 250) {
    const json = await api(apiPath, { ...params, limit: 250, offset });
    if (!json) break;
    let items = json[listName];
    if (!Array.isArray(items)) {
      items = Object.values(json).find(Array.isArray);
      if (!items) shapeProblem(apiPath, json);
    }
    all.push(...items);
    if (items.length < 250) break;
  }
  return all;
}

// If Congress.gov's answer isn't laid out the way this script expects, stop
// and show the layout, so it can be fixed instead of silently saving nothing.
function shapeProblem(apiPath, json) {
  console.error(`\nUnexpected data layout from ${apiPath}.`);
  console.error('Top-level names in the answer:', Object.keys(json || {}).join(', '));
  console.error('Please copy these two lines into the chat so the script can be adjusted.\n');
  process.exit(1);
}

// ---------- Step 1: current House members ----------------------------------

async function getHouseMembers() {
  log('Step 1: Getting current members of Congress...');
  const everyone = await apiAll('/member', 'members', { currentMember: 'true' });

  // Keep people whose ongoing term (no end year) is in the House.
  // This includes non-voting delegates (DC, Puerto Rico, etc.).
  const house = everyone.filter(m => {
    const ongoing = toArray(m.terms?.item).filter(t => t.endYear == null);
    return ongoing.some(t => t.chamber === 'House of Representatives');
  });
  log(`   Found ${house.length} current House members.`);

  if (ONLY_MEMBER) {
    const one = house.filter(m => m.bioguideId === ONLY_MEMBER);
    if (!one.length) throw new Error(`No current House member with ID ${ONLY_MEMBER}.`);
    return one;
  }
  return house;
}

// ---------- Step 2: contact details and sponsored bills ---------------------

async function getMemberDetails(id) {
  const json = await api(`/member/${id}`);
  const m = json?.member || {};
  const a = m.addressInformation || {};
  return {
    website: m.officialWebsiteUrl || null,
    phone: a.phoneNumber || null,
    office: [a.officeAddress, a.city, a.zipCode].filter(Boolean).join(', ') || null,
  };
}

// Returns a short list per bill: [bill ID, title, subject, date introduced].
// A bill ID looks like "119-hr-1234" (Congress, bill type, number).
async function getSponsored(id) {
  const items = await apiAll(`/member/${id}/sponsored-legislation`, 'sponsoredLegislation');
  // Amendments have no bill type; we only list bills and resolutions.
  return items
    .filter(b => b.type && b.number && b.congress)
    .map(b => [
      `${b.congress}-${normType(b.type)}-${b.number}`,
      b.title || null,
      b.policyArea?.name || null,
      (b.introducedDate || '').slice(0, 10) || null,
    ]);
}

// ---------- Step 3: House votes (cached) ------------------------------------

async function getVotes() {
  log('Step 3: Getting House votes...');
  const latest = currentCongress() + 1; // also catches a new Congress starting
  let list = [];
  for (let c = FIRST_CONGRESS_WITH_VOTES; c <= latest; c++) {
    const votes = await apiAll(`/house-vote/${c}`, 'houseRollCallVotes');
    for (const v of votes) list.push({ ...v, congress: v.congress ?? c });
  }
  log(`   Found ${list.length} House votes since 2023.`);

  if (TEST) {
    // Newest first, then keep just a handful.
    list.sort((a, b) =>
      (b.congress - a.congress) ||
      ((b.sessionNumber ?? 0) - (a.sessionNumber ?? 0)) ||
      ((b.rollCallNumber ?? 0) - (a.rollCallNumber ?? 0)));
    list = list.slice(0, TEST_VOTE_COUNT);
    log(`   Test mode: using the ${list.length} most recent.`);
  }

  const results = [];
  let downloaded = 0;
  for (const v of list) {
    const c = v.congress, s = v.sessionNumber, r = v.rollCallNumber;
    if (s == null || r == null) continue;
    const file = path.join(CACHE, 'votes', `${c}-${s}-${r}.json`);

    let vote = await readJson(file);
    if (!vote) {
      const json = await api(`/house-vote/${c}/${s}/${r}/members`);
      if (!json) continue;
      const body = json.houseRollCallVoteMemberVotes
        ?? Object.values(json).find(x => x && Array.isArray(x.results));
      if (!body) shapeProblem(`/house-vote/${c}/${s}/${r}/members`, json);

      const casts = {};
      // Note: in vote data the ID is spelled "bioguideID" (capital D).
      for (const p of toArray(body.results)) {
        const id = p.bioguideID ?? p.bioguideId;
        if (id) casts[id] = p.voteCast;
      }
      const type = normType(body.legislationType ?? v.legislationType);
      const number = body.legislationNumber ?? v.legislationNumber;
      vote = {
        key: `${c}-${s}-${r}`,
        date: (body.startDate ?? v.startDate ?? '').slice(0, 10),
        question: body.voteQuestion ?? v.voteQuestion ?? body.voteType ?? v.voteType ?? '',
        bill: type && number ? `${c}-${type}-${number}` : null,
        casts,
      };
      await writeJson(file, vote);
      downloaded++;
      if (downloaded % 50 === 0) log(`   ...downloaded ${downloaded} new votes so far`);
    }
    results.push(vote);
  }
  log(`   ${downloaded} new votes downloaded; ${results.length - downloaded} already saved from earlier runs.`);
  // Votes not tied to a bill (quorum calls, electing the Speaker) are left out.
  return results.filter(v => v.bill);
}

// ---------- Step 4: bill titles and subjects --------------------------------
// bills.json doubles as its own memory: bills already in it aren't looked up again.

async function getBillTitles(votes) {
  log('Step 4: Looking up titles and subjects of bills voted on...');
  const file = path.join(OUT, 'bills.json');
  const bills = (await readJson(file)) || {};
  const needed = [...new Set(votes.map(v => v.bill))].filter(id => !bills[id]?.[0]);
  log(`   ${needed.length} bills to look up.`);

  let done = 0;
  for (const id of needed) {
    const [congress, type, number] = id.split('-');
    const json = await api(`/bill/${congress}/${type}/${number}`);
    const b = json?.bill || {};
    bills[id] = [b.title || null, b.policyArea?.name || null];
    if (++done % 50 === 0) log(`   ...${done} of ${needed.length}`);
  }
  await writeJson(file, bills);
  return bills;
}

// ---------- Putting the pieces together -------------------------------------
// The website will do exactly this in the visitor's browser. It's here too so
// test mode can show what the table will look like.

// Which vote counts as the "final" one for a bill: the latest vote to pass it
// (or agree to it, accept the Senate's changes, or override a veto). If there
// was no such vote, the latest vote of any kind.
const FINAL_VOTE = /passage|suspend the rules and (pass|agree)|agreeing to the resolution|concur|override/i;

function assembleRows(member, votesShared, billsShared) {
  const rows = new Map();
  const rowFor = id => {
    if (!rows.has(id)) {
      const [title, subject] = billsShared[id] || [];
      rows.set(id, { id, title: title || null, subject: subject || null, sponsoredDate: null, votes: [] });
    }
    return rows.get(id);
  };
  for (const [id, title, subject, date] of member.sponsored) {
    const row = rowFor(id);
    row.title = title || row.title;
    row.subject = subject || row.subject;
    row.sponsoredDate = date;
  }
  for (const [voteKey, position] of Object.entries(member.votes)) {
    const v = votesShared[voteKey];
    if (!v) continue;
    const [date, question, billId] = v;
    rowFor(billId).votes.push({ date, question, position });
  }
  return [...rows.values()].map(row => {
    row.votes.sort((a, b) => a.date.localeCompare(b.date));
    const final = row.votes.filter(v => FINAL_VOTE.test(v.question)).at(-1) || row.votes.at(-1) || null;
    const voted = row.votes.length > 0;
    return {
      bill: billLabel(row.id),
      title: row.title,
      subject: row.subject,
      role: row.sponsoredDate && voted ? 'Both' : row.sponsoredDate ? 'Sponsored' : 'Voted',
      sponsored: monthYear(row.sponsoredDate),
      vote: final?.position || null,
      voted: monthYear(final?.date),
      voteCount: row.votes.length,
      sortDate: final?.date || row.sponsoredDate || '',
    };
  }).sort((a, b) => b.sortDate.localeCompare(a.sortDate));
}

// ---------- Run everything --------------------------------------------------

async function main() {
  if (!KEY) {
    console.error('CONGRESS_API_KEY is not set. In this terminal window, run:');
    console.error('  read -s -p "Paste your Congress.gov key, then press Enter: " CONGRESS_API_KEY; echo; export CONGRESS_API_KEY');
    process.exit(1);
  }
  const started = Date.now();
  log(TEST ? `TEST MODE — member ${ONLY_MEMBER}, saving to data-test/\n` : 'FULL RUN — saving to data/\n');

  const members = await getHouseMembers();
  const votes = await getVotes();
  const bills = await getBillTitles(votes);

  // votes.json: { "119-1-5": [date, question, bill ID], ... }
  const votesShared = {};
  for (const v of votes) votesShared[v.key] = [v.date, v.question, v.bill];
  await writeJson(path.join(OUT, 'votes.json'), votesShared);

  log(`Step 5: Building files for ${members.length} member(s)...`);
  const index = {};
  const keep = new Set();
  let done = 0, changed = 0, last = null;
  for (const m of members) {
    const id = m.bioguideId;
    const details = await getMemberDetails(id);
    const sponsored = await getSponsored(id);

    const myVotes = {};
    for (const v of votes) if (v.casts[id] != null) myVotes[v.key] = v.casts[id];

    last = {
      bioguideId: id,
      name: m.name,
      party: m.partyName || null,
      state: m.state || null,
      district: m.district ?? null,
      photo: m.depiction?.imageUrl || null,
      ...details,
      sponsored,
      votes: myVotes,
    };
    if (await writeJson(path.join(OUT, 'members', `${id}.json`), last)) changed++;
    keep.add(`${id}.json`);

    const fips = STATE_FIPS[m.state];
    if (fips) {
      (index[fips] ??= []).push({ district: m.district ?? 0, bioguideId: id, name: m.name });
    } else {
      log(`   Note: unknown state "${m.state}" for ${m.name}; left out of the index.`);
    }
    if (++done % 25 === 0) log(`   ...${done} of ${members.length} done`);
  }

  // Remove files for people no longer in the House (full runs only).
  if (!TEST) {
    const dir = path.join(OUT, 'members');
    for (const f of await readdir(dir)) {
      if (f.endsWith('.json') && !keep.has(f)) { await rm(path.join(dir, f)); log(`   Removed ${f} (no longer serving)`); }
    }
  }

  await writeJson(path.join(OUT, 'index.json'), { updated: new Date().toISOString(), states: index });

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  log(`\nFinished in ${minutes} minutes, using ${requestCount} requests. ${changed} representative file(s) changed.`);

  if (TEST && last) {
    const rows = assembleRows(last, votesShared, bills);
    log(`\n${last.name} — ${last.state}, district ${last.district}`);
    log(`Phone: ${last.phone}   Website: ${last.website}`);
    log(`Photo: ${last.photo ? 'yes' : 'MISSING'}`);
    const counts = rows.reduce((n, r) => (n[r.role]++, n), { Sponsored: 0, Voted: 0, Both: 0 });
    log(`Bills: ${rows.length} total (${counts.Sponsored} sponsored, ${counts.Voted} voted, ${counts.Both} both)\n`);
    log('Most recent bills voted on:');
    console.table(rows.filter(r => r.vote).slice(0, 8).map(r => ({
      Bill: r.bill,
      Title: (r.title || '').slice(0, 45),
      Vote: r.vote,
      Date: r.voted,
      Subject: r.subject,
      Votes: r.voteCount,
    })));
  }
}

main().catch(err => { console.error('\nStopped:', err.message); process.exit(1); });
