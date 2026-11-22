// Expected-Value Radar's dashboard. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, its filters, a per-protocol detail drawer, the
// live peer reference and the screened register: every pre-token protocol the screen
// set aside, named with its reason. The drawer recomputes each row's expected value
// from the row's own published parts (TVL x category multiple x size adjustment =
// launch value; launch value x odds = expected value) and shows the traded peers the
// price was learned from, so the page and board.json are visibly the same arithmetic.
// No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var params = new URLSearchParams(location.search);
  var SHIPPED = { ev: 1000000, odds: 0.10, mult: 1000 };
  var state = {
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    chain: params.get('chain') || 'all',
    verdict: params.get('verdict') || 'all',
    wl: params.get('wl') === '1',
    tab: params.get('tab') || 'board',
    sort: params.get('sort') || 'rank',
    dir: 1,
    selected: params.get('detail') || null,
    palette: params.get('palette') || 'ledger',
    sb: {
      ev: Number(params.get('sb_ev')) || SHIPPED.ev,
      odds: (Number(params.get('sb_odds')) || SHIPPED.odds * 100) / 100,
      mult: Number(params.get('sb_mult')) || SHIPPED.mult,
    },
  };
  function sandboxOn() {
    return state.sb.ev !== SHIPPED.ev || state.sb.odds !== SHIPPED.odds || state.sb.mult !== SHIPPED.mult;
  }
  function verdictFor(r) {
    if (!sandboxOn()) return r.plan.verdict;
    var ratio = r.implied_value_usd / Math.max(1, r.plan.cost_usd);
    if (r.implied_value_usd >= state.sb.ev && r.odds >= state.sb.odds && ratio >= state.sb.mult) return 'FARM';
    if (r.implied_value_usd >= state.sb.ev / 4 && r.odds >= state.sb.odds * 0.4 && ratio >= state.sb.mult / 10) return 'THIN';
    return 'SKIP';
  }

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var V = DATA.validation;
  var C = DATA.counts;
  var S = V.shipped;
  var O = V.odds;

  // --- header ---------------------------------------------------------------
  var header = el('header', { class: 'top' },
    el('h1', null, 'EXPECTED-VALUE ', el('span', { class: 'x', text: 'RADAR' })),
    el('p', { class: 'tagline', text: 'Every pre-token protocol in the snapshot, ranked by what farming it is worth in expectation: a fitted launch price — what a token would be worth if it came — times fitted odds that one ever comes. Both models are fitted on the snapshot\u2019s own figures and graded below, on this page, before the board they produced.' }),
    el('div', { class: 'meta', text: 'model ' + DATA.version + ' · snapshot ' + DATA.as_of + ' · ' + C.protocols + ' protocols · ' + C.pretoken + ' record no token · board ranks by expected value = launch value \u00d7 odds' })
  );

  // --- the proof strip: the models grading themselves, on frame one ---------
  function proofCell(k, v, small, s) {
    var val = el('div', { class: 'v' }, v);
    if (small) val.appendChild(el('small', { text: ' ' + small }));
    return el('div', { class: 'cell' },
      el('div', { class: 'k', text: k }), val,
      el('div', { class: 's', text: s }));
  }
  var strip = el('section', { class: 'strip' },
    proofCell('Price error, leave-one-out', S.loo.toFixed(3), 'median |log10|',
      'flat baseline ' + S.baselineLoo.toFixed(3) + ' · within 2\u00d7 on ' + Math.round(S.within2x * 100) + '% of ' + V.peers + ' peers priced blind'),
    proofCell('Price error, time split', S.half.toFixed(3), 'older fits, newer priced',
      'flat baseline ' + S.baselineHalf.toFixed(3) + ' · the second holdout: a term ships only if it wins on both'),
    proofCell('Odds skill, held out', O.brier.toFixed(3), 'Brier score',
      'base rate ' + O.baseBrier.toFixed(3) + ' · AUC ' + O.auc.toFixed(3) + ' · fitted on ' + O.trainedOn + ' dated protocols, graded on ' + O.testOn + ' later ones'),
    proofCell('Watchlist coverage', C.watchlist + '/' + C.watchlist, 'on the board',
      'every watchlist protocol is ranked below · ' + C.protocols + ' accounted for: ' + C.trading + ' already trade · ' + C.board + ' ranked · ' + C.set_aside + ' screened aside, each named in the register with its reason'),
    proofCell('Worst miss, unsmoothed', S.worst.name + ' \u00d7' + S.worst.factor, null,
      'the model ' + (S.worst.direction === 'under' ? 'under' : 'over') + '-priced it on leave-one-out — read the rank ranges, not the points'),
    proofCell('Farm verdicts on this board', C.verdicts.FARM + ' FARM', null,
      C.verdicts.THIN + ' THIN · ' + C.verdicts.SKIP + ' SKIP · FARM needs $1M+ of expected value, 10%+ odds and 1,000\u00d7 the plan\u2019s all-in cost; THIN the same at $250K, 4% and 100\u00d7')
  );

  // --- the term table ---------------------------------------------------------
  var termBody = el('tbody');
  V.terms.forEach(function (t) {
    termBody.appendChild(el('tr', null,
      el('td', { text: t.model }),
      el('td', { class: 'num', text: t.loo.toFixed(3) }),
      el('td', { class: 'num', text: t.half.toFixed(3) }),
      el('td', null, el('span', { class: 'chip ' + t.verdict, text: t.verdict.toUpperCase() })),
      el('td', { class: 'note', text: t.note })));
  });
  termBody.appendChild(el('tr', null,
    el('td', { text: 'Odds = logistic on tokenless age, size and growth (multiplies the price)' }),
    el('td', { class: 'num', text: O.foldBrier.toFixed(3) + ' ten-fold' }),
    el('td', { class: 'num', text: O.brier.toFixed(3) + ' time split' }),
    el('td', null, el('span', { class: 'chip kept', text: 'KEPT' })),
    el('td', { class: 'note', text: 'Brier scores: beats the base rate on both holdouts (' + O.foldBaseBrier.toFixed(3) + ' ten-fold, ' + O.baseBrier.toFixed(3) + ' time split) · AUC ' + O.auc.toFixed(3) + ' · age moves whether a launch comes, not what it is worth — so it lives here, not in the price' })));
  termBody.appendChild(el('tr', null,
    el('td', { text: 'Odds + a per-category offset (each category\u2019s residual, shrunk K=40)' }),
    el('td', { class: 'num', text: O.variant.foldBrier.toFixed(3) + ' ten-fold' }),
    el('td', { class: 'num', text: O.variant.splitBrier.toFixed(3) + ' time split' }),
    el('td', null, el('span', { class: 'chip dropped', text: 'DROPPED' })),
    el('td', { class: 'note', text: 'wins the ten-fold split, only ties the time split — a term ships only when it wins on both, so the offsets are out and the shipped odds stand' })));
  var terms = el('section', { class: 'terms' },
    el('h2', { text: 'Every term, tested twice — the ones that failed are out' }),
    el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: 'Candidate model' }),
        el('th', { class: 'num', text: 'Leave-one-out' }),
        el('th', { class: 'num', text: 'Time split' }),
        el('th', { text: 'Verdict' }),
        el('th', { text: 'Why' }))),
      termBody));

  // --- controls ---------------------------------------------------------------
  var search = el('input', { type: 'search', placeholder: 'Search protocols', value: state.q, 'aria-label': 'Search protocols' });
  search.addEventListener('input', function () { state.q = search.value; renderTable(); });
  var catSel = el('select', { 'aria-label': 'Category' });
  catSel.appendChild(el('option', { value: 'all', text: 'All categories' }));
  var cats = [];
  DATA.rows.forEach(function (r) { var c = r.category || 'Uncategorized'; if (cats.indexOf(c) < 0) cats.push(c); });
  cats.sort().forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
  catSel.value = state.category;
  catSel.addEventListener('change', function () { state.category = catSel.value; renderTable(); });
  var chainSel = el('select', { 'aria-label': 'Chain' });
  chainSel.appendChild(el('option', { value: 'all', text: 'All chains' }));
  var chainList = [];
  DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { if (chainList.indexOf(c) < 0) chainList.push(c); }); });
  chainList.sort().forEach(function (c) { chainSel.appendChild(el('option', { value: c, text: c })); });
  chainSel.value = state.chain;
  chainSel.addEventListener('change', function () { state.chain = chainSel.value; renderTable(); });
  var verSel = el('select', { 'aria-label': 'Farm verdict' });
  [['all', 'All verdicts'], ['FARM', 'FARM'], ['THIN', 'THIN'], ['SKIP', 'SKIP']].forEach(function (pair) {
    verSel.appendChild(el('option', { value: pair[0], text: pair[1] }));
  });
  verSel.value = state.verdict;
  verSel.addEventListener('change', function () { state.verdict = verSel.value; renderTable(); });
  var wlBox = el('input', { type: 'checkbox' });
  wlBox.checked = state.wl;
  wlBox.addEventListener('change', function () { state.wl = wlBox.checked; renderTable(); });
  var csvBtn = el('button', { class: 'tool', text: 'Download CSV', onclick: function () { downloadCsv(); } });
  var PALETTES = [['ledger', 'Ledger'], ['slate', 'Slate'], ['plum', 'Plum']];
  var palBtn = el('button', { class: 'tool', text: 'Palette: Ledger', onclick: function () {
    var i = PALETTES.findIndex(function (p) { return p[0] === state.palette; });
    state.palette = PALETTES[(i + 1) % PALETTES.length][0];
    applyPalette();
  } });
  function applyPalette() {
    document.body.setAttribute('data-palette', state.palette);
    PALETTES.forEach(function (p) { if (p[0] === state.palette) palBtn.textContent = 'Palette: ' + p[1]; });
  }
  var tabBoard = el('button', { text: 'Pre-token board', onclick: function () { state.tab = 'board'; renderTable(); } });
  var tabLive = el('button', { text: 'Already trading', onclick: function () { state.tab = 'live'; renderTable(); } });
  var controls = el('div', { class: 'controls' },
    search, catSel, chainSel, verSel,
    el('label', null, wlBox, ' watchlist only'),
    csvBtn, palBtn,
    el('span', { class: 'tabs' }, tabBoard, tabLive));

  // --- the verdict sandbox: the reader's own marks, the board's chips re-derive --
  function sbInput(label, val, step, fn) {
    var input = el('input', { type: 'number', value: String(val), step: String(step), min: '0', 'aria-label': label });
    input.addEventListener('change', function () {
      var n = Number(input.value);
      if (isFinite(n) && n >= 0) { fn(n); renderTable(); }
    });
    return el('label', { class: 'sb' }, label + ' ', input);
  }
  var sandbox = el('div', { class: 'sandbox' },
    el('span', { class: 'sb-title', text: 'Verdict sandbox — your marks:' }),
    sbInput('FARM expected \u2265 $', state.sb.ev, 50000, function (n) { state.sb.ev = n; }),
    sbInput('odds \u2265 %', Math.round(state.sb.odds * 100), 1, function (n) { state.sb.odds = n / 100; }),
    sbInput('cost \u00d7 \u2265', state.sb.mult, 50, function (n) { state.sb.mult = n; }),
    el('span', { class: 'sb-note', text: 'THIN derives at a quarter of the expected mark, 40% of the odds mark and a tenth of the cost mark, as in the shipped rule. Sandbox marks re-derive the chips on this page only — board.json and every drawer keep the shipped verdicts.' }));

  function downloadCsv() {
    var rows = sortedRows(filtered());
    var head = 'rank,name,slug,category,chains,tvl_usd,change_7d,age_days,launch_value_usd,odds,expected_usd,rank_lo,rank_hi,verdict\n';
    var esc = function (v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var body = rows.map(function (r) {
      return [r.rank, r.name, r.slug, r.category || '', r.chains.join(' '), r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.launch_value_usd, r.odds, r.implied_value_usd, r.rank_lo, r.rank_hi, verdictFor(r)].map(esc).join(',');
    }).join('\n');
    var blob = new Blob([head + body + '\n'], { type: 'text/csv' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'expected-value-radar-board.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // --- tables -------------------------------------------------------------------
  var boardWrap = el('section', { class: 'boardwrap', id: 'board' });
  var drawerSlot = el('div');

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorized') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && verdictFor(r) !== state.verdict) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  function sortedRows(rows) {
    var key = state.sort;
    var val = function (r) {
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -1e9 : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      if (key === 'launch') return r.launch_value_usd;
      if (key === 'odds') return r.odds;
      if (key === 'expected') return r.implied_value_usd;
      return r.rank;
    };
    return rows.slice().sort(function (a, b) {
      var d;
      if (key === 'name') d = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
      else if (key === 'rank') d = a.rank - b.rank;
      else d = val(b) - val(a);
      if (d === 0) d = a.rank - b.rank;
      return state.dir * d;
    });
  }
  function sortHead(label, key) {
    var th = el('th', { class: key === 'name' || key === 'rank' ? '' : 'num', text: label + (state.sort === key ? (state.dir > 0 ? ' \u25b2' : ' \u25bc') : '') });
    th.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = 1; }
      renderTable();
    });
    return th;
  }
  function boardTable() {
    var rows = sortedRows(filtered());
    var table = el('table', null,
      el('thead', null, el('tr', null,
        sortHead('#', 'rank'), sortHead('Protocol', 'name'),
        el('th', { text: 'Category' }), el('th', { text: 'Chain' }),
        sortHead('TVL', 'tvl'), sortHead('7d', 'change'), sortHead('Age', 'age'),
        sortHead('Launch value', 'launch'), sortHead('Odds', 'odds'), sortHead('Expected', 'expected'),
        el('th', { class: 'num', text: 'Range' }), el('th', { text: sandboxOn() ? 'Verdict (sandbox)' : 'Verdict' }))),
      el('tbody'));
    var body = table.querySelector('tbody');
    if (rows.length === 0) {
      body.appendChild(el('tr', null, el('td', { class: 'empty', colspan: '12', text: 'No protocol matches these filters.' })));
    }
    rows.forEach(function (r) {
      var v = verdictFor(r);
      var tr = el('tr', { class: state.selected === r.slug ? 'sel' : '' },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', { class: 'name' }, r.name, el('span', { class: 'sub', text: r.slug + (r.watchlist ? ' · watchlist' : '') })),
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { class: 'chains', text: r.chains.length ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) + ' more' : '') : '—' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtUsd(r.launch_value_usd) }),
        el('td', { class: 'num', text: Math.round(r.odds * 100) + '%' }),
        el('td', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
        el('td', { class: 'num', text: r.rank_lo + '–' + r.rank_hi }),
        el('td', null, el('span', { class: 'verdict ' + v, text: v })));
      tr.addEventListener('click', function () { state.selected = r.slug; renderTable(); });
      body.appendChild(tr);
    });
    return table;
  }
  function liveTable() {
    var table = el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: 'Protocol' }), el('th', { text: 'Category' }),
        el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }),
        el('th', { class: 'num', text: 'Cap / TVL' }), el('th', { class: 'num', text: 'Priced blind (LOO)' }),
        el('th', { class: 'num', text: 'Miss' }))),
      el('tbody'));
    var body = table.querySelector('tbody');
    DATA.live.forEach(function (r) {
      body.appendChild(el('tr', null,
        el('td', { class: 'name' }, r.name + (r.symbol ? ' (' + r.symbol + ')' : '')),
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio === null ? 'n/a' : r.ratio.toFixed(2) + '\u00d7' }),
        el('td', { class: 'num', text: r.blind_usd === null ? '—' : fmtUsd(r.blind_usd) }),
        el('td', { class: 'num', text: r.blind_factor === null ? '—' : '\u00d7' + r.blind_factor })));
    });
    return table;
  }

  // --- the detail drawer ---------------------------------------------------------
  function drawer(row) {
    var recomputed = Math.round(row.tvl_usd * row.multiple * row.adjustment);
    var expected = Math.round(recomputed * row.odds);
    var steps = el('ol');
    row.farm_steps.forEach(function (s) { steps.appendChild(el('li', { text: s })); });
    var anchorRows = el('tbody');
    row.anchors.forEach(function (a) {
      anchorRows.appendChild(el('tr', null,
        el('td', { class: 'name' }, a.name + (a.symbol ? ' (' + a.symbol + ')' : ''), el('span', { class: 'sub', text: a.same_category ? 'same category' : (a.category || 'Uncategorized') })),
        el('td', { class: 'num', text: fmtUsd(a.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(a.mcap_usd) }),
        el('td', { class: 'num', text: a.ratio.toFixed(2) + '\u00d7' }),
        el('td', { class: 'num', text: a.blind_factor === null ? '—' : '\u00d7' + a.blind_factor })));
    });
    return el('section', { class: 'drawer' },
      el('button', { class: 'x', text: '\u00d7', onclick: function () { state.selected = null; renderTable(); } }),
      el('h3', { text: row.name }),
      el('div', { class: 'sub', text: (row.category || 'Uncategorized') + ' · ' + (row.chains.join(', ') || 'no chain listed') + ' · ' + row.slug + (row.watchlist ? ' · on the house watchlist' : ' · below the watchlist floor, found by the radar') + ' · rank ' + row.rank + ' of ' + DATA.rows.length + ', range ' + row.rank_lo + '–' + row.rank_hi + ' across 150 pricing refits' }),
      el('div', { class: 'arith', text: 'TVL ' + fmtUsd(row.tvl_usd) + ' \u00d7 category multiple ' + row.multiple.toFixed(3) + ' \u00d7 size adjustment ' + row.adjustment.toFixed(3) + ' = launch value ' + fmtUsd(recomputed) + ' · \u00d7 odds ' + Math.round(row.odds * 100) + '% = expected ' + fmtUsd(expected) }),
      el('div', { class: 'sub', text: 'Odds from the record: a protocol of this age (' + fmtAge(row.age_days) + '), size and seven-day growth (' + fmtPct(row.change_7d) + ') carries fitted odds of ' + Math.round(row.odds * 100) + '% of ever listing a token.' }),
      el('h4', { text: 'Priced from these peers' }),
      el('div', { class: 'sub', text: 'The category multiple ' + row.multiple.toFixed(3) + ' is the shrunk median of cap / TVL over the ' + row.cat_peers + ' traded peer' + (row.cat_peers === 1 ? '' : 's') + ' in this category (shrink K=4 toward the whole peer set\u2019s median), so one wild peer cannot bend it. The nearest of them by size:' }),
      el('table', { class: 'anchors' },
        el('thead', null, el('tr', null,
          el('th', { text: 'Traded peer' }), el('th', { class: 'num', text: 'TVL' }),
          el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Cap / TVL' }),
          el('th', { class: 'num', text: 'Priced blind (LOO)' }))),
        anchorRows),
      el('h4', { text: 'Farm plan — ' + row.plan.verdict }),
      el('div', { class: 'planline', text: 'capital $' + row.plan.capital_usd + ' · hold ' + row.plan.hold_days + ' days · all-in cost $' + row.plan.cost_usd.toFixed(2) + ' (steps plus 5%/yr lockup) · ' + row.plan.minutes + ' minutes of work · expected value ' + fmtUsd(row.implied_value_usd) + ' = ' + Math.round(row.implied_value_usd / Math.max(1, row.plan.cost_usd)).toLocaleString('en-US') + '\u00d7 the plan\u2019s cost' }),
      steps);
  }

  // --- the screened register: every set-aside protocol, named with its reason -----
  function registerSection() {
    var K = C.set_aside_kinds;
    var body = el('tbody');
    DATA.screened.forEach(function (r) {
      body.appendChild(el('tr', null,
        el('td', { class: 'name' }, r.name, el('span', { class: 'sub', text: r.slug })),
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { class: 'chains', text: r.chains.length ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) + ' more' : '') : '—' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'reason', text: r.reason })));
    });
    return el('section', { class: 'register', id: 'register' },
      el('h2', { text: 'The screened register — ' + C.set_aside + ' pre-token protocols set aside, each named with its reason' }),
      el('p', { class: 'regintro', text: 'Nothing pre-token is dropped silently. The screen set these ' + C.set_aside + ' aside before ranking — ' + K.category + ' in wrapper, bridge or staking categories, ' + K.versioned + ' versioned clones, ' + K.wrapped_name + ' wrapped or staked by name' + (K.exchange ? ', ' + K.exchange + ' exchange products' : '') + ' — because a wrapped, bridged or staked token\u2019s value prices the asset underneath it, not a launch of its own, and a clone or an exchange\u2019s own product is not an independent launch either. Ranking one as a launch would misread the snapshot: WBTC records no token here, but it is Bitcoin on Ethereum, not a token still to come. They are not priced and not ranked; they are accounted for, largest first, so the board\u2019s coverage can be checked line by line: ' + C.trading + ' already trade + ' + C.board + ' ranked + ' + C.set_aside + ' here = ' + C.protocols + '.' }),
      el('table', null,
        el('thead', null, el('tr', null,
          el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { text: 'Chain' }),
          el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: '7d' }),
          el('th', { class: 'num', text: 'Age' }), el('th', { text: 'Why the screen set it aside' }))),
        body));
  }

  function renderTable() {
    tabBoard.className = state.tab === 'board' ? 'on' : '';
    tabLive.className = state.tab === 'live' ? 'on' : '';
    boardWrap.textContent = '';
    boardWrap.appendChild(el('h2', { text: state.tab === 'board' ? 'The board — pre-token protocols by expected value' : 'Already trading — the peers the price was learned from, each priced blind' }));
    boardWrap.appendChild(state.tab === 'board' ? boardTable() : liveTable());
    drawerSlot.textContent = '';
    if (state.tab === 'board' && state.selected) {
      DATA.rows.forEach(function (r) { if (r.slug === state.selected) drawerSlot.appendChild(drawer(r)); });
    }
  }

  var foot = el('p', { class: 'foot', text: 'Method, in one breath: the price is TVL \u00d7 a shrunk category median of market cap / TVL over ' + V.peers + ' traded launch-type peers, adjusted by a robust size slope; the odds are a logistic fit on ' + O.trainedOn + ' dated protocols (age ' + (O.coef[1] >= 0 ? '+' : '') + O.coef[1].toFixed(2) + '/yr, size ' + (O.coef[2] >= 0 ? '+' : '') + O.coef[2].toFixed(2) + '/log10 TVL, growth ' + (O.coef[3] >= 0 ? '+' : '') + O.coef[3].toFixed(2) + '/10pts). Rank ranges come from 150 bootstrap refits of the peer set with the odds held at their full fit. The register below the board names every pre-token protocol the screen set aside, with the test that caught it. Implied values are this entry\u2019s own claims, computed from the sealed snapshot alone; a protocol records no token — the snapshot does not prove it has none.' });

  app.appendChild(header);
  app.appendChild(strip);
  app.appendChild(controls);
  app.appendChild(sandbox);
  app.appendChild(drawerSlot);
  app.appendChild(boardWrap);
  app.appendChild(terms);
  app.appendChild(registerSection());
  app.appendChild(foot);
  app.setAttribute('aria-busy', 'false');
  applyPalette();
  renderTable();
})();
