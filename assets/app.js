/* ==========================================================================
   Weather2Grid — Official Risk Power Outage Operations Dashboard Engine
   High-Performance Canvas Map Renderer (60 FPS) with Dual Theme & Operations HUD
   No external runtime dependencies or CDNs required.
   ========================================================================== */

'use strict';

const S = {
  cycles: [], idx: 0, cycle: null, counties: [], geo: null,
  basemap: null, track: null, nhcTracks: [], wnTracks: [], outageStatus: null,
  byFips: new Map(), layer: 'peak_gust_ms', ratio: 0.15,
  triggered: new Set(), selected: null, hoveredFips: null,
  playing: false, timer: null, loop: true, loadToken: 0, curve: null, trackFrame: null,
  activeProvider: null,
  archiveMode: false,
  // null means "follow the newest initialization". Set to an ISO issue
  // time to pin the view to an archived run.
  selectedInit: null,
  overlays: { states: true, track: true, nhc: false, wind: true, extrapolation: false, threshold: true },
  view: 'conus', zoom: 1, panX: 0, panY: 0, dragging: null,
  mapScale: 1, mapBounds: null, mapOrigin: { ox: 0, oy: 0, x0: 0, y0: 0 },
  projectedCounties: [], projectedStates: [],
  needsRedraw: false, hitCanvas: null, hitCtx: null,
  theme: localStorage.getItem('w2g_theme') || 'light',
};

const LAYERS = [
  { key: 'expected_customers_out', label: 'Expected out', fmt: 'int', ramp: 'impact' },
  { key: 'p90_customers_out', label: 'P90 out', fmt: 'int', ramp: 'impact' },
  { key: 'expected_outage_fraction', label: 'Outage fraction', fmt: 'pct', ramp: 'impact', fixed: [0, .35] },
  { key: 'prob_outage_fraction_gt_05', label: 'P(>5%)', fmt: 'pct', ramp: 'prob', fixed: [0, 1] },
  { key: 'peak_gust_ms', label: 'Peak gust', fmt: 'ms', ramp: 'gust' },
  { key: 'weather_spread_pp', label: 'Weather spread', fmt: 'pp', ramp: 'uncertainty' },
];

// Only meaningful for a hindcast: a forecast cycle has no outcome yet. They
// are appended to the layer switch when the active cycle carries observations
// and removed again when it does not, so a forecast can never display an
// "observed" layer built from stale data.
const VERIFICATION_LAYERS = [
  { key: 'observed_customers_out', label: 'Observed out', fmt: 'int', ramp: 'impact', verification: true },
  { key: 'observed_outage_fraction', label: 'Observed fraction', fmt: 'pct', ramp: 'impact', fixed: [0, .35], verification: true },
  { key: 'residual_outage_fraction', label: 'Error (pred − obs)', fmt: 'pct', ramp: 'uncertainty', verification: true },
];

const PROVIDERS = [
  { id: 'hrrr', label: 'NOAA HRRR via AWS Open Data', match: (s) => s.startsWith('hrrr') },
  { id: 'weathernext3', label: 'Google DeepMind WeatherNext 3', match: (s) => s.startsWith('weathernext3') || s.startsWith('wn3') },
  { id: 'weathernext2', label: 'Google DeepMind WeatherNext 2', match: (s) => s.startsWith('weathernext2') || s.startsWith('weathernext') || s.startsWith('wn2') },
  { id: 'gfs', label: 'NOAA GFS / GEFS', match: (s) => s.startsWith('gfs') || s.startsWith('gefs') },
  // Hindcasts are their own source, not a variant of a forecast provider.
  // Keeping them separate is what stops a verification run appearing in a
  // forecast provider's initialization list.
  { id: 'hindcast', label: 'Hindcast verification', match: (s) => s.startsWith('hindcast') },
];

function providerFor(hazardSource) {
  const source = String(hazardSource || '').toLowerCase();
  const known = PROVIDERS.find((p) => p.match(source));
  return known || { id: `other:${source}`, label: source || 'unknown source', match: () => false };
}

function frameStartMs(cycle) {
  const valid = cycle.valid_start_utc || (cycle.meta && cycle.meta.valid_start_utc);
  if (valid) return Date.parse(valid) || 0;
  const issued = Date.parse(cycle.issued_utc || cycle.forecast_init_time_utc) || 0;
  return issued + Number(cycle.lead_hours || 0) * 36e5;
}

// Every initialization this provider has in the archive, newest first.
function providerInitializations(providerId = S.activeProvider) {
  const grouped = new Map();
  S.cycles.forEach((cycle) => {
    if (providerFor(cycle.hazard_source).id !== providerId) return;
    const issued = cycle.issued_utc;
    const entry = grouped.get(issued) || {
      issued,
      time: Date.parse(issued) || 0,
      kind: String(cycle.product_kind || 'forecast'),
      eventName: cycle.event_name || '',
      cycles: 0,
      // The exporter marks exactly one initialization per hazard source as
      // latest. Trusting that flag rather than re-deriving "newest" here keeps
      // one definition of current in the whole system.
      isLatest: Boolean(cycle.is_latest_initialization),
      horizonHours: 0,
    };
    entry.cycles += 1;
    entry.isLatest = entry.isLatest || Boolean(cycle.is_latest_initialization);
    const horizon = Number(cycle.forecast_horizon_hours);
    if (Number.isFinite(horizon)) entry.horizonHours = Math.max(entry.horizonHours, horizon);
    grouped.set(issued, entry);
  });
  const list = [...grouped.values()].sort((a, b) => b.time - a.time);
  // An archive with no flag at all (an export from before retention existed)
  // still has to name something as current, or nothing would ever render.
  // Hindcasts are excluded: they are never the current run of anything, and
  // marking one latest is exactly the confusion this whole path avoids.
  const forecasts = list.filter((entry) => entry.kind !== 'hindcast');
  if (!S.archiveMode && forecasts.length && !forecasts.some((entry) => entry.isLatest)) {
    forecasts[0].isLatest = true;
  }
  return list;
}

// The archive masthead picker is broader than the per-provider picker: it
// shows every historical initialization available on the archive page, grouped
// by provider and stamped with its issue date. The live page intentionally
// stays focused on current guidance and never shows historical choices.
function availableRuns() {
  const grouped = new Map();
  S.cycles.forEach((cycle) => {
    const provider = providerFor(cycle.hazard_source);
    const key = `${provider.id}\u0000${cycle.issued_utc}`;
    const entry = grouped.get(key) || {
      providerId: provider.id,
      providerLabel: provider.label,
      issued: cycle.issued_utc,
      time: Date.parse(cycle.issued_utc) || 0,
      isLatest: Boolean(cycle.is_latest_initialization),
      // A run is identified in the archive picker by what it IS, and a
      // hindcast is identified by its storm rather than by an issue time.
      kind: String(cycle.product_kind || 'forecast'),
      eventName: cycle.event_name || '',
      cycles: 0,
      horizonHours: 0,
    };
    entry.cycles += 1;
    entry.isLatest = entry.isLatest || Boolean(cycle.is_latest_initialization);
    const horizon = Number(cycle.forecast_horizon_hours);
    if (Number.isFinite(horizon)) entry.horizonHours = Math.max(entry.horizonHours, horizon);
    grouped.set(key, entry);
  });
  return [...grouped.values()].sort((a, b) => b.time - a.time
    || a.providerLabel.localeCompare(b.providerLabel));
}

// The initialization currently on screen for this provider: the pinned one if
// it exists here, otherwise the latest.
function activeInitialization(providerId = S.activeProvider) {
  const list = providerInitializations(providerId);
  if (!list.length) return null;
  return list.find((entry) => entry.issued === S.selectedInit)
    || list.find((entry) => entry.isLatest)
    || list[0];
}

function viewingHindcast(providerId = S.activeProvider) {
  const active = activeInitialization(providerId);
  return Boolean(active && active.kind === 'hindcast');
}

function providerFrameIndices(providerId = S.activeProvider) {
  const active = activeInitialization(providerId);
  if (!active) return [];
  return S.cycles.map((cycle, index) => ({ cycle, index }))
    .filter(({ cycle }) => providerFor(cycle.hazard_source).id === providerId
      && cycle.issued_utc === active.issued)
    .sort((a, b) => frameStartMs(a.cycle) - frameStartMs(b.cycle))
    .map(({ index }) => index);
}

function viewingArchivedRun(providerId = S.activeProvider) {
  const active = activeInitialization(providerId);
  // A hindcast is not an "archived run" of a live product; it is a
  // verification product and gets its own label rather than borrowing one
  // that implies it was once current guidance.
  return Boolean(active && active.kind !== 'hindcast'
    && (S.archiveMode || !active.isLatest));
}

// The horizon and window shape are properties of the product, not of the
// provider: the same WeatherNext initialization is published as three daily
// windows or as twenty-five rolling ones depending on how it was sliced.
// Read it off the cycles rather than hardcoding a horizon that goes stale
// the first time the pipeline changes.
function windowShape(frames) {
  const withWindow = frames.find((c) => Number(c.product_window_hours) > 0);
  if (!withWindow) return null;
  const hours = Number(withWindow.product_window_hours);
  const step = Number(withWindow.product_step_hours) || hours;
  return { hours, step, overlap: frames.some((c) => c.windows_overlap) };
}

function horizonHours(frames) {
  const values = frames.map((c) => Number(c.forecast_horizon_hours))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function providerCoverage(providerId) {
  const frames = providerFrameIndices(providerId).map((index) => S.cycles[index]);
  if (!frames.length) return 'not in archive';
  const inputs = frames.reduce((sum, c) => sum + (Array.isArray(c.input_lead_hours) ? c.input_lead_hours.length : 0), 0);
  const shape = windowShape(frames);
  const horizon = horizonHours(frames);
  // Name the run being shown. Saying "latest init" while an archived run is on
  // screen is exactly the confusion the picker exists to prevent.
  const active = activeInitialization(providerId);
  if (active && active.kind === 'hindcast') {
    const v = frames[0] && frames[0].verification;
    const skill = v && Number.isFinite(Number(v.crpss))
      ? ` · CRPSS ${Number(v.crpss) >= 0 ? '+' : ''}${Number(v.crpss).toFixed(2)} vs climatology`
      : '';
    // The provider name already says "Hindcast"; repeating it here reads as
    // a stutter in the header.
    return `scored against observed outages${skill}`;
  }
  const run = active && !active.isLatest
    ? `archived ${formatInitStamp(active.issued)}`
    : 'latest init';
  if (shape) {
    const cadence = shape.overlap
      ? `${frames.length} × ${shape.hours}h windows every ${shape.step}h`
      : `${frames.length} × ${shape.hours}h windows`;
    return `${run} · ${cadence}`
      + (horizon ? ` (${Math.round(horizon / 24)}d horizon)` : '');
  }
  const trackFrames = providerId === S.activeProvider && S.track && Array.isArray(S.track.points) ? S.track.points.length : null;
  return `${run} · ${inputs || 'unknown'} leads${trackFrames ? ` · ${trackFrames} track pts` : ''}`;
}

function windLabel(short) {
  const source = String((S.cycle && S.cycle.meta && S.cycle.meta.hazard_source) || '');
  if (!source.includes('proxy')) return short ? 'Peak gust' : 'Peak modeled gust';
  return short ? '100m wind*' : 'Peak 100m wind (gust proxy)';
}
function layerLabel(layer) { return layer.key === 'peak_gust_ms' ? windLabel(true) : layer.label; }

// County ramps, one set per theme. A sequential ramp encodes magnitude as
// LIGHTNESS, so its anchor has to flip with the surface it is drawn on: on
// the dark canvas low values sink toward the background and high values
// glow; on the light canvas that inverts -- low values stay near white and
// high values darken. Reusing the dark set on the light canvas is what made
// the map read as a flat grey field with a few near-black counties: every
// low value was nearly black on white, and the top of the range was the only
// part still carrying colour.
//
// Both sets step monotonically in OKLab lightness (dark 0.24 -> 0.93+, light
// 0.96+ -> 0.35) across roughly even intervals, so equal steps in the data
// read as equal steps on screen.
const RAMPS_DARK = {
  impact: ['#0f2231', '#184f68', '#df6c3a', '#fba72c', '#ffe9a0'],
  prob: ['#0f2334', '#2c4b8e', '#7952c4', '#c968e0', '#f3d9ff'],
  gust: ['#0d2230', '#155d78', '#22a2aa', '#5ce6c4', '#f0fdf7'],
  uncertainty: ['#0f2232', '#2f497a', '#7462bd', '#bb86e0', '#f5dbff'],
};
const RAMPS_LIGHT = {
  impact: ['#fff7e0', '#fed08a', '#f79044', '#d4501a', '#7f2704'],
  prob: ['#f6effc', '#dcc6f0', '#b48ade', '#8348bd', '#4a1d7d'],
  gust: ['#e9f7f6', '#a8ddda', '#4bb5b8', '#1d7d95', '#0d3f5e'],
  uncertainty: ['#f1eefc', '#cfc5ef', '#9d8bda', '#6b4fb8', '#38257c'],
};
const ramps = () => (S.theme === 'dark' ? RAMPS_DARK : RAMPS_LIGHT);

const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const num = (v, d = 0) => v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const fmt = (v, kind) => v == null ? '—'
  : kind === 'pct' ? `${(v * 100).toFixed(v < .1 ? 1 : 0)}%`
  : kind === 'ms' ? `${Number(v).toFixed(0)} m/s`
  : kind === 'pp' ? `${Number(v).toFixed(1)} pp`
  : integer.format(v);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lerp = (a, b, t) => a + (b - a) * t;

function hex2rgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const n = stops.length - 1, i = Math.min(Math.floor(t * n), n - 1), u = t * n - i;
  const a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
  return `rgb(${Math.round(lerp(a[0], b[0], u))},${Math.round(lerp(a[1], b[1], u))},${Math.round(lerp(a[2], b[2], u))})`;
}

function albers(lon0 = -96, lat0 = 37.5, lat1 = 29.5, lat2 = 45.5) {
  const R = Math.PI / 180;
  const n = .5 * (Math.sin(lat1 * R) + Math.sin(lat2 * R));
  const C = Math.cos(lat1 * R) ** 2 + 2 * n * Math.sin(lat1 * R);
  const r0 = Math.sqrt(C - 2 * n * Math.sin(lat0 * R)) / n;
  return (lon, lat) => {
    const theta = n * ((lon - lon0) * R);
    const r = Math.sqrt(C - 2 * n * Math.sin(lat * R)) / n;
    return [r * Math.sin(theta), -(r0 - r * Math.cos(theta))];
  };
}

const JSON_CACHE = new Map();
async function cachedJson(url) {
  if (!JSON_CACHE.has(url)) {
    const p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      return r.json();
    }).catch(err => {
      JSON_CACHE.delete(url);
      throw err;
    });
    JSON_CACHE.set(url, p);
  }
  return JSON_CACHE.get(url);
}

function decodeCountyData(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || payload.format !== 'w2g-columnar-v1' || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
    throw new Error('Unsupported county data format');
  }
  return payload.rows.map((values) => {
    const row = {};
    for (let index = 0; index < payload.columns.length; index += 1) {
      row[payload.columns[index]] = values[index];
    }
    return row;
  });
}

/* ==========================================================================
   Boot & Lifecycle
   ========================================================================== */
async function boot() {
  initTheme();
  const status = await cachedJson('data/status.json');
  S.archiveMode = Boolean(status.archive_view);
  initViewNavigation();
  showBanner(status.banner);

  const [cycles, basemap, nhc, wn, outageStatus] = await Promise.all([
    cachedJson('data/cycles.json'),
    cachedJson('data/basemap.geojson'),
    cachedJson('data/nhc-active-tracks.json').catch(() => null),
    cachedJson('data/weathernext-active-tracks.json').catch(() => null),
    cachedJson('data/live-outage-status.json').catch(() => null),
  ]);

  S.cycles = cycles;
  S.basemap = basemap;
  S.nhcTracks = nhc && nhc.available && Array.isArray(nhc.tracks) ? nhc.tracks : [];
  S.wnTracks = wn && wn.available && Array.isArray(wn.tracks) ? wn.tracks : [];
  S.outageStatus = outageStatus;

  if (!S.cycles.length) {
    $('event-name').textContent = 'No forecast products found';
    return;
  }

  S.cycles.sort((a, b) => frameStartMs(a) - frameStartMs(b));
  const initialIndex = S.cycles.reduce((best, cycle, index) => {
    const issued = Date.parse(cycle.issued_utc) || 0;
    const bestIssued = Date.parse(S.cycles[best].issued_utc) || 0;
    return issued > bestIssued || (issued === bestIssued && Number(cycle.lead_hours || 0) < Number(S.cycles[best].lead_hours || 0)) ? index : best;
  }, 0);

  S.activeProvider = providerFor(S.cycles[initialIndex].hazard_source).id;

  wireEvents();
  initCanvas();
  await loadCycle(initialIndex);

  window.addEventListener('resize', debounce(() => {
    resizeCanvas();
    projectMapGeometry();
    requestMapRedraw();
    drawCurve();
    drawCdfIfOpen();
  }, 120));
}

function initViewNavigation() {
  const live = $('live-view-link'), archive = $('archive-view-link');
  if (!live || !archive) return;
  const active = S.archiveMode ? archive : live;
  active.setAttribute('aria-current', 'page');
  if (S.archiveMode) archive.classList.add('archive-active');
  // Deliberately NOT `data-view`: the map extent buttons are selected with
  // [data-view], so stamping the same attribute on <html> bound the extent
  // handler to the document root. Every click anywhere then bubbled into it and
  // silently reset the view to "live", which killed CONUS / Event / Storm /
  // Focus Max and snapped the map back to zoom 1 on any county click.
  document.documentElement.dataset.surface = S.archiveMode ? 'archive' : 'live';
}

function debounce(fn, wait) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function initTheme() {
  document.documentElement.setAttribute('data-theme', S.theme);
  const btn = $('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', S.theme);
      localStorage.setItem('w2g_theme', S.theme);
      requestMapRedraw();
    });
  }
}

function showBanner(banner) {
  const host = $('banner');
  if (!banner || !host) return;
  host.className = `banner ${banner.level || 'info'}`;
  const title = document.createElement('b'), detail = document.createElement('span');
  title.textContent = banner.title;
  detail.textContent = banner.detail;
  host.replaceChildren(title, detail);
  host.hidden = false;
}

function wireEvents() {
  const slider = $('cycle');
  slider.addEventListener('input', () => {
    stopPlayback();
    const frames = activeFrames();
    if (frames[+slider.value]) selectFrame(frames[+slider.value]);
  });

  $('cycle-prev').addEventListener('click', () => { stopPlayback(); stepCycle(-1); });
  $('cycle-next').addEventListener('click', () => { stopPlayback(); stepCycle(1); });
  $('cycle-play').addEventListener('click', togglePlayback);
  $('playback-speed').addEventListener('change', () => {
    if (S.playing) { stopPlayback(); startPlayback(); }
  });

  const loopBtn = $('cycle-loop');
  if (loopBtn) {
    loopBtn.addEventListener('click', () => {
      S.loop = !S.loop;
      loopBtn.setAttribute('aria-pressed', String(S.loop));
      loopBtn.title = `Loop animation: ${S.loop ? 'On' : 'Off'} (L)`;
    });
  }

  $('d-close').addEventListener('click', closeDrawer);

  const initToggle = $('init-toggle');
  if (initToggle) {
    initToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = $('init-menu');
      const opening = menu.hidden;
      if (opening) drawInitPicker();
      menu.hidden = !opening;
      initToggle.setAttribute('aria-expanded', String(opening));
    });
  }

  const runToggle = $('run-toggle');
  if (runToggle) {
    runToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = $('run-menu');
      const opening = menu.hidden;
      if (opening) drawRunPicker();
      menu.hidden = !opening;
      runToggle.setAttribute('aria-expanded', String(opening));
    });
  }

  document.addEventListener('click', (event) => {
    const initPicker = $('init-picker');
    if (initPicker && !initPicker.contains(event.target)) closeInitMenu();
    const runPicker = $('run-picker');
    if (runPicker && !runPicker.contains(event.target)) closeRunMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(event.target.tagName)) {
      event.preventDefault(); togglePlayback();
    }
    if ((event.key === 'l' || event.key === 'L') && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      if (loopBtn) loopBtn.click();
    }
    if (event.key === 'Escape') {
      closeDrawer();
      closeInitMenu();
      closeRunMenu();
      const dd = $('search-dropdown');
      if (dd) dd.hidden = true;
    }
    if (event.key === '[' && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      stopPlayback(); stepCycle(-1);
    }
    if (event.key === ']' && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      stopPlayback(); stepCycle(1);
    }
    if ((event.key === '+' || event.key === '=') && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      zoomMap(1.3);
    }
    if (event.key === '-' && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      zoomMap(1 / 1.3);
    }
    if (event.key === '0' && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      applyMapView('conus');
    }
  });

  buildLayers();
  wireRatio();
  wireOverlays();
  wireMapControls();
  wireSearch();
  wireExport();
}

/* ==========================================================================
   Frame & Cycle Management
   ========================================================================== */
function activeFrames() {
  const cycles = providerFrameIndices();
  if (cycles.length === 1 && cycles[0] === S.idx && S.track && Array.isArray(S.track.points) && S.track.points.length > 1) {
    return S.track.points.map((point, trackIndex) => ({
      cycleIndex: S.idx, trackIndex, lead_hours: point.lead_hours, valid_utc: point.valid_utc,
    }));
  }
  return cycles.map((cycleIndex) => ({ cycleIndex, trackIndex: null }));
}

function activeFramePosition(frames = activeFrames()) {
  const pos = frames.findIndex((f) => f.cycleIndex === S.idx && (f.trackIndex == null || f.trackIndex === S.trackFrame));
  return Math.max(0, pos);
}

async function selectFrame(frame) {
  if (!frame) return;
  if (frame.cycleIndex !== S.idx) {
    await loadCycle(frame.cycleIndex, frame.trackIndex);
    return;
  }
  S.trackFrame = frame.trackIndex;
  updateFrameNavigation();
  updateCycleChrome();
  drawForecast();
  requestMapRedraw();
}

function updateFrameNavigation() {
  const frames = activeFrames();
  const position = activeFramePosition(frames);
  $('cycle').max = String(Math.max(0, frames.length - 1));
  $('cycle').value = String(position);
  $('cycle-prev').disabled = position === 0;
  $('cycle-next').disabled = position >= frames.length - 1;
  buildCycleDots();
  drawSourceSwitch();
  drawRunPicker();
  drawInitPicker();
}

function buildCycleDots() {
  const frames = activeFrames(), position = activeFramePosition(frames);
  $('cycle-dots').innerHTML = frames.map((frame, i) => {
    const c = S.cycles[frame.cycleIndex];
    const prov = providerFor(c.hazard_source);
    const short = prov.id === 'hrrr' ? 'HRRR' : prov.id === 'weathernext3' ? 'WN3' : prov.id === 'weathernext2' ? 'WN2' : 'Forecast';
    const lead = frame.trackIndex != null ? S.track.points[frame.trackIndex].lead_hours : c.lead_hours;
    const desc = `${short}: ${c.event_name || c.cycle_id} · lead +${lead || 0}h`;
    return `<i class="${i === position ? 'active' : ''}" title="${esc(desc)}"></i>`;
  }).join('');
}

// Where a cycle's payload lives. The latest initialization ships inside the
// site itself; older ones carry `data_base`, an absolute URL to the archive
// site, so the site repository never holds more than one run. That archive is
// published under the same host, so this is a same-origin fetch and needs no
// CORS handling — but the value is treated as a plain URL prefix either way.
//
// Geometry is NOT relocated: it is content-addressed and shared across every
// run, so one copy stays beside the site and archived cycles point back at it.
function cycleRoot(summary) {
  const id = encodeURIComponent(summary.cycle_id);
  const base = typeof summary.data_base === 'string' ? summary.data_base.replace(/\/+$/, '') : '';
  return base ? `${base}/cycles/${id}` : `data/cycles/${id}`;
}

function cycleGeometryUrl(summary) {
  return summary.geometry_path
    ? `data/${summary.geometry_path}`
    : `${cycleRoot(summary)}/counties.geojson`;
}

async function loadCycle(index, requestedTrackFrame = null) {
  const i = Math.max(0, Math.min(S.cycles.length - 1, index));
  const token = ++S.loadToken;
  const summary = S.cycles[i];
  const root = cycleRoot(summary);
  const geometryUrl = cycleGeometryUrl(summary);

  const [cycle, counties, geo, track] = await Promise.all([
    cachedJson(`${root}/cycle.json`),
    cachedJson(`${root}/counties.json`),
    cachedJson(geometryUrl),
    cachedJson(`${root}/track.json`).catch(() => null),
  ]);

  if (token !== S.loadToken) return;

  S.idx = i;
  S.cycle = cycle;
  S.counties = decodeCountyData(counties);
  S.geo = geo;
  S.activeProvider = providerFor(summary.hazard_source).id;
  // Defence in depth: export_products refuses to publish a mismatched
  // track.json, but a stale cached copy must not slip past the browser either.
  S.track = track && track.available !== false && Array.isArray(track.points) && track.points.length
    ? (trackPairsWithCycle(track, cycle) ? track : null)
    : null;
  if (track && track.available !== false && !S.track) {
    console.warn('[w2g] withheld cyclone track: init', trackInitIso(track),
      'does not match cycle init', cycleInitIso(cycle));
  }
  S.trackFrame = S.track ? Math.max(0, Math.min(
    S.track.points.length - 1,
    requestedTrackFrame == null ? Number(S.track.current_index || 0) : requestedTrackFrame
  )) : null;

  S.curve = null;
  S.byFips = new Map(S.counties.map((r) => [String(r.county_fips), r]));

  updateFrameNavigation();
  updateCycleChrome();
  buildLayers();
  drawProvenance();
  drawSplit();
  drawPriority();
  drawForecast();
  drawSourceStack();
  drawTail();
  await refreshTriggered();

  if (token !== S.loadToken) return;

  drawKpis();
  projectMapGeometry();
  requestMapRedraw();
  await drawCurve();
  scheduleCyclePrefetch();

  if (S.selected && S.byFips.has(S.selected)) {
    openDrawer(S.selected);
  } else if (S.selected) {
    closeDrawer();
  }
}

function scheduleCyclePrefetch() {
  const run = () => providerFrameIndices().filter((idx) => idx !== S.idx).forEach((idx) => {
    const s = S.cycles[idx], r = cycleRoot(s);
    const g = cycleGeometryUrl(s);
    [`${r}/cycle.json`, `${r}/counties.json`, g, `${r}/track.json`].forEach((u) => cachedJson(u).catch(() => {}));
  });
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 60);
}

function formatCycleTime(issuedStr) {
  const date = new Date(issuedStr);
  if (Number.isNaN(+date)) return issuedStr;
  const utcHours = String(date.getUTCHours()).padStart(2, '0');
  const utcMins = String(date.getUTCMinutes()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const utcDate = `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${utcHours}:${utcMins} UTC`;
  const localTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `${utcDate} (${localTime})`;
}

function formatValidRange(cycle) {
  const meta = cycle.meta || {};
  const start = new Date(meta.valid_start_utc || new Date(new Date(cycle.issued_utc).getTime() + Number(cycle.lead_hours || 0) * 36e5));
  const end = meta.valid_end_utc ? new Date(meta.valid_end_utc) : null;
  if (Number.isNaN(+start)) return 'Valid time unavailable';
  const stamp = (d) => `${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  return end && !Number.isNaN(+end) ? `Valid ${stamp(start)}–${stamp(end)}` : `Valid ${stamp(start)}`;
}

function formatCycleLead(cycle) {
  const meta = cycle.meta || {};
  const lead = cycle.lead_hours;
  let horizonText = '';
  if (meta.valid_start_utc && meta.valid_end_utc) {
    const spanHrs = Math.round((new Date(meta.valid_end_utc) - new Date(meta.valid_start_utc)) / 36e5);
    if (spanHrs > 0) horizonText = ` · ${spanHrs}h window`;
  }
  return lead != null ? `Starts +${lead}h${horizonText}` : horizonText.replace(/^ · /, '');
}

function formatValidInstant(val) {
  const d = new Date(val);
  if (Number.isNaN(+d)) return 'Valid time unavailable';
  return `Valid ${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

function updateCycleChrome() {
  const cycle = S.cycle, issued = new Date(cycle.issued_utc);
  const prov = providerFor(cycle.meta ? cycle.meta.hazard_source : cycle.hazard_source);
  const isHindcastSource = String(
    (cycle.meta && cycle.meta.hazard_source) || cycle.hazard_source || ''
  ).startsWith('hindcast');
  const shortProv = prov.id === 'hrrr' ? 'NOAA HRRR'
    : prov.id === 'weathernext3' ? 'WeatherNext 3'
    : prov.id === 'weathernext2' ? 'WeatherNext 2'
    : isHindcastSource ? 'Hindcast'
    : 'Forecast';
  const frames = activeFrames(), position = activeFramePosition(frames);
  const frame = frames[position], trackPoint = frame && frame.trackIndex != null && S.track ? S.track.points[frame.trackIndex] : null;
  const inputCount = Array.isArray(cycle.input_lead_hours) ? cycle.input_lead_hours.length
    : Array.isArray(cycle.meta && cycle.meta.input_lead_hours) ? cycle.meta.input_lead_hours.length : 0;

  const activeLead = trackPoint && trackPoint.lead_hours != null
    ? trackPoint.lead_hours
    : (cycle.lead_hours != null ? cycle.lead_hours : 0);

  const issuedDate = new Date(cycle.issued_utc);
  let issueStr = cycle.issued_utc;
  if (!Number.isNaN(+issuedDate)) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const utcHours = String(issuedDate.getUTCHours()).padStart(2, '0');
    const utcMins = String(issuedDate.getUTCMinutes()).padStart(2, '0');
    issueStr = `${months[issuedDate.getUTCMonth()]} ${issuedDate.getUTCDate()}, ${utcHours}:${utcMins} UTC`;
  }
  const leadSign = Number(activeLead) > 0 ? `+${activeLead}` : `${activeLead}`;
  const archived = viewingArchivedRun(prov.id);
  const hindcast = viewingHindcast(prov.id);
  const storm = String(cycle.event_name || '').replace(/\s*—\s*hindcast$/i, '');
  $('event-name').textContent = hindcast
    ? `HINDCAST — ${storm || 'past storm'} verified against observed outages`
    : archived
      ? `ARCHIVED RUN — Issue ${issueStr} Lead ${leadSign}h`
      : `Active Risk Outlook — Issue ${issueStr} Lead ${leadSign}h`;
  $('overview-provider').textContent = `${shortProv} · ${providerCoverage(prov.id)}`;
  $('cycle-time').textContent = trackPoint ? formatValidInstant(trackPoint.valid_utc) : formatValidRange(cycle);
  $('cycle-init').textContent = `Initialized ${formatCycleTime(cycle.issued_utc)}`;
  const runTag = hindcast ? ' · hindcast' : archived ? ' · archived run' : '';
  $('cycle-counter').textContent = trackPoint
    ? `${shortProv} · track fix ${position + 1} of ${frames.length}${runTag}`
    : `${shortProv} · window ${position + 1} of ${frames.length}${runTag}`;

  const leadEl = $('cycle-lead');
  leadEl.textContent = trackPoint ? `Lead +${trackPoint.lead_hours}h · storm center` : `${formatCycleLead(cycle)} (${inputCount || '4'} weather model steps)`;

  const note = $('frame-note');
  if (note) {
    const meta = cycle.meta || {};
    const spanHrs = meta.valid_start_utc && meta.valid_end_utc
      ? Math.round((new Date(meta.valid_end_utc) - new Date(meta.valid_start_utc)) / 36e5)
      : null;
    // Overlapping windows are successive views of one forecast, not separate
    // events. Stepping the slider must not read as 25 storms in a row.
    const stepHrs = Number(cycle.product_step_hours || meta.step_hours) || null;
    const windowHrs = Number(cycle.product_window_hours || meta.window_hours) || null;
    const overlaps = Boolean(cycle.windows_overlap || meta.windows_overlap);
    // Accumulation length is the window the product states, when it states
    // one. valid_end - valid_start is six hours shorter, because each
    // 6-hourly step stands for the six hours preceding its valid time - so
    // quoting the span here and the window in the overlap clause would put
    // two different numbers for the same thing in one sentence.
    const coveredHrs = windowHrs || spanHrs || 18;
    note.textContent = trackPoint
      ? `Track fix ${position + 1} of ${frames.length}`
      : overlaps && windowHrs && stepHrs
        ? `${windowHrs}h rolling window (+${stepHrs}h step, ${windowHrs - stepHrs}h overlap)`
        : `${coveredHrs}h cumulative risk`;
  }

  const liveAgeHours = Number.isNaN(+issued) ? null : (Date.now() - issued.getTime()) / 36e5;
  const isNotEvaluated = Boolean(cycle.degraded_mode || cycle.freshness === 'degraded' || cycle.freshness === 'not evaluated');
  const freshness = hindcast ? 'hindcast'
    : archived ? 'archived'
    : isNotEvaluated ? 'not evaluated'
    : liveAgeHours != null && liveAgeHours > 12 ? 'stale' : (cycle.freshness || 'current');
  $('freshness').textContent = freshness;
  $('freshness').className = `pill ${freshness.replace(/\s+/g, '-')}`;
  $('source-badge').textContent = `${cycle.meta.forecast_provider || 'HRRR'} · ${integer.format(S.counties.length)} counties`;

  [...$('cycle-dots').children].forEach((dot, i) => dot.classList.toggle('active', i === position));

  document.querySelectorAll('[data-overlay="track"],[data-overlay="nhc"],[data-overlay="wind"],button[data-view="storm"]').forEach((btn) => {
    const isNhcBtn = btn.dataset.overlay === 'nhc';
    const paired = hasPairedTrack();
    const isTrackBtn = btn.dataset.overlay === 'track';
    const hasData = isNhcBtn
      ? Boolean(S.nhcTracks && S.nhcTracks.length)
      : isTrackBtn
        ? paired
        : Boolean(paired || (S.nhcTracks && S.nhcTracks.length));
    btn.disabled = !hasData;
    btn.title = isNhcBtn
      ? (hasData ? 'Toggle Official NOAA NHC Cyclone Tracks' : 'No active NHC advisories in this bundle.')
      : paired
        ? (pairedWnTrackCount()
            ? 'Toggle the cyclone track from this forecast\'s own initialization'
            : 'Toggle this cycle\'s own storm track')
        : pairingNote();
  });
}

function stepCycle(delta) {
  const frames = activeFrames(), position = activeFramePosition(frames);
  const target = Math.max(0, Math.min(frames.length - 1, position + delta));
  if (frames[target]) selectFrame(frames[target]);
}

function togglePlayback() {
  S.playing ? stopPlayback() : startPlayback();
}

function startPlayback() {
  const frames = activeFrames();
  if (frames.length < 2) return;
  let pos = activeFramePosition(frames);
  if (pos >= frames.length - 1) { pos = 0; selectFrame(frames[0]); }
  S.playing = true;
  updatePlayButton();
  S.timer = setInterval(async () => {
    const framesNow = activeFrames(), cur = activeFramePosition(framesNow);
    if (cur >= framesNow.length - 1) {
      if (S.loop) {
        await selectFrame(framesNow[0]);
      } else {
        stopPlayback();
      }
      return;
    }
    await selectFrame(framesNow[cur + 1]);
  }, +$('playback-speed').value);
}

function stopPlayback() {
  clearInterval(S.timer);
  S.timer = null;
  S.playing = false;
  updatePlayButton();
}

function updatePlayButton() {
  const btn = $('cycle-play');
  btn.setAttribute('aria-pressed', String(S.playing));
  btn.setAttribute('aria-label', S.playing ? 'Pause forecast frames' : 'Play forecast frames');
  btn.querySelector('span').textContent = S.playing ? 'Ⅱ' : '▶';
  btn.querySelector('b').textContent = S.playing ? 'Pause' : 'Play';
}

/* ==========================================================================
   HIGH-PERFORMANCE CANVAS MAP ENGINE (60 FPS)
   ========================================================================== */
function initCanvas() {
  const canvas = $('map');
  if (!canvas) return;

  S.hitCanvas = document.createElement('canvas');
  S.hitCtx = S.hitCanvas.getContext('2d', { willReadFrequently: true });

  resizeCanvas();

  // Pointer drag panning
  canvas.addEventListener('pointerdown', (e) => {
    S.dragging = {
      startX: e.clientX,
      startY: e.clientY,
      initialPanX: S.panX,
      initialPanY: S.panY,
      hasMoved: false,
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (S.dragging) {
      const dx = e.clientX - S.dragging.startX;
      const dy = e.clientY - S.dragging.startY;
      if (Math.hypot(dx, dy) > 4) S.dragging.hasMoved = true;
      S.panX = S.dragging.initialPanX + dx;
      S.panY = S.dragging.initialPanY + dy;
      clampViewport();
      requestMapRedraw();
      hideTooltip();
      return;
    }

    // Hover hit test
    handlePointerHover(mx, my, e.clientX, e.clientY);
  });

  const endDrag = (e) => {
    if (!S.dragging) return;
    const wasClick = !S.dragging.hasMoved;
    S.dragging = null;
    canvas.classList.remove('dragging');

    if (wasClick) {
      const rect = canvas.getBoundingClientRect();
      handlePointerClick(e.clientX - rect.left, e.clientY - rect.top);
    }
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    hideTooltip();
    if (S.hoveredFips) {
      S.hoveredFips = null;
      requestMapRedraw();
    }
  });

  // Wheel zoom anchored at cursor
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomMap(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

function resizeCanvas() {
  const canvas = $('map');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 900;
  const h = canvas.clientHeight || 560;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  if (S.hitCanvas) {
    S.hitCanvas.width = Math.round(w);
    S.hitCanvas.height = Math.round(h);
  }
}

function resetViewport() {
  S.zoom = 1;
  S.panX = 0;
  S.panY = 0;
}

function zoomMap(factor, cx = ($('map').clientWidth || 900) / 2, cy = ($('map').clientHeight || 560) / 2) {
  const oldZoom = S.zoom;
  const nextZoom = Math.max(1, Math.min(12, oldZoom * factor));

  S.panX = cx - (cx - S.panX) * (nextZoom / oldZoom);
  S.panY = cy - (cy - S.panY) * (nextZoom / oldZoom);
  S.zoom = nextZoom;

  clampViewport();
  requestMapRedraw();
}

function clampViewport() {
  const W = $('map').clientWidth || 900;
  const H = $('map').clientHeight || 560;
  // The projection is fitted to the canvas at zoom 1, so at zoom z the map
  // spans W*z by H*z. Panning is bounded so that span always covers the
  // viewport. The old asymmetric clamp (+0.5 / -1.5 of the range) let a focus
  // jump land its target off-centre and let a drag push the map off-canvas.
  const maxPanX = W * (S.zoom - 1);
  const maxPanY = H * (S.zoom - 1);

  S.panX = Math.min(0, Math.max(-maxPanX, S.panX));
  S.panY = Math.min(0, Math.max(-maxPanY, S.panY));
}

// `exact` forces the zoom level instead of keeping a deeper one. Focus Max
// needs it: an operator already at 8x asking to "focus max" wants the framing
// the button promises, not their old zoom re-centred.
function focusMapPoint(bx, by, targetZoom = 3.5, { exact = false } = {}) {
  const W = $('map').clientWidth || 900;
  const H = $('map').clientHeight || 560;
  const target = Math.max(1, Math.min(12, targetZoom));
  S.zoom = exact ? target : Math.max(S.zoom, target);
  S.panX = W / 2 - bx * S.zoom;
  S.panY = H / 2 - by * S.zoom;
  clampViewport();
  requestMapRedraw();
}

/* Pre-projects GeoJSON into base screen Path2D objects */
function projectMapGeometry() {
  if (!S.geo) return;
  const canvas = $('map');
  const W = canvas.clientWidth || 900;
  const H = canvas.clientHeight || 560;
  const proj = albers();

  // Compute bounding boxes in projected coordinates
  const countyBounds = [Infinity, Infinity, -Infinity, -Infinity];
  const rawCounties = [];

  for (const feature of S.geo.features || []) {
    const fips = String(feature.properties.county_fips || feature.id || '');
    const geom = feature.geometry || {};
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates || [];
    const projectedRings = [];
    // Per-county extent in projected space, so the event footprint can be
    // fitted from a subset of counties instead of the whole product domain.
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    let sumX = 0, sumY = 0, nPts = 0;

    for (const poly of polys) {
      for (const ring of poly) {
        const ringPoints = [];
        for (const pt of ring) {
          const [px, py] = proj(pt[0], pt[1]);
          countyBounds[0] = Math.min(countyBounds[0], px);
          countyBounds[1] = Math.min(countyBounds[1], py);
          countyBounds[2] = Math.max(countyBounds[2], px);
          countyBounds[3] = Math.max(countyBounds[3], py);
          bbox[0] = Math.min(bbox[0], px);
          bbox[1] = Math.min(bbox[1], py);
          bbox[2] = Math.max(bbox[2], px);
          bbox[3] = Math.max(bbox[3], py);
          sumX += px; sumY += py; nPts += 1;
          ringPoints.push(px, py);
        }
        projectedRings.push(ringPoints);
      }
    }
    const projCentroid = nPts ? [sumX / nPts, sumY / nPts] : null;
    rawCounties.push({ fips, rings: projectedRings, bbox, projCentroid, feature });
  }

  // Basemap state boundaries
  const stateBounds = [Infinity, Infinity, -Infinity, -Infinity];
  const rawStates = [];
  if (S.basemap && S.basemap.features) {
    for (const feature of S.basemap.features) {
      const geom = feature.geometry || {};
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates || [];
      const rings = [];
      for (const poly of polys) {
        for (const ring of poly) {
          const ringPts = [];
          for (const pt of ring) {
            const [px, py] = proj(pt[0], pt[1]);
            stateBounds[0] = Math.min(stateBounds[0], px);
            stateBounds[1] = Math.min(stateBounds[1], py);
            stateBounds[2] = Math.max(stateBounds[2], px);
            stateBounds[3] = Math.max(stateBounds[3], py);
            ringPts.push(px, py);
          }
          rings.push(ringPts);
        }
      }
      rawStates.push({ id: feature.properties.state || feature.id, rings });
    }
  }

  // Determine view bounds
  const currentStorm = stormMeta();
  if (currentStorm) currentStorm.isCycleOwnTrack = true;
  const nhcStorms = (S.nhcTracks || []).map((item) => stormMeta(item, null)).filter(Boolean);
  // Only tracks from this cycle's own initialization may be drawn.
  const wnStorms = pairedWnTracks().map((item) => stormMeta(item, null)).filter(Boolean);
  const rawList = [];
  if (currentStorm) rawList.push(currentStorm);
  nhcStorms.forEach((st) => {
    if (!rawList.some((existing) => existing.stormId === st.stormId && existing.trackSourceKind === st.trackSourceKind)) {
      rawList.push(st);
    }
  });
  wnStorms.forEach((st) => {
    if (!rawList.some((existing) => existing.stormId === st.stormId && existing.trackSourceKind === st.trackSourceKind)) {
      rawList.push(st);
    }
  });
  const visibleStorms = rawList.filter((st) => {
    if (st.isCycleOwnTrack || st.trackSourceKind === 'weathernext' || st.isAiEnsemble) {
      return Boolean(S.overlays.track);
    }
    return Boolean(S.overlays.nhc);
  });

  // Restrict storm bounding to CONUS operational theater (Lon: -128°W to -64°W, Lat: 16°N to 54°N)
  // Prevents far-away open Pacific (Hawaii) or deep Atlantic storms from shifting CONUS to the side!
  const isNearConus = (pt) => pt && pt.lon >= -128 && pt.lon <= -64 && pt.lat >= 16 && pt.lat <= 54;
  const clipToConus = (list) => list.map((st) => {
    const nearPts = (st.track || []).filter(isNearConus);
    return nearPts.length ? { ...st, track: nearPts } : null;
  }).filter(Boolean);
  const conusStorms = clipToConus(visibleStorms);

  // Bounding box around a set of tracks, including each point's cone and 34kt
  // wind field. Returns null when nothing bounds, so callers can fall back
  // instead of quietly rendering an empty extent.
  const trackBounds = (storms) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    let any = false;
    storms.forEach((item) => {
      (item.track || []).forEach((pt) => {
        const [px, py] = proj(pt.lon, pt.lat);
        const windKm = Math.max(pt.uncertainty_km || 0, (item.wind_radii_km && item.wind_radii_km['34kt']) || 150);
        const r = (windKm + 180) / 6371;
        box[0] = Math.min(box[0], px - r); box[1] = Math.min(box[1], py - r);
        box[2] = Math.max(box[2], px + r); box[3] = Math.max(box[3], py + r);
        any = true;
      });
    });
    return any ? box : null;
  };

  const conusExtent = rawStates.length ? [...stateBounds] : [...countyBounds];

  // Event extent. The county product covers the whole CONUS domain every cycle,
  // so the raw county extent IS the CONUS extent - using it made "Event"
  // indistinguishable from "CONUS". The event is instead fitted to where the
  // risk actually sits: the counties over the operator threshold plus the top
  // of the expected-outage ranking, trimmed to their outage-weighted 10th-90th
  // percentile so a couple of isolated counties cannot stretch the frame back
  // out to the full domain. A concentrated event snaps tight; a genuinely
  // CONUS-wide risk day stays wide, which is the honest answer.
  const eventExtent = () => {
    const byFipsGeom = new Map(rawCounties.map((c) => [String(c.fips), c]));
    const picks = new Map();
    const add = (fips) => {
      const key = String(fips);
      const geomEntry = byFipsGeom.get(key);
      const row = S.byFips.get(key);
      if (geomEntry && geomEntry.projCentroid && row) picks.set(key, { geomEntry, row });
    };
    (S.triggered || new Set()).forEach(add);
    [...S.counties]
      .sort((a, b) => (Number(b.expected_customers_out) || 0) - (Number(a.expected_customers_out) || 0))
      .slice(0, 150)
      .forEach((row) => add(row.county_fips));

    const points = [...picks.values()].map(({ geomEntry, row }) => ({
      cx: geomEntry.projCentroid[0],
      cy: geomEntry.projCentroid[1],
      bbox: geomEntry.bbox,
      weight: Math.max(1, Number(row.expected_customers_out) || 0),
    }));
    if (points.length < 3) return [...countyBounds];

    const weightedQuantile = (values, q) => {
      const sorted = [...values].sort((a, b) => a.v - b.v);
      const total = sorted.reduce((sum, item) => sum + item.w, 0);
      let acc = 0;
      for (const item of sorted) {
        acc += item.w;
        if (acc >= total * q) return item.v;
      }
      return sorted[sorted.length - 1].v;
    };
    const xs = points.map((p) => ({ v: p.cx, w: p.weight }));
    const ys = points.map((p) => ({ v: p.cy, w: p.weight }));
    const core = [
      weightedQuantile(xs, 0.10), weightedQuantile(ys, 0.10),
      weightedQuantile(xs, 0.90), weightedQuantile(ys, 0.90),
    ];

    // Grow the core box so every county whose centre falls inside it is shown
    // whole rather than sliced by the frame edge.
    const box = [...core];
    points.forEach((p) => {
      if (p.cx < core[0] || p.cx > core[2] || p.cy < core[1] || p.cy > core[3]) return;
      box[0] = Math.min(box[0], p.bbox[0]); box[1] = Math.min(box[1], p.bbox[1]);
      box[2] = Math.max(box[2], p.bbox[2]); box[3] = Math.max(box[3], p.bbox[3]);
    });

    // Only pull the cyclone track into the event frame when the storm is
    // actually driving this event, tested as "a risk county sits inside the
    // storm's wind field plus 300 km" rather than as boxes that merely overlap.
    // A hurricane sitting off Baja is real, but it is not a reason to drag a
    // Plains wind event 2000 km out over the Pacific.
    if (currentStorm && S.overlays.track) {
      const near = clipToConus([currentStorm]);
      const stormBox = trackBounds(near);
      const drivesEvent = near.some((item) => (item.track || []).some((pt) => {
        const [px, py] = proj(pt.lon, pt.lat);
        const windKm = Math.max(pt.uncertainty_km || 0, (item.wind_radii_km && item.wind_radii_km['34kt']) || 150);
        const reach = (windKm + 300) / 6371;
        return points.some((c) => Math.hypot(c.cx - px, c.cy - py) <= reach);
      }));
      if (stormBox && drivesEvent) {
        box[0] = Math.min(box[0], stormBox[0]); box[1] = Math.min(box[1], stormBox[1]);
        box[2] = Math.max(box[2], stormBox[2]); box[3] = Math.max(box[3], stormBox[3]);
      }
    }
    return box;
  };

  // Never fit tighter than roughly 6° of longitude: a single-county event
  // should read as a region, not as a wall of one polygon.
  const MIN_SPAN = 6 / 57.2958;
  const enforceMinSpan = (box) => {
    const out = [...box];
    const spanX = out[2] - out[0], spanY = out[3] - out[1];
    if (spanX < MIN_SPAN) {
      const mid = (out[0] + out[2]) / 2;
      out[0] = mid - MIN_SPAN / 2; out[2] = mid + MIN_SPAN / 2;
    }
    if (spanY < MIN_SPAN * 0.7) {
      const mid = (out[1] + out[3]) / 2;
      out[1] = mid - MIN_SPAN * 0.35; out[3] = mid + MIN_SPAN * 0.35;
    }
    return out;
  };

  let b;
  if (S.view === 'conus') {
    // CONUS view is rigidly locked to state boundaries: NEVER shifts.
    b = conusExtent;
  } else if (S.view === 'storm') {
    // Prefer what is drawn, but never leave the button dead: fall back to every
    // known track, then to CONUS, rather than silently showing the county
    // extent (which is what made Storm look like it did nothing).
    b = trackBounds(conusStorms) || trackBounds(clipToConus(rawList)) || conusExtent;
  } else {
    b = eventExtent();
  }
  b = enforceMinSpan(b);

  let [x0, y0, x1, y1] = b;
  const pad = 32;
  const sx = (W - pad * 2) / (x1 - x0 || 1);
  const sy = (H - pad * 2) / (y1 - y0 || 1);
  const scale = Math.min(sx, sy);
  const ox = pad + ((W - pad * 2) - (x1 - x0) * scale) / 2;
  const oy = pad + ((H - pad * 2) - (y1 - y0) * scale) / 2;

  S.mapScale = scale;
  S.mapBounds = b;
  S.mapOrigin = { ox, oy, x0, y0 };

  const screenProj = (lon, lat) => {
    const [px, py] = proj(lon, lat);
    return [ox + (px - x0) * scale, oy + (py - y0) * scale];
  };
  S.mapScreen = screenProj;

  // Build base screen Path2D for each county
  S.projectedCounties = rawCounties.map((c, idx) => {
    const path = new Path2D();
    let cx = 0, cy = 0, totalPts = 0;
    for (const ring of c.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const sx = ox + (ring[i] - x0) * scale;
        const sy = oy + (ring[i + 1] - y0) * scale;
        if (i === 0) path.moveTo(sx, sy);
        else path.lineTo(sx, sy);
        cx += sx; cy += sy; totalPts += 1;
      }
      path.closePath();
    }
    return {
      fips: c.fips,
      path,
      idx,
      centroid: totalPts ? [cx / totalPts, cy / totalPts] : [W / 2, H / 2],
    };
  });

  // Build base screen Path2D for state outlines
  S.projectedStates = rawStates.map((s) => {
    const path = new Path2D();
    for (const ring of s.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const sx = ox + (ring[i] - x0) * scale;
        const sy = oy + (ring[i + 1] - y0) * scale;
        if (i === 0) path.moveTo(sx, sy);
        else path.lineTo(sx, sy);
      }
      path.closePath();
    }
    return { id: s.id, path };
  });

  // Render offscreen hit-test buffer
  renderHitCanvas();

  // Update domain label
  const states = [...new Set(S.counties.map((r) => r.state))].sort();
  const viewName = S.view === 'storm' ? 'Storm Extent' : S.view === 'conus' ? 'CONUS Extent' : 'Event Extent';
  const inFrame = S.projectedCounties.filter((c) => {
    const [cx, cy] = c.centroid;
    return cx >= 0 && cx <= W && cy >= 0 && cy <= H;
  }).length;
  const countLabel = S.view === 'event' && inFrame && inFrame < S.counties.length * 0.9
    ? `${integer.format(inFrame)} of ${integer.format(S.counties.length)} counties`
    : `${integer.format(S.counties.length)} counties`;
  $('map-domain').textContent = `${viewName} · ${countLabel}`;
  $('map-domain').title = `${states.join(' + ')} · ${S.counties.length} counties in active footprint`;
}

function renderHitCanvas() {
  if (!S.hitCtx || !S.projectedCounties.length) return;
  const canvas = $('map');
  const W = canvas.clientWidth || 900;
  const H = canvas.clientHeight || 560;
  const ctx = S.hitCtx;

  ctx.clearRect(0, 0, W, H);
  for (const c of S.projectedCounties) {
    const colorId = c.idx + 1;
    const r = (colorId >> 16) & 255;
    const g = (colorId >> 8) & 255;
    const b = colorId & 255;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill(c.path);
  }
}

function requestMapRedraw() {
  if (S.needsRedraw) return;
  S.needsRedraw = true;
  requestAnimationFrame(drawMapCanvas);
}

function drawMapCanvas() {
  S.needsRedraw = false;
  const canvas = $('map');
  if (!canvas || !S.projectedCounties.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 900;
  const H = canvas.clientHeight || 560;

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Set transform for DPI + pan/zoom
  ctx.setTransform(dpr * S.zoom, 0, 0, dpr * S.zoom, dpr * S.panX, dpr * S.panY);

  const layer = activeLayer();
  const [lo, hi] = layerDomain(layer);
  const stops = ramps()[layer.ramp];
  const isDark = S.theme === 'dark';
  // No data is not a low value. On the light canvas the ramp starts near
  // white, so the no-data grey has to stay neutral and no heavier than the
  // ramp's first step, or empty counties would out-read populated ones.
  const baseFill = isDark ? '#0b1622' : '#eceff3';
  const countyStroke = isDark ? '#081119' : '#cbd5e1';
  const strokeWidth = 0.5 / S.zoom;

  const hasTriggered = S.overlays.threshold !== false && S.triggered.size > 0;

  // 1. Draw Counties Base Fills
  for (const c of S.projectedCounties) {
    const row = S.byFips.get(c.fips);
    const val = row ? row[layer.key] : null;
    const isTrig = S.triggered.has(c.fips);

    ctx.save();
    // Shaded color contrast: triggered counties shine at 100% brightness,
    // untriggered counties soften to 45% opacity so triggered areas pop visually
    if (hasTriggered && !isTrig) {
      // Light-mode fills start pale, so the dark-mode amount of dimming
      // would erase them; they need to stay readable while still receding.
      ctx.globalAlpha = isDark ? 0.42 : 0.68;
    }

    ctx.fillStyle = val == null ? baseFill : rampColor(stops, (val - lo) / ((hi - lo) || 1));
    ctx.fill(c.path);

    // Natural clean county boundary (never thick, never yellow)
    ctx.strokeStyle = countyStroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke(c.path);
    ctx.restore();
  }

  // 2. Extrapolation Hatching
  if (S.overlays.extrapolation) {
    ctx.save();
    ctx.fillStyle = isDark ? 'rgba(217, 237, 241, 0.18)' : 'rgba(15, 23, 42, 0.14)';
    for (const c of S.projectedCounties) {
      const row = S.byFips.get(c.fips);
      if (row && row.training_envelope_flag !== 'inside') {
        ctx.fill(c.path);
      }
    }
    ctx.restore();
  }

  // 3. Triggered Counties (Pure Shaded Color Overlay — NO lines, NO dots)
  if (hasTriggered) {
    ctx.save();
    ctx.fillStyle = isDark ? 'rgba(251, 191, 36, 0.18)' : 'rgba(245, 158, 11, 0.16)';
    for (const c of S.projectedCounties) {
      if (S.triggered.has(c.fips)) {
        ctx.fill(c.path);
      }
    }
    ctx.restore();
  }

  // 4. Hovered / Selected County Highlighting
  if (S.hoveredFips || S.selected) {
    ctx.save();
    for (const c of S.projectedCounties) {
      if (c.fips === S.selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2.2, 2.8 / S.zoom);
        ctx.shadowColor = 'rgba(56, 189, 248, 0.8)';
        ctx.shadowBlur = 8;
        ctx.stroke(c.path);
      } else if (c.fips === S.hoveredFips) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = Math.max(1.8, 2.2 / S.zoom);
        ctx.stroke(c.path);
      }
    }
    ctx.restore();
  }

  // 5. State Boundaries
  if (S.overlays.states && S.projectedStates.length) {
    ctx.save();
    ctx.strokeStyle = isDark ? 'rgba(148, 187, 210, 0.48)' : 'rgba(71, 85, 105, 0.55)';
    ctx.lineWidth = Math.max(0.8, 1.1 / S.zoom);
    for (const s of S.projectedStates) {
      ctx.stroke(s.path);
    }
    ctx.restore();
  }

  // 6. Storm Overlays (Track, Uncertainty Cone, Radii, Center)
  drawStormCanvas(ctx, S.zoom);

  ctx.restore();

  // Update scale bar & legend
  drawLegend(layer, lo, hi, stops);
  updateScaleBar();
}

const WIND_TIER_STYLE = {
  '34kt': { color: '#38bdf8', fill: 'rgba(56, 189, 248, 0.12)' },
  '50kt': { color: '#fbbf24', fill: 'rgba(251, 191, 36, 0.14)' },
  '64kt': { color: '#f87171', fill: 'rgba(248, 113, 113, 0.18)' },
};

function drawStormCanvas(ctx, zoom) {
  const currentStorm = stormMeta();
  if (currentStorm) currentStorm.isCycleOwnTrack = true;
  const nhcStorms = (S.nhcTracks || []).map((item) => stormMeta(item, null)).filter(Boolean);
  // Only tracks from this cycle's own initialization may be drawn.
  const wnStorms = pairedWnTracks().map((item) => stormMeta(item, null)).filter(Boolean);

  // Combine tracks without dropping duplicates across different models
  const rawList = [];
  if (currentStorm) rawList.push(currentStorm);
  nhcStorms.forEach((st) => {
    if (!rawList.some((existing) => existing.stormId === st.stormId && existing.trackSourceKind === st.trackSourceKind)) {
      rawList.push(st);
    }
  });
  wnStorms.forEach((st) => {
    if (!rawList.some((existing) => existing.stormId === st.stormId && existing.trackSourceKind === st.trackSourceKind)) {
      rawList.push(st);
    }
  });

  const visibleStorms = rawList.filter((st) => {
    if (st.isCycleOwnTrack || st.trackSourceKind === 'weathernext' || st.isAiEnsemble) {
      return Boolean(S.overlays.track);
    }
    return Boolean(S.overlays.nhc);
  });
  if (!visibleStorms.length || !S.mapScreen) return;

  for (const st of visibleStorms) {
    const validPts = (st.track || []).filter((pt) => pt && pt.lon >= -132 && pt.lon <= -60 && pt.lat >= 14 && pt.lat <= 55);
    if (!validPts.length) continue;
    const points = validPts.map((pt) => ({ ...pt, xy: S.mapScreen(pt.lon, pt.lat) }));
    const currentIdx = Math.max(0, points.findIndex((pt) => pt.selected));
    const current = points[currentIdx] || points[0];
    const isWn = Boolean(st.isAiEnsemble || st.trackSourceKind === 'weathernext');

    // Uncertainty Cone
    if (points.length > 1) {
      const future = points.slice(currentIdx);
      if (future.length > 1) {
        ctx.save();
        ctx.beginPath();
        const left = [], right = [];
        future.forEach((pt, i) => {
          const before = future[Math.max(0, i - 1)].xy, after = future[Math.min(future.length - 1, i + 1)].xy;
          const dx = after[0] - before[0], dy = after[1] - before[1], len = Math.hypot(dx, dy) || 1;
          const radius = Math.max(5, (pt.uncertainty_km || (20 + i * 35)) / 6371 * S.mapScale);
          const nx = -dy / len, ny = dx / len;
          left.push([pt.xy[0] + nx * radius, pt.xy[1] + ny * radius]);
          right.push([pt.xy[0] - nx * radius, pt.xy[1] - ny * radius]);
        });
        const cone = [...left, ...right.reverse()];
        cone.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
        ctx.closePath();
        ctx.fillStyle = isWn ? 'rgba(168, 85, 247, 0.09)' : 'rgba(255, 255, 255, 0.08)';
        ctx.fill();
        ctx.strokeStyle = isWn ? 'rgba(192, 132, 252, 0.45)' : 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash(isWn ? [6 / zoom, 3 / zoom] : [4 / zoom, 4 / zoom]);
        ctx.stroke();
        ctx.restore();

        // Future Track Line
        ctx.save();
        ctx.beginPath();
        future.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.xy[0], pt.xy[1]); else ctx.lineTo(pt.xy[0], pt.xy[1]); });
        ctx.strokeStyle = isWn ? '#c084fc' : '#ffffff';
        ctx.lineWidth = (isWn ? 2.6 : 2.2) / zoom;
        if (isWn) ctx.setLineDash([8 / zoom, 4 / zoom]);
        ctx.stroke();
        ctx.restore();
      }

      // Past Track Line
      const past = points.slice(0, currentIdx + 1);
      if (past.length > 1) {
        ctx.save();
        ctx.beginPath();
        past.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.xy[0], pt.xy[1]); else ctx.lineTo(pt.xy[0], pt.xy[1]); });
        ctx.strokeStyle = isWn ? 'rgba(192, 132, 252, 0.55)' : 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1.4 / zoom;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Wind Radii / Swaths
    if (S.overlays.wind && current) {
      const swaths = ((st.windRadiiGeojson && st.windRadiiGeojson.features) || [])
        .filter((f) => Number((f.properties || {}).tau) === Number(current.lead_hours));

      if (swaths.length) {
        swaths.forEach((feat) => {
          const props = feat.properties || {}, tier = `${props.radii}kt`;
          const style = WIND_TIER_STYLE[tier] || WIND_TIER_STYLE['34kt'];
          const geom = feat.geometry || {};
          const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates || [];
          ctx.save();
          ctx.beginPath();
          polys.forEach((poly) => {
            poly.forEach((ring) => {
              ring.forEach((c, i) => {
                const [sx, sy] = S.mapScreen(c[0], c[1]);
                if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
              });
            });
          });
          ctx.fillStyle = style.fill;
          ctx.fill();
          ctx.strokeStyle = style.color;
          ctx.lineWidth = 1.2 / zoom;
          ctx.stroke();
          ctx.restore();
        });
      } else {
        // Fallback scalar circles
        const radii = st.wind_radii_km || {};
        [['34kt', radii['34kt']], ['50kt', radii['50kt']], ['64kt', radii['64kt']]].forEach(([label, km]) => {
          if (!km) return;
          const style = WIND_TIER_STYLE[label];
          const r = Math.max(4, km / 6371 * S.mapScale);
          ctx.save();
          ctx.beginPath();
          ctx.arc(current.xy[0], current.xy[1], r, 0, Math.PI * 2);
          ctx.fillStyle = style.fill;
          ctx.fill();
          ctx.strokeStyle = style.color;
          ctx.lineWidth = 1.2 / zoom;
          ctx.stroke();
          ctx.restore();
        });
      }
    }

    // Track Fix Points & Labels
    {
      points.forEach((pt, i) => {
        const isCur = pt.selected;
        const tier = stormTier(pt.raw && pt.raw.vmax_kt != null ? pt.raw.vmax_kt : null, st.isCyclone);
        const centerColor = isWn ? '#c084fc' : tier.color;

        if (isCur) {
          // Glow / Pulse Circle
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.xy[0], pt.xy[1], 16 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = centerColor;
          ctx.globalAlpha = 0.26;
          ctx.fill();
          ctx.restore();

          // Glyph Circle
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.xy[0], pt.xy[1], 10 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#071018';
          ctx.fill();
          ctx.strokeStyle = centerColor;
          ctx.lineWidth = 2 / zoom;
          ctx.stroke();

          // Text label inside glyph
          ctx.fillStyle = centerColor;
          ctx.font = `bold ${Math.round(11 / zoom)}px ${S.fontSans || 'sans-serif'}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(st.isCyclone ? (tier.cat ? `C${tier.cat}` : 'TS') : 'L', pt.xy[0], pt.xy[1]);
          ctx.restore();

          // Model Badge (e.g. "WN2 AI" vs "NHC") above center
          ctx.save();
          const badgeText = isWn ? 'WN2 AI' : 'NHC';
          ctx.font = `bold ${Math.round(8.5 / zoom)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const tagY = pt.xy[1] - 13 / zoom;
          ctx.fillStyle = '#071018';
          const textW = ctx.measureText(badgeText).width;
          ctx.fillRect(pt.xy[0] - textW / 2 - 3 / zoom, tagY - 10 / zoom, textW + 6 / zoom, 11 / zoom);
          ctx.strokeStyle = centerColor;
          ctx.lineWidth = 1 / zoom;
          ctx.strokeRect(pt.xy[0] - textW / 2 - 3 / zoom, tagY - 10 / zoom, textW + 6 / zoom, 11 / zoom);
          ctx.fillStyle = centerColor;
          ctx.fillText(badgeText, pt.xy[0], tagY);
          ctx.restore();
        } else {
          ctx.save();
          ctx.beginPath();
          const r = (i < currentIdx ? 3.2 : 4) / zoom;
          ctx.arc(pt.xy[0], pt.xy[1], r, 0, Math.PI * 2);
          ctx.fillStyle = i < currentIdx ? '#64748b' : centerColor;
          ctx.fill();
          ctx.strokeStyle = '#071018';
          ctx.lineWidth = 1 / zoom;
          ctx.stroke();
          ctx.restore();
        }

        // Lead label (+0h, +6h...)
        if (pt.lead_hours >= 0) {
          ctx.save();
          ctx.font = `bold ${Math.round(9 / zoom)}px sans-serif`;
          ctx.fillStyle = isWn ? '#e9d5ff' : '#ffffff';
          ctx.strokeStyle = '#071018';
          ctx.lineWidth = 2.5 / zoom;
          ctx.strokeText(`+${pt.lead_hours}h`, pt.xy[0] + 10 / zoom, pt.xy[1] - 8 / zoom);
          ctx.fillText(`+${pt.lead_hours}h`, pt.xy[0] + 10 / zoom, pt.xy[1] - 8 / zoom);
          ctx.restore();
        }
      });
    }
  }
}



function stormCategory(vmaxKt) {
  if (vmaxKt < 64) return null;
  if (vmaxKt < 83) return 1; if (vmaxKt < 96) return 2;
  if (vmaxKt < 113) return 3; if (vmaxKt < 137) return 4; return 5;
}

function stormTier(vmaxKt, isCyclone = true) {
  if (vmaxKt == null) return { cat: null, color: '#94a3b8', label: 'Unknown intensity' };
  if (!isCyclone) return vmaxKt < 34
    ? { cat: null, color: '#38bdf8', label: 'Surface low' }
    : { cat: null, color: '#fbbf24', label: 'Strong surface low' };
  if (vmaxKt < 34) return { cat: null, color: '#38bdf8', label: 'Tropical depression' };
  if (vmaxKt < 64) return { cat: null, color: '#34d399', label: 'Tropical storm' };
  const cat = stormCategory(vmaxKt);
  const color = { 1: '#fbbf24', 2: '#fb923c', 3: '#f87171', 4: '#f43f5e', 5: '#a78bfa' }[cat] || '#f87171';
  return { cat, color, label: `Category ${cat}` };
}

/* ==========================================================================
   Initialization pairing

   A cyclone track and a county-outage field are two views of ONE model run.
   Showing a storm from one initialization over an outage forecast from
   another is a false picture, so every track drawn on the map must carry a
   forecast_init_time_utc equal to the selected cycle's own initialization.
   Tracks that fail the test are not dimmed or approximated - they are not
   drawn, and the storm panel says which init they came from instead.
   The NOAA NHC layer is deliberately exempt: an official advisory is a
   separate forecaster-issued product with its own issue time, not another
   view of this model run, and it is labelled with that time wherever shown.
   ========================================================================== */

// The initialization the currently selected cycle was run from.
function cycleInitIso(cycle = S.cycle) {
  if (!cycle) return null;
  const meta = cycle.meta || {};
  return cycle.issued_utc || meta.forecast_init_time_utc || null;
}

function trackInitIso(trackSource) {
  if (!trackSource) return null;
  return trackSource.forecast_init_time_utc || trackSource.init_time_utc || null;
}

// Exact instant comparison. Two runs six hours apart are different runs.
function sameInit(a, b) {
  if (!a || !b) return false;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

function trackPairsWithCycle(trackSource, cycle = S.cycle) {
  return sameInit(trackInitIso(trackSource), cycleInitIso(cycle));
}

// WeatherNext tracks from the shared index that belong to THIS cycle's run.
// The index is refreshed independently of county-risk exports, so it routinely
// holds a newer (or older) init than the cycle on screen.
function pairedWnTracks(cycle = S.cycle) {
  return (S.wnTracks || []).filter((t) => trackPairsWithCycle(t, cycle));
}

// Every WeatherNext track the browser has loaded, paired or not - used only to
// explain an absence, never to draw.
function unpairedWnTracks(cycle = S.cycle) {
  return (S.wnTracks || []).filter((t) => !trackPairsWithCycle(t, cycle));
}

function isWeatherNextTrack(trackSource) {
  if (!trackSource) return false;
  const provenance = `${trackSource.source || ''} ${trackSource.model || ''} ${trackSource.hazard_source || ''}`;
  return /weathernext|deepmind/i.test(provenance);
}

// WeatherNext tracks actually on the map for this cycle: the per-cycle track
// when it is a WeatherNext one, plus any paired entries from the shared index
// that it does not already stand for.
function pairedWnTrackCount(cycle = S.cycle) {
  const fromIndex = pairedWnTracks(cycle);
  if (!isWeatherNextTrack(S.track)) return fromIndex.length;
  const own = S.track.storm_id || S.track.name;
  return 1 + fromIndex.filter((t) => (t.storm_id || t.name) !== own).length;
}

function hasPairedTrack(cycle = S.cycle) {
  return Boolean(S.track || pairedWnTracks(cycle).length);
}

// Null-safe short label for an initialization instant. formatCycleTime maps
// a missing value onto the epoch, which would read as "Jan 1, 1970".
function formatInitShort(iso) {
  if (!iso) return 'an unknown initialization';
  const date = new Date(iso);
  if (Number.isNaN(+date)) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${hh}:${mm} UTC`;
}

// One sentence naming the init that was withheld, for the storm panel.
function pairingNote(cycle = S.cycle) {
  const cycleInit = cycleInitIso(cycle);
  const others = unpairedWnTracks(cycle);
  if (!others.length) {
    return `No WeatherNext cyclone track was produced for the ${formatInitShort(cycleInit)} initialization.`;
  }
  const inits = [...new Set(others.map((t) => trackInitIso(t)).filter(Boolean))];
  const initList = inits.map(formatInitShort).join(', ') || 'another run';
  return `The available WeatherNext track is initialized ${initList}, not ${formatInitShort(cycleInit)}. `
    + 'A storm track is only shown alongside the outage forecast from the same initialization.';
}

function matchTrackIndexToCycle(trackSource, cycle) {
  if (!trackSource || !Array.isArray(trackSource.points) || !trackSource.points.length) return 0;
  if (!cycle) return Number(trackSource.current_index || 0);

  const meta = cycle.meta || {};
  const targetIso = meta.valid_start_utc || cycle.valid_start_utc || null;
  const targetMs = targetIso ? Date.parse(targetIso) : (Date.parse(cycle.issued_utc) + Number(cycle.lead_hours || 0) * 36e5);

  if (Number.isFinite(targetMs)) {
    let bestIdx = -1, bestDiff = Infinity;
    trackSource.points.forEach((pt, idx) => {
      let ptMs = NaN;
      if (pt.valid_iso) ptMs = Date.parse(pt.valid_iso);
      else if (pt.valid_utc && /^\d{2}\/\d{4}$/.test(pt.valid_utc) && cycle.issued_utc) {
        const issueDate = new Date(cycle.issued_utc);
        const day = parseInt(pt.valid_utc.slice(0, 2), 10);
        const hour = parseInt(pt.valid_utc.slice(3, 5), 10);
        const min = parseInt(pt.valid_utc.slice(5, 7), 10);
        const d = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), day, hour, min, 0));
        ptMs = d.getTime();
      }
      if (Number.isFinite(ptMs)) {
        const diff = Math.abs(ptMs - targetMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = idx;
        }
      }
    });
    if (bestIdx >= 0 && bestDiff <= 12 * 36e5) return bestIdx;
  }

  const cycleLead = cycle.lead_hours != null ? Number(cycle.lead_hours)
    : meta.forecast_horizon_hours != null ? Number(meta.forecast_horizon_hours) : null;
  if (cycleLead != null) {
    let bestIdx = -1, bestDiff = Infinity;
    trackSource.points.forEach((pt, idx) => {
      if (pt.lead_hours != null) {
        const diff = Math.abs(Number(pt.lead_hours) - cycleLead);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = idx;
        }
      }
    });
    if (bestIdx >= 0 && bestDiff <= 12) return bestIdx;
  }

  return Number(trackSource.current_index || 0);
}

function stormMeta(trackSource = S.track, selectedFrame = S.trackFrame) {
  if (!trackSource || !Array.isArray(trackSource.points) || !trackSource.points.length) return null;
  const currentIndex = Math.max(0, Math.min(
    trackSource.points.length - 1,
    selectedFrame == null ? matchTrackIndexToCycle(trackSource, S.cycle) : selectedFrame
  ));
  const current = trackSource.points[currentIndex];
  const coneByLead = trackSource.cone_radius_nm_by_lead || {};
  const points = trackSource.points.map((point, i) => {
    const lead = point.lead_hours != null ? point.lead_hours : (i - currentIndex) * 6;
    const coneNm = point.cone_radius_nm != null ? point.cone_radius_nm
      : coneByLead[String(lead)] != null ? coneByLead[String(lead)]
      : lead >= 0 ? 12 + 1.7 * lead + .013 * lead ** 2 : 0;
    return {
      lat: point.lat, lon: point.lon, lead_hours: lead,
      valid_time_utc: point.valid_utc, max_wind_ms: point.vmax_kt * .514444,
      pressure_hpa: point.pmin_mb, uncertainty_km: coneNm * 1.852,
      raw: point, selected: i === currentIndex,
    };
  });
  const classification = trackSource.classification || current.stage || '';
  const isCyclone = /tropical|cyclone|hurricane|typhoon|depression/i.test(classification)
    || /nhc|atcf/i.test(String(trackSource.source || ''));
  const isAiEnsemble = /weathernext|deepmind|ensemble/i.test(String(trackSource.source || trackSource.model || ''));
  return {
    classification,
    isCyclone,
    isAiEnsemble,
    trackSourceKind: isAiEnsemble ? 'weathernext' : 'official',
    category: isCyclone ? stormCategory(current.vmax_kt) : null,
    center_lat: current.lat, center_lon: current.lon,
    max_wind_ms: current.vmax_kt * .514444, max_wind_kt: current.vmax_kt,
    min_pressure_hpa: current.pmin_mb,
    wind_radii_km: { '34kt': current.r34_nm * 1.852, '50kt': current.r50_nm * 1.852, '64kt': current.r64_nm * 1.852 },
    currentIndex, track: points, stormId: trackSource.storm_id || trackSource.name || '',
    name: trackSource.name || 'Cyclone',
    sourceLabel: trackSource.source || (isAiEnsemble ? 'Google DeepMind WeatherNext' : 'NOAA NHC Official Advisory'),
    windRadiiGeojson: trackSource.wind_radii_geojson || null,
  };
}

/* ==========================================================================
   Pointer Hit Testing & Floating HUD Tooltip
   ========================================================================== */
function getCountyAtScreen(mx, my) {
  if (!S.hitCtx) return null;
  const bx = Math.round((mx - S.panX) / S.zoom);
  const by = Math.round((my - S.panY) / S.zoom);
  const W = S.hitCanvas.width, H = S.hitCanvas.height;

  if (bx < 0 || bx >= W || by < 0 || by >= H) return null;
  const p = S.hitCtx.getImageData(bx, by, 1, 1).data;
  const idx = ((p[0] << 16) | (p[1] << 8) | p[2]) - 1;
  return (idx >= 0 && idx < S.projectedCounties.length) ? S.projectedCounties[idx] : null;
}

function handlePointerHover(mx, my, clientX, clientY) {
  const hit = getCountyAtScreen(mx, my);
  if (!hit) {
    if (S.hoveredFips) {
      S.hoveredFips = null;
      requestMapRedraw();
    }
    hideTooltip();
    return;
  }

  if (S.hoveredFips !== hit.fips) {
    S.hoveredFips = hit.fips;
    requestMapRedraw();
  }
  showTooltip(hit.fips, mx, my);
}

function handlePointerClick(mx, my) {
  const hit = getCountyAtScreen(mx, my);
  if (!hit) return;
  // Inspecting a county re-centres it and never pulls the zoom back out: an
  // operator who has zoomed into a metro keeps that scale while they click
  // through neighbouring counties.
  focusMapPoint(hit.centroid[0], hit.centroid[1], 2.8);
  openDrawer(hit.fips);
}

function showTooltip(fips, mx, my) {
  const row = S.byFips.get(String(fips));
  const tip = $('map-tooltip');
  if (!row || !tip) return;

  const layer = activeLayer();
  const val = row[layer.key];
  const isTrig = S.triggered.has(String(fips));
  const isEx = row.training_envelope_flag && row.training_envelope_flag !== 'inside';

  tip.innerHTML = `
    <div class="tooltip-head">
      <span class="tooltip-title">${esc(row.county_name)}, ${esc(row.state)}</span>
      <span class="tooltip-fips">FIPS ${esc(row.county_fips)}</span>
    </div>
    <div class="tooltip-stats-grid">
      <div class="tooltip-stat-item">
        <span class="tooltip-stat-label">Expected Out</span>
        <span class="tooltip-stat-val">${num(row.expected_customers_out)}</span>
      </div>
      <div class="tooltip-stat-item">
        <span class="tooltip-stat-label">P90 Outage</span>
        <span class="tooltip-stat-val">${num(row.p90_customers_out)}</span>
      </div>
      <div class="tooltip-stat-item">
        <span class="tooltip-stat-label">${esc(layerLabel(layer))}</span>
        <span class="tooltip-stat-val">${fmt(val, layer.fmt)}</span>
      </div>
      <div class="tooltip-stat-item">
        <span class="tooltip-stat-label">P(Outage &gt; 5%)</span>
        <span class="tooltip-stat-val">${fmt(row.prob_outage_fraction_gt_05, 'pct')}</span>
      </div>
    </div>
    <div class="tooltip-badge-row">
      ${isTrig ? '<span class="tooltip-badge triggered">Threshold Triggered</span>' : ''}
      ${isEx ? '<span class="tooltip-badge">Extrapolated</span>' : ''}
      <span class="tooltip-badge">${row.product_confidence || 'normal'}</span>
    </div>
  `;

  // Position tooltip relative to map container
  const wrap = $('mapwrap').getBoundingClientRect();
  let left = mx + 16;
  let top = my + 16;
  if (left + 260 > wrap.width) left = mx - 270;
  if (top + 160 > wrap.height) top = my - 160;

  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
  tip.hidden = false;
}

function hideTooltip() {
  const tip = $('map-tooltip');
  if (tip) tip.hidden = true;
}

/* ==========================================================================
   UI Controls & Toolbars
   ========================================================================== */
// The layers available for the cycle on screen. Verification layers are
// offered only when the loaded payload actually carries observations, so a
// forecast can never render an "observed" layer at all.
function availableLayers() {
  const columns = S.counties.length ? Object.keys(S.counties[0]) : [];
  const extra = VERIFICATION_LAYERS.filter((layer) => columns.includes(layer.key));
  return LAYERS.concat(extra);
}

function buildLayers() {
  const host = $('layers');
  if (!host) return;
  host.innerHTML = '';
  const layers = availableLayers();
  // If the previous cycle was a hindcast and this one is not, the selected
  // layer may no longer exist. Fall back rather than rendering a blank map.
  if (!layers.some((layer) => layer.key === S.layer)) S.layer = LAYERS[0].key;
  layers.forEach((layer) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = layerLabel(layer);
    btn.setAttribute('role', 'tab');
    if (layer.verification) {
      btn.classList.add('layer-verification');
      btn.title = 'Verification layer — what actually happened, available only for hindcasts';
    }
    if (layer.key === 'peak_gust_ms') btn.title = windLabel(false);
    btn.setAttribute('aria-selected', String(layer.key === S.layer));
    btn.addEventListener('click', () => {
      S.layer = layer.key;
      [...host.children].forEach((c) => c.setAttribute('aria-selected', String(c === btn)));
      $('map-title').textContent = S.layer === 'peak_gust_ms' ? 'County Wind Field' : 'County Outage Risk';
      requestMapRedraw();
    });
    host.appendChild(btn);
  });
}

function wireOverlays() {
  document.querySelectorAll('[data-overlay]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.overlay;
    S.overlays[key] = !S.overlays[key];
    btn.setAttribute('aria-pressed', String(S.overlays[key]));
    if (key === 'nhc' || key === 'track') {
      projectMapGeometry();
      drawSourceStack();
    }
    requestMapRedraw();
  }));
}

// The extent buttons are `button[data-view]` and nothing else. Scoping the
// selector to buttons is what keeps the document root (which carries its own
// surface attribute) from ever being wired as a map control again.
function viewButtons() {
  return document.querySelectorAll('button[data-view]');
}

function setViewButtonState(active) {
  viewButtons().forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.view === active)));
}

// Storm is useless with every track overlay switched off, so asking for the
// storm extent turns on whichever track layer actually has data.
function ensureStormOverlayVisible() {
  if (S.overlays.track || S.overlays.nhc) return false;
  const hasModelTrack = hasPairedTrack();
  const hasNhc = Boolean(S.nhcTracks && S.nhcTracks.length);
  if (hasModelTrack) S.overlays.track = true;
  else if (hasNhc) S.overlays.nhc = true;
  else return false;
  ['track', 'nhc'].forEach((key) => {
    const btn = document.querySelector(`[data-overlay="${key}"]`);
    if (btn) btn.setAttribute('aria-pressed', String(Boolean(S.overlays[key])));
  });
  return true;
}

function applyMapView(view) {
  S.view = view;
  const overlayChanged = view === 'storm' ? ensureStormOverlayVisible() : false;
  resetViewport();
  setViewButtonState(view);
  projectMapGeometry();
  requestMapRedraw();
  if (overlayChanged) drawSourceStack();
}

// Focus Max is an action, not an extent. It needs a projection that contains
// the counties, so a storm frame is swapped for the event frame before
// centring, and the zoom is set outright instead of inheriting a deeper one.
function focusHighestRiskCounty() {
  if (S.view === 'storm') {
    S.view = 'event';
    resetViewport();
    projectMapGeometry();
  }
  const ranked = [...S.counties].sort((a, b) => {
    const delta = (Number(b.expected_customers_out) || 0) - (Number(a.expected_customers_out) || 0);
    return delta !== 0 ? delta : (Number(b.p90_customers_out) || 0) - (Number(a.p90_customers_out) || 0);
  });
  const top = ranked[0];
  if (!top) return;
  const county = S.projectedCounties.find((pc) => pc.fips === String(top.county_fips));
  if (!county) return;
  focusMapPoint(county.centroid[0], county.centroid[1], 6, { exact: true });
  setViewButtonState('focus');
  openDrawer(county.fips);
}

function wireMapControls() {
  viewButtons().forEach((btn) => btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view === 'focus') focusHighestRiskCounty();
    else if (view === 'conus' || view === 'event' || view === 'storm') applyMapView(view);
  }));
  setViewButtonState(S.view);

  $('zoom-in').addEventListener('click', () => zoomMap(1.35));
  $('zoom-out').addEventListener('click', () => zoomMap(1 / 1.35));
  // Reset returns to the original CONUS framing, matching the CONUS button.
  $('zoom-reset').addEventListener('click', () => applyMapView('conus'));
}

function wireSearch() {
  const input = $('county-search');
  const dropdown = $('search-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q || q.length < 2) {
      dropdown.hidden = true;
      return;
    }

    const matches = S.counties.filter((r) => {
      const name = String(r.county_name || '').toLowerCase();
      const st = String(r.state || '').toLowerCase();
      const fips = String(r.county_fips || '');
      return name.includes(q) || st === q || fips.startsWith(q);
    }).slice(0, 10);

    if (!matches.length) {
      dropdown.hidden = true;
      return;
    }

    dropdown.innerHTML = matches.map((r) => `
      <div class="search-item" data-fips="${esc(r.county_fips)}">
        <strong>${esc(r.county_name)}, ${esc(r.state)}</strong>
        <span>FIPS ${esc(r.county_fips)} · ${num(r.expected_customers_out)} out</span>
      </div>
    `).join('');
    dropdown.hidden = false;

    dropdown.querySelectorAll('.search-item').forEach((item) => {
      item.addEventListener('click', () => {
        const fips = item.dataset.fips;
        const pc = S.projectedCounties.find((c) => c.fips === fips);
        if (pc) {
          focusMapPoint(pc.centroid[0], pc.centroid[1], 3.8);
          openDrawer(fips);
        }
        dropdown.hidden = true;
        input.value = '';
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.map-toolbar-search')) {
      dropdown.hidden = true;
    }
  });
}

function wireExport() {
  const btn = $('export-priority');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const rows = [...S.counties].sort((a, b) => (b.expected_customers_out || 0) - (a.expected_customers_out || 0)).slice(0, 50);
    const headers = ['County', 'State', 'FIPS', 'Expected_Out', 'P90_Out', 'Prob_GT_05', 'Peak_Gust_ms', 'Confidence'];
    const csvLines = [headers.join(',')];
    for (const r of rows) {
      csvLines.push([
        `"${r.county_name || ''}"`,
        `"${r.state || ''}"`,
        `"${r.county_fips || ''}"`,
        r.expected_customers_out || 0,
        r.p90_customers_out || 0,
        r.prob_outage_fraction_gt_05 || 0,
        r.peak_gust_ms || 0,
        `"${r.product_confidence || r.data_quality_flag || 'normal'}"`,
      ].join(','));
    }
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Weather2Grid_Priority_Counties_${(S.cycle && S.cycle.cycle_id) || 'export'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
}

function activeLayer() {
  return availableLayers().find((l) => l.key === S.layer) || LAYERS[0];
}
function layerDomain(layer) {
  const values = S.counties.map((r) => r[layer.key]).filter((v) => v != null && !Number.isNaN(v));
  const maxVal = values.length ? Math.max(...values) : 1;
  if (layer.key === 'expected_outage_fraction') {
    return [0, Math.min(0.35, Math.max(0.10, Math.ceil(maxVal * 20) / 20))];
  }
  if (layer.fixed) return layer.fixed;
  return values.length ? [0, maxVal || 1] : [0, 1];
}

function drawLegend(layer, lo, hi, stops) {
  $('legend').innerHTML = `
    <div class="lt">${esc(layerLabel(layer))}</div>
    <div class="ramp" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
    <div class="ends"><span>${fmt(lo, layer.fmt)}</span><span>${fmt(hi, layer.fmt)}</span></div>
    <div class="scale-bar"><i id="scale-line"></i><span id="scale-label">—</span></div>
  `;
}

function updateScaleBar() {
  const line = $('scale-line'), label = $('scale-label');
  if (!line || !label || !S.mapScale) return;
  const candidates = [10, 25, 50, 100, 200, 500, 1000, 2000];
  const pixels = (km) => km / 6371 * S.mapScale * S.zoom;
  const km = candidates.reduce((best, v) => Math.abs(pixels(v) - 70) < Math.abs(pixels(best) - 70) ? v : best, candidates[0]);
  line.style.width = `${Math.max(18, Math.min(110, pixels(km)))}px`;
  label.textContent = `${km.toLocaleString()} km`;
}

/* ==========================================================================
   Threshold, KPIs & Analytics
   ========================================================================== */
function wireRatio() {
  const input = $('ratio');
  S.ratio = Math.pow(10, +input.value);
  $('ratio-val').textContent = S.ratio.toFixed(2);
  input.addEventListener('input', async () => {
    S.ratio = Math.pow(10, +input.value);
    $('ratio-val').textContent = S.ratio.toFixed(S.ratio < .1 ? 3 : 2);
    await refreshTriggered();
    drawKpis();
    requestMapRedraw();
    drawCurve();
  });
}

async function refreshTriggered() {
  if (!S.cycle) return;
  const counties = S.counties.filter((r) => Number(r.prob_outage_fraction_gt_05) > S.ratio);
  S.triggered = new Set(counties.map((r) => String(r.county_fips)));
  $('trig-count').textContent = integer.format(counties.length);
  $('threshold-pct').textContent = `${Math.round(counties.length / Math.max(1, S.counties.length) * 100)}% of domain`;
}

async function drawCurve() {
  if (!S.cycle) return;
  const cycleId = S.cycle.cycle_id;
  if (!S.curve) {
    const curve = Array.from({ length: 60 }, (_, i) => {
      const ratio = Math.pow(10, Math.log10(.02) + i / 59 * (Math.log10(1) - Math.log10(.02)));
      return { cost_loss_ratio: ratio, counties_triggered: S.counties.filter((r) => Number(r.prob_outage_fraction_gt_05) > ratio).length };
    });
    S.curve = { threshold_field: 'prob_outage_fraction_gt_05', n_counties: S.counties.length, curve };
  }
  if (!S.cycle || S.cycle.cycle_id !== cycleId) return;

  const svg = $('clcurve'), W = svg.clientWidth || 290, H = 66, pad = 5;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const maxY = Math.max(...S.curve.curve.map((pt) => pt.counties_triggered), 1);
  const X = (ratio) => pad + (Math.log10(ratio) - Math.log10(.02)) / (Math.log10(1) - Math.log10(.02)) * (W - pad * 2);
  const Y = (count) => H - 12 - count / maxY * (H - 18);
  const points = S.curve.curve.map((pt) => `${X(pt.cost_loss_ratio).toFixed(1)},${Y(pt.counties_triggered).toFixed(1)}`).join(' ');
  const cursor = X(S.ratio);

  svg.innerHTML = `
    <defs>
      <linearGradient id="curve-fill" x1="0" x2="1">
        <stop stop-color="#38bdf8" stop-opacity=".35"/>
        <stop offset="1" stop-color="#a78bfa" stop-opacity=".05"/>
      </linearGradient>
    </defs>
    <polygon fill="url(#curve-fill)" points="${pad},${H - 12} ${points} ${W - pad},${H - 12}"/>
    <polyline fill="none" stroke="#38bdf8" stroke-width="1.8" points="${points}"/>
    <line x1="${cursor}" y1="3" x2="${cursor}" y2="${H - 12}" stroke="#fb923c" stroke-width="1.5" stroke-dasharray="3 3"/>
    <text x="${pad}" y="${H - 1}" font-size="8" fill="#64748b">C/L 0.02</text>
    <text x="${W - pad}" y="${H - 1}" font-size="8" fill="#64748b" text-anchor="end">1.0</text>
  `;
}

function drawKpis() {
  const regional = S.cycle.meta.regional || {};
  const expVal = regional.expected == null ? S.counties.reduce((sum, r) => sum + (r.expected_customers_out || 0), 0) : regional.expected;
  $('kpi-expected').textContent = compact.format(expVal);

  const p90Val = regional.p90;
  $('kpi-p90').textContent = p90Val == null ? '—' : compact.format(p90Val);

  $('kpi-triggered').textContent = integer.format(S.triggered.size);
  $('kpi-triggered-note').textContent = `counties above C/L ${S.ratio.toFixed(2)}`;

  const gust = Math.max(...S.counties.map((r) => r.peak_gust_ms || 0));
  $('kpi-gust').textContent = gust ? `${gust.toFixed(0)} m/s` : '—';
  $('kpi-gust-label').textContent = windLabel(false);

  const states = [...new Set(S.counties.map((r) => r.state))].sort();
  $('kpi-domain').textContent = `${integer.format(S.counties.length)} counties · ${states.length > 20 ? 'CONUS' : states.join(' + ')}`;
}

function providerTargetIndex(providerId) {
  const indices = providerFrameIndices(providerId);
  if (!indices.length) return null;
  if (providerId === 'weathernext3' || providerId === 'weathernext2') return indices[0];
  return indices.slice().sort((a, b) => {
    const A = S.cycles[a], B = S.cycles[b];
    const ta = Date.parse(A.issued_utc) || 0, tb = Date.parse(B.issued_utc) || 0;
    return ta === tb ? Number(A.lead_hours || 0) - Number(B.lead_hours || 0) : tb - ta;
  })[0];
}

/* ==========================================================================
   Forecast initialization picker

   The archive keeps the last few initializations per hazard source. This
   switches between them. The hard requirement is that an archived run never
   reads as current guidance, so choosing one repaints the control amber, the
   headline, the freshness pill and the counter all say so, and the choice is
   dropped the moment it stops being available.
   ========================================================================== */
function formatInitStamp(issued) {
  const date = new Date(issued);
  if (Number.isNaN(+date)) return String(issued || 'unknown');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()} ${String(date.getUTCHours()).padStart(2, '0')}Z`;
}

// A hindcast verifies a storm that happened years ago, so its stamp carries
// the year. A forecast initialization's does not: everything in that list is
// days old at most, and the year would be noise on every row.
function formatEventStamp(issued) {
  const date = new Date(issued);
  if (Number.isNaN(+date)) return String(issued || 'unknown');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()} ${date.getUTCFullYear()}`;
}

function initAgeLabel(issued) {
  const date = new Date(issued);
  if (Number.isNaN(+date)) return '';
  const hours = (Date.now() - date.getTime()) / 36e5;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function closeInitMenu() {
  const menu = $('init-menu'), toggle = $('init-toggle');
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

function closeRunMenu() {
  const menu = $('run-menu'), toggle = $('run-toggle');
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

function providerRunLabel(providerId, fallback) {
  if (providerId === 'hrrr') return 'NOAA HRRR';
  if (providerId === 'weathernext3') return 'WeatherNext 3';
  if (providerId === 'weathernext2') return 'WeatherNext 2';
  if (providerId === 'gfs') return 'NOAA GFS / GEFS';
  return fallback;
}

function selectAvailableRun(run) {
  closeRunMenu();
  stopPlayback();
  S.activeProvider = run.providerId;
  // Live entries deliberately follow their provider's current run; archive
  // entries pin the exact issued time because nothing there is "latest".
  S.selectedInit = S.archiveMode || !run.isLatest ? run.issued : null;
  const target = providerTargetIndex(run.providerId);
  if (target != null) loadCycle(target);
}

function drawRunPicker() {
  const picker = $('run-picker'), menu = $('run-menu'), label = $('run-label');
  if (!picker || !menu || !label) return;
  const runs = availableRuns();
  picker.hidden = !S.archiveMode || runs.length < 2;
  if (picker.hidden) { closeRunMenu(); return; }

  label.textContent = 'Archived runs';

  // An archived forecast and a hindcast are different kinds of thing, so the
  // menu groups them instead of interleaving by date: one is an older view of
  // a real forecast, the other a measurement of a storm that has already
  // happened. Naming a hindcast by its issue time -- "Sep 29 02Z" -- says
  // nothing about which storm it verifies, so it is named by the storm.
  const runRow = (run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const active = run.providerId === S.activeProvider
      && activeInitialization(run.providerId)?.issued === run.issued;
    button.setAttribute('aria-selected', String(active));
    const hindcast = run.kind === 'hindcast';

    const name = document.createElement('b');
    name.textContent = hindcast
      ? String(run.eventName || '').replace(/\s*\u2014\s*hindcast$/i, '') || formatEventStamp(run.issued)
      : `${providerRunLabel(run.providerId, run.providerLabel)} \u00b7 ${formatInitStamp(run.issued)}`;
    const tag = document.createElement('span');
    tag.className = `init-tag${hindcast ? ' hindcast' : ' archived'}`;
    tag.textContent = hindcast ? 'hindcast' : 'archived';
    name.append(tag);

    const detail = document.createElement('em');
    const horizon = run.horizonHours ? ` \u00b7 ${Math.round(run.horizonHours / 24)}d horizon` : '';
    detail.textContent = hindcast
      ? `verified against observed outages \u00b7 ${formatEventStamp(run.issued)}`
      : `${run.cycles} window${run.cycles === 1 ? '' : 's'}${horizon}`;
    button.append(name, detail);
    button.addEventListener('click', () => selectAvailableRun(run));
    return button;
  };

  const groupHeading = (text) => {
    const heading = document.createElement('div');
    heading.className = 'run-menu-group';
    heading.textContent = text;
    return heading;
  };

  const forecasts = runs.filter((run) => run.kind !== 'hindcast');
  const hindcasts = runs.filter((run) => run.kind === 'hindcast');
  const children = [];
  if (forecasts.length) {
    children.push(groupHeading('Archived forecast initializations'),
                  ...forecasts.map(runRow));
  }
  if (hindcasts.length) {
    children.push(groupHeading('Hindcast verification \u2014 scored against observed outages'),
                  ...hindcasts.map(runRow));
  }
  menu.replaceChildren(...children);
}

function selectInitialization(issued) {
  const list = providerInitializations();
  const target = list.find((entry) => entry.issued === issued);
  closeInitMenu();
  if (!target) return;
  stopPlayback();
  // null rather than the newest timestamp, so the view keeps following the
  // latest run as new initializations arrive instead of pinning to what
  // happened to be newest when the page was opened.
  S.selectedInit = target.isLatest ? null : target.issued;
  const frames = providerFrameIndices();
  if (frames.length) loadCycle(frames[0]);
}

function drawInitPicker() {
  const picker = $('init-picker'), menu = $('init-menu'), label = $('init-label');
  if (!picker || !menu || !label) return;
  const list = providerInitializations();
  // One initialization is not a choice; hide the control rather than offer a
  // menu with a single disabled row.
  picker.hidden = list.length < 2;
  if (picker.hidden) { closeInitMenu(); return; }

  const active = activeInitialization();
  const hindcast = Boolean(active && active.kind === 'hindcast');
  const archived = Boolean(active && !active.isLatest && !hindcast);
  picker.dataset.archived = String(archived);
  picker.dataset.hindcast = String(hindcast);
  label.textContent = hindcast
    ? String(active.eventName || '').replace(/\s*—\s*hindcast$/i, '') || 'Hindcast'
    : archived ? formatInitStamp(active.issued) : 'Latest';
  $('init-toggle').title = hindcast
    ? 'Showing a HINDCAST — a past storm scored against what actually happened. Not a forecast. Click to change.'
    : archived
      ? `Showing the archived ${formatInitStamp(active.issued)} run — not current guidance. Click to change.`
      : 'Showing the latest initialization. Click to view an earlier run.';

  const heading = document.createElement('div');
  heading.className = 'init-menu-group';
  // The menu heading has to match what it lists. "Forecast initialization"
  // over a list of hindcast storms is the same category error the tags exist
  // to prevent.
  heading.textContent = list.every((entry) => entry.kind === 'hindcast')
    ? 'Hindcast storm'
    : 'Forecast initialization';
  const rows = list.map((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(active && entry.issued === active.issued));
    const hindcast = entry.kind === 'hindcast';
    const name = document.createElement('b');
    // A hindcast is identified by the storm it verifies, not by an issue time
    // nobody recognises. "Ida 2021" is the useful label; "Aug 29 00Z" is not.
    name.textContent = hindcast
      ? String(entry.eventName || '').replace(/\s*—\s*hindcast$/i, '') || formatInitStamp(entry.issued)
      : formatInitStamp(entry.issued);
    const tag = document.createElement('span');
    tag.className = `init-tag${hindcast ? ' hindcast' : entry.isLatest ? '' : ' archived'}`;
    tag.textContent = hindcast ? 'hindcast' : entry.isLatest ? 'latest' : 'archived';
    name.append(tag);
    const detail = document.createElement('em');
    const horizon = entry.horizonHours ? ` · ${Math.round(entry.horizonHours / 24)}d` : '';
    detail.textContent = hindcast
      ? `verified against observed outages · ${formatInitStamp(entry.issued)}`
      : `${entry.cycles} window${entry.cycles === 1 ? '' : 's'}${horizon} · ${initAgeLabel(entry.issued)}`;
    button.append(name, detail);
    button.addEventListener('click', () => selectInitialization(entry.issued));
    return button;
  });
  menu.replaceChildren(heading, ...rows);
}

function drawSourceSwitch() {
  const host = $('source-switch');
  if (!host) return;
  const present = [...new Set(S.cycles.map((c) => providerFor(c.hazard_source).id))];
  host.replaceChildren(...present.map((id) => {
    const known = PROVIDERS.find((p) => p.id === id);
    const sample = S.cycles[providerFrameIndices(id)[0]];
    const provider = known || providerFor(sample && sample.hazard_source);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(id === S.activeProvider));
    const short = id === 'hrrr' ? 'NOAA HRRR' : id === 'weathernext3' ? 'WeatherNext 3' : id === 'weathernext2' ? 'WeatherNext 2' : provider.label;
    btn.innerHTML = `<b>${esc(short)}</b><span>${esc(providerCoverage(id))}</span>`;
    btn.title = `Switch to ${provider.label}`;
    btn.addEventListener('click', () => {
      stopPlayback();
      // Initializations are per hazard source and rarely line up across
      // providers. Carrying a pin across would silently fall back to that
      // provider's latest while the control still read "archived".
      if (!providerInitializations(id).some((entry) => entry.issued === S.selectedInit)) {
        S.selectedInit = null;
      }
      const target = providerTargetIndex(id);
      if (target != null) loadCycle(target);
    });
    return btn;
  }));
}

function drawSourceStack() {
  const host = $('source-stack');
  if (!host) return;
  const groups = new Map();
  S.cycles.forEach((summary, index) => {
    const provider = providerFor(summary.hazard_source);
    if (!groups.has(provider.id)) groups.set(provider.id, { label: provider.label, indices: [] });
    groups.get(provider.id).indices.push(index);
  });
  const activeId = providerFor((S.cycles[S.idx] || {}).hazard_source).id;
  const ids = [...new Set([...PROVIDERS.map((p) => p.id), ...groups.keys()])];
  const rows = ids.map((id) => {
    const group = groups.get(id);
    const known = PROVIDERS.find((p) => p.id === id);
    const label = group ? group.label : known ? known.label : id;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `source-row${!group ? ' planned' : id === activeId ? ' active' : ''}`;
    const name = document.createElement('span');
    name.append(document.createElement('i'));
    const bold = document.createElement('b');
    bold.textContent = label;
    name.append(bold);
    const state = document.createElement('em');
    if (!group) {
      state.textContent = 'not in archive';
      row.disabled = true;
      row.title = `${label} has no cycles in this archive.`;
    } else {
      state.textContent = id === activeId ? 'active' : providerCoverage(id);
      row.title = `Show ${label} · ${providerCoverage(id)}`;
      row.setAttribute('aria-pressed', String(id === activeId));
      row.addEventListener('click', () => {
        stopPlayback();
        // Resolve the target inside the handler, not at render time: dropping
        // an initialization pin that this provider does not have changes which
        // cycle is the right landing frame.
        if (!providerInitializations(id).some((entry) => entry.issued === S.selectedInit)) {
          S.selectedInit = null;
        }
        const target = providerTargetIndex(id);
        if (target != null) loadCycle(target);
      });
    }
    row.append(name, state);
    return row;
  });

  if (S.wnTracks && S.wnTracks.length) {
    // The cyclone index is refreshed on its own cadence, so it can hold a run
    // this cycle does not share. Say which, rather than showing a count that
    // implies tracks are on the map when they are not.
    const paired = pairedWnTrackCount();
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `source-row${paired ? ' active' : ''}`;
    row.disabled = !paired;
    row.title = paired
      ? 'Show Google DeepMind WeatherNext AI ensemble cyclone tracks for this initialization.'
      : pairingNote();
    row.innerHTML = paired
      ? `<span><i></i><b>WeatherNext AI Cyclones</b></span><em>${paired} track${paired === 1 ? '' : 's'} · this init</em>`
      : `<span><i></i><b>WeatherNext AI Cyclones</b></span><em>withheld · other init</em>`;
    if (paired) row.addEventListener('click', () => applyMapView('storm'));
    rows.push(row);
  }

  if (S.nhcTracks && S.nhcTracks.length) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `source-row${S.overlays.nhc ? ' active' : ''}`;
    row.title = 'Toggle official NOAA NHC active tracks.';
    // NHC is not paired to a model init by design; its own advisory time is
    // what makes it readable next to the forecast.
    const advisory = S.nhcTracks.map((t) => t.advisory_issued_utc).filter(Boolean)[0];
    row.innerHTML = `<span><i></i><b>NOAA NHC ocean storms</b><small>${advisory ? `advisory ${esc(String(advisory))}` : 'official advisory'}</small></span>`
      + `<em>${S.overlays.nhc ? 'visible' : 'hidden (click to show)'}</em>`;
    row.addEventListener('click', () => {
      S.overlays.nhc = !S.overlays.nhc;
      const nhcBtn = document.querySelector('[data-overlay="nhc"]');
      if (nhcBtn) nhcBtn.setAttribute('aria-pressed', String(S.overlays.nhc));
      if (S.overlays.nhc) {
        S.view = 'storm';
        setViewButtonState('storm');
      }
      projectMapGeometry();
      requestMapRedraw();
      drawSourceStack();
    });
    rows.push(row);
  }
  host.replaceChildren(...rows);
}

function drawForecast() {
  const meta = S.cycle.meta, storm = stormMeta(), provider = meta.forecast_provider || meta.hazard_source || 'unknown';
  const isNotEvaluated = Boolean(S.cycle.degraded_mode || S.cycle.freshness === 'degraded' || S.cycle.freshness === 'not evaluated');
  $('provider-status').textContent = isNotEvaluated ? 'not evaluated' : (S.cycle.provider_status || 'ok');
  $('provider-status').className = `source-status${isNotEvaluated ? ' not-evaluated' : ''}`;

  if (!storm) {
    $('storm-symbol').className = 'storm-symbol field';
    $('storm-symbol').innerHTML = '<b>W</b>';
    $('storm-class').textContent = unpairedWnTracks().length
      ? 'Area wind outlook · track from another initialization not shown'
      : meta.event_type === 'tropical_cyclone' ? 'Cyclone metadata pending' : 'Area wind outlook · no cyclone track';
    $('storm-name').textContent = S.cycle.event_name;
    const gusts = S.counties.map((r) => r.peak_gust_ms || 0);
    const peak = gusts.length ? Math.max(...gusts) : 0;
    const galeCount = gusts.filter((v) => v >= 17.5).length;
    $('storm-stats').innerHTML = `
      <div><b>${peak ? `${peak.toFixed(0)} m/s` : '—'}</b><span>${esc(windLabel(false))}</span></div>
      <div><b>${integer.format(galeCount)}</b><span>Counties ≥ 34 kt</span></div>
    `;
    const chip = $('storm-chip');
    chip.hidden = false;
    // Distinguish "this run has no cyclone" from "a cyclone exists but belongs
    // to a different initialization". The second is the case a user would
    // otherwise read as a missing feature.
    chip.innerHTML = unpairedWnTracks().length
      ? `<b>Cyclone track withheld · initialization mismatch</b><span>${esc(pairingNote())}</span>`
      : '<b>Regional wind outlook</b><span>Showing exported county wind field; no ocean cyclone center or wind radii were supplied.</span>';
    return;
  }

  const trackObj = S.track || pairedWnTracks()[0] || (S.nhcTracks && S.nhcTracks[0]) || {};
  const currentPt = (storm.track && storm.track[storm.currentIndex]) || {};
  const curLead = currentPt.lead_hours != null ? currentPt.lead_hours : (S.cycle.lead_hours || 0);

  $('storm-symbol').className = `storm-symbol${storm.isCyclone ? '' : ' low'}`;
  $('storm-symbol').innerHTML = `<b>${storm.isCyclone ? (storm.category ? `C${storm.category}` : 'TS') : 'L'}</b>`;
  $('storm-class').textContent = `${storm.classification || 'Tropical cyclone'}${storm.category != null ? ` · Category ${storm.category}` : ''}`;
  $('storm-name').textContent = `${storm.name || trackObj.name || S.cycle.event_name} · ${storm.stormId || 'track supplied'}`;
  $('storm-stats').innerHTML = `
    <div><b>${Number(storm.center_lat).toFixed(1)}°N, ${Math.abs(storm.center_lon).toFixed(1)}°W</b><span>Fix Center</span></div>
    <div><b>${storm.max_wind_kt || '—'} kt</b><span>Maximum Wind</span></div>
    <div><b>${storm.min_pressure_hpa || '—'} hPa</b><span>Min Pressure</span></div>
    <div><b>+${Math.max(...storm.track.map((pt) => pt.lead_hours))} h</b><span>Track Horizon</span></div>
  `;
  const chip = $('storm-chip');
  chip.hidden = false;
  // Naming the shared init is the visible half of the pairing guarantee.
  const initLabel = esc(formatInitShort(cycleInitIso()));
  chip.innerHTML = storm.isCyclone
    ? `<b>${esc(storm.classification || 'Cyclone')}${storm.category ? ` · Cat ${storm.category}` : ''}</b><span>Fix +${curLead}h · ${storm.max_wind_kt || '—'} kt · ${storm.min_pressure_hpa || '—'} hPa · same init as outage forecast (${initLabel})</span>`
    : `<b>Inland surface low</b><span>Fix +${curLead}h · no ocean radii · same init as outage forecast (${initLabel})</span>`;
}

function drawTail() {
  const regional = S.cycle.meta.regional || {}, joint = regional.p90, independent = regional.p90_if_independent;
  $('tail-joint').querySelector('em').textContent = joint == null ? '—' : compact.format(joint);
  $('tail-independent').querySelector('em').textContent = independent == null ? '—' : compact.format(independent);
  const max = Math.max(joint || 1, independent || 1);
  $('tail-joint').style.setProperty('--w', `${Math.max(8, (joint || 0) / max * 100)}%`);
  $('tail-independent').style.setProperty('--w', `${Math.max(8, (independent || 0) / max * 100)}%`);
  if (regional.tail_understatement_ratio) {
    $('tail-note').textContent = `Independent county summation understates this regional P90 by ${((regional.tail_understatement_ratio - 1) * 100).toFixed(0)}%.`;
  }
}

function drawPriority() {
  const rows = [...S.counties].sort((a, b) => (b.expected_customers_out || 0) - (a.expected_customers_out || 0)).slice(0, 7);
  $('priority-table').innerHTML = rows.map((r) => `
    <tr data-fips="${esc(r.county_fips)}">
      <td>${esc(r.county_name)}<small>${esc(r.state)} · ${esc(r.county_fips)}</small></td>
      <td>${num(r.expected_customers_out)}</td>
      <td>${num(r.p90_customers_out)}</td>
      <td>${fmt(r.prob_outage_fraction_gt_05, 'pct')}</td>
      <td><span class="confidence ${r.product_confidence === 'reduced' ? 'reduced' : ''}">${esc(r.product_confidence || r.data_quality_flag || 'normal')}</span></td>
    </tr>
  `).join('');

  $('priority-table').querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      const fips = tr.dataset.fips;
      const pc = S.projectedCounties.find((c) => c.fips === fips);
      if (pc) focusMapPoint(pc.centroid[0], pc.centroid[1], 2.8);
      openDrawer(fips);
    });
  });
}

function drawSplit() {
  const rows = [...S.counties].filter((r) => r.expected_outage_fraction != null).sort((a, b) => b.expected_outage_fraction - a.expected_outage_fraction).slice(0, 8);
  const max = Math.max(1e-6, ...rows.map((r) => Math.max(r.weather_spread_pp || 0, r.impact_spread_pp || 0)));
  $('split').innerHTML = rows.map((r) => {
    const weather = (r.weather_spread_pp || 0) / max * 100, impact = (r.impact_spread_pp || 0) / max * 100;
    return `
      <div class="srow">
        <span class="nm" title="${esc(r.county_name)}, ${esc(r.state)}">${esc(r.county_name)}</span>
        <span class="bars">
          <i class="bar weather" style="width:${weather.toFixed(1)}%" title="Weather: ${fmt(r.weather_spread_pp, 'pp')}"></i>
          <i class="bar impact" style="width:${impact.toFixed(1)}%" title="Impact: ${fmt(r.impact_spread_pp, 'pp')}"></i>
        </span>
        <span class="total">${fmt(Math.max(r.weather_spread_pp || 0, r.impact_spread_pp || 0), 'pp')}</span>
      </div>
    `;
  }).join('');
}

function drawProvenance() {
  const meta = S.cycle;
  const m = meta.meta || {};
  const validSpan = m.valid_start_utc && m.valid_end_utc ? `${m.valid_start_utc.slice(5, 16).replace('T', ' ')}Z → ${m.valid_end_utc.slice(5, 16).replace('T', ' ')}Z` : null;
  const horizon = m.valid_start_utc && m.valid_end_utc ? `${Math.round((new Date(m.valid_end_utc) - new Date(m.valid_start_utc)) / 36e5)}h` : null;

  const rows = [
    ['Artifact', meta.model_artifact_id],
    ['Hazard', meta.hazard_source],
    ['Provider', m.forecast_provider || meta.provider_status],
    ['Lead / Window', meta.lead_hours != null ? `+${meta.lead_hours}h lead (${horizon || '—'} window)` : '—'],
    ['Valid period', validSpan || '—'],
    ['Training cutoff', (meta.training_data_cutoff_utc || '').slice(0, 10)],
    ['Release gate', meta.release_gate_passed ? 'passed' : 'NOT PASSED'],
    ['Synthetic', meta.synthetic ? 'YES' : 'no'],
    ['Schema', m.schema_version || '—'],
    ['Geography', m.geography_version || '—'],
  ];
  $('prov').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '—')}</dd>`).join('');
}

/* ==========================================================================
   County Detail Drawer
   ========================================================================== */
async function openDrawer(fips) {
  const row = S.byFips.get(String(fips));
  if (!row) return;
  S.selected = String(fips);
  $('d-name').textContent = `${row.county_name}, ${row.state}`;
  $('d-sub').textContent = `FIPS ${row.county_fips} · ${num(row.customers_total)} customers`;
  const extrapolated = row.training_envelope_flag && row.training_envelope_flag !== 'inside';

  $('d-stats').innerHTML =
    stat('Expected out', num(row.expected_customers_out)) +
    stat('P90 out', num(row.p90_customers_out)) +
    stat('Expected fraction', fmt(row.expected_outage_fraction, 'pct')) +
    stat('P(>5%)', fmt(row.prob_outage_fraction_gt_05, 'pct')) +
    stat('Weather spread', fmt(row.weather_spread_pp, 'pp')) +
    stat('Impact spread', fmt(row.impact_spread_pp, 'pp')) +
    stat('Peak gust', fmt(row.peak_gust_ms, 'ms')) +
    stat('Envelope', row.training_envelope_flag || 'inside', extrapolated);

  drawCdf(row);
  $('d-drivers').innerHTML = [
    ['Damaging-wind hours', row.duration_hr != null ? Number(row.duration_hr).toFixed(1) : '—'],
    ['Hazard reference quality', row.hazard_reference_quality],
    ['Data quality', row.data_quality_flag],
    ['Product confidence', row.product_confidence],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '—')}</dd>`).join('');

  $('drawer').dataset.row = JSON.stringify(row);
  $('drawer').hidden = false;
  requestMapRedraw();
}

function stat(label, value, warn = false) {
  return `<div class="stat${warn ? ' warn' : ''}"><b>${esc(value ?? '—')}</b><small>${esc(label)}</small></div>`;
}

function drawCdf(row) {
  const keys = Object.keys(row).filter((k) => /^q\d+_outage_fraction$/.test(k)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  const svg = $('d-cdf');
  if (!keys.length) { svg.innerHTML = ''; return; }
  const points = keys.map((k) => ({ p: parseInt(k.slice(1)) / 100, v: row[k] || 0 }));
  const W = svg.clientWidth || 390, H = 130, pad = 24, maxV = Math.max(...points.map((pt) => pt.v), .01);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const X = (v) => pad + v / maxV * (W - pad * 2);
  const Y = (p) => H - pad - p * (H - pad * 1.6);
  const line = points.map((pt) => `${X(pt.v).toFixed(1)},${Y(pt.p).toFixed(1)}`).join(' ');

  svg.innerHTML = `
    <polyline fill="none" stroke="#38bdf8" stroke-width="2" points="${line}"/>
    ${points.map((pt) => `<circle cx="${X(pt.v)}" cy="${Y(pt.p)}" r="3" fill="#38bdf8"><title>P${pt.p * 100} = ${(pt.v * 100).toFixed(1)}%</title></circle>`).join('')}
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#334155"/>
    <text x="${pad}" y="${H - 7}" font-size="9" fill="#64748b">0%</text>
    <text x="${W - pad}" y="${H - 7}" font-size="9" fill="#64748b" text-anchor="end">${(maxV * 100).toFixed(0)}% customers</text>
  `;
  $('d-cdfnote').textContent = 'Full predictive quantiles allow customized loss-threshold evaluation rather than relying on one headline probability.';
}

function drawCdfIfOpen() {
  if (!$('drawer').hidden && $('drawer').dataset.row) drawCdf(JSON.parse($('drawer').dataset.row));
}

function closeDrawer() {
  $('drawer').hidden = true;
  S.selected = null;
  requestMapRedraw();
}

/* ==========================================================================
   Start Application
   ========================================================================== */
boot().catch((err) => {
  $('event-name').textContent = `Dashboard failed to load: ${err.message}`;
  console.error(err);
});
