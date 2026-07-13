const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let salesData = null;
let origin = null;
let weekendStops = [];
let ongoingStops = [];
let planOrder = []; // sale ids, in the order they were added to the plan
let anchorId = null; // the "main sale" the day is planned around

async function init() {
  const dateInput = document.getElementById('date-input');
  const today = new Date();
  dateInput.value = toISODate(today);
  dateInput.min = toISODate(today);

  try {
    const res = await fetch(`data/sales.json?_=${Date.now()}`);
    salesData = await res.json();
  } catch (err) {
    setStatus('Could not load sales data. Try refreshing.', true);
  }

  attachPlanDragHandlers();
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.className = isError ? 'error' : '';
}

async function findSales() {
  if (!salesData) {
    setStatus('Sales data is still loading, try again in a moment.', true);
    return;
  }
  const dateStr = document.getElementById('date-input').value;
  const zip = document.getElementById('zip-input').value.trim();
  const radiusMiles = Number(document.getElementById('radius-input').value);

  if (!dateStr) {
    setStatus('Pick a date first.', true);
    return;
  }
  if (!/^\d{5}$/.test(zip)) {
    setStatus('Enter a 5-digit zip code.', true);
    return;
  }

  const btn = document.getElementById('plan-btn');
  btn.disabled = true;
  setStatus('Looking up your zip code…');
  document.getElementById('plan-section').style.display = 'none';
  document.getElementById('browse-section').style.display = 'none';

  try {
    origin = await geocodeZip(zip);
  } catch (err) {
    setStatus(`Couldn't find zip ${zip}. Double-check it and try again.`, true);
    btn.disabled = false;
    return;
  }

  const weekday = DAY_ABBR[new Date(dateStr + 'T00:00:00').getDay()];
  const candidates = salesData.sales
    .map(sale => eligibleStop(sale, dateStr, weekday))
    .filter(Boolean)
    .map(stop => ({
      ...stop,
      distanceFromOrigin: haversineMiles(origin, { lat: stop.sale.lat, lng: stop.sale.lng }),
    }))
    .filter(stop => stop.distanceFromOrigin <= radiusMiles)
    .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin);

  weekendStops = candidates.filter(s => !s.isOngoing);
  ongoingStops = candidates.filter(s => s.isOngoing);

  if (!candidates.length) {
    setStatus('');
    document.getElementById('plan-section').style.display = '';
    document.getElementById('plan-empty').textContent =
      'No sales found for that date within range. Try a wider radius or a different day.';
    document.getElementById('plan-results').innerHTML = '';
    btn.disabled = false;
    return;
  }

  planOrder = [];
  anchorId = null;

  setStatus('');
  document.getElementById('plan-section').style.display = '';
  document.getElementById('browse-section').style.display = '';
  renderBrowseLists();
  renderPlan();
  btn.disabled = false;
}

/** Returns null if the sale isn't happening on this date, otherwise a stop descriptor. */
function eligibleStop(sale, dateStr, weekday) {
  const occurrence = (sale.occurrences || []).find(o => o.start <= dateStr && dateStr <= o.end);
  if (occurrence) {
    const hours = occurrence.hours.find(h => h.day === weekday) || null;
    return { sale, occurrence, hours, isOngoing: false, notes: occurrence.notes, headline: occurrence.headline };
  }
  if (sale.ongoing) {
    const hours = sale.ongoing.hours.find(h => h.day === weekday) || null;
    return { sale, occurrence: null, hours, isOngoing: true, notes: sale.ongoing.notes, headline: null };
  }
  return null;
}

function toggleStop(id, checked) {
  if (checked) {
    if (!planOrder.includes(id)) planOrder.push(id);
    // Default the day's "main sale" anchor to the first dated/weekend sale added --
    // that's usually the trip you're planning around; ongoing sales get peppered in around it.
    if (!anchorId) {
      const stop = stopsById().get(id);
      if (stop && !stop.isOngoing) {
        anchorId = id;
        planOrder = planOrder.filter(x => x !== id);
        planOrder.unshift(id);
      }
    }
  } else {
    planOrder = planOrder.filter(x => x !== id);
    if (anchorId === id) anchorId = planOrder.find(pid => !stopsById().get(pid).isOngoing) || null;
  }
  renderPlan();
  // Keep the checked/unchecked visual state of rows in sync without a full re-render.
  document.querySelectorAll(`input[data-sale-id="${id}"]`).forEach(input => {
    input.closest('.pick-row').classList.toggle('checked', checked);
  });
}

function setAnchor(id) {
  anchorId = id;
  planOrder = [id, ...planOrder.filter(x => x !== id)];
  renderPlan();
}

/** The main sale always leads the plan -- pin it to the front before every render. */
function pinAnchorFirst() {
  if (anchorId && planOrder.includes(anchorId)) {
    planOrder = [anchorId, ...planOrder.filter(x => x !== anchorId)];
  }
}

function removeStop(id) {
  document.querySelectorAll(`input[data-sale-id="${id}"]`).forEach(input => { input.checked = false; });
  toggleStop(id, false);
}

/** Drag-to-reorder for plan cards: only the dragged card moves (via a CSS transform);
 *  siblings stay put. On release, the new slot is whichever position the pointer ended up
 *  above, and planOrder is updated to match -- then a normal renderPlan() puts everything
 *  back in place. This avoids fiddly tap-the-arrow-N-times reordering. */
let dragState = null;

function attachPlanDragHandlers() {
  const container = document.getElementById('plan-results');
  container.addEventListener('pointerdown', onDragPointerDown);
}

function onDragPointerDown(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle || handle.dataset.saleId === anchorId) return;
  const card = handle.closest('.stop-card');
  const container = document.getElementById('plan-results');
  const cards = Array.from(container.querySelectorAll('.stop-card'));

  dragState = {
    id: handle.dataset.saleId,
    card,
    others: cards.filter(c => c !== card).map(c => ({
      el: c,
      mid: c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2,
    })),
    startY: e.clientY,
  };
  card.classList.add('dragging');
  card.setPointerCapture(e.pointerId);
  window.addEventListener('pointermove', onDragPointerMove);
  window.addEventListener('pointerup', onDragPointerUp);
  e.preventDefault();
}

function onDragPointerMove(e) {
  if (!dragState) return;
  const dy = e.clientY - dragState.startY;
  dragState.card.style.transform = `translateY(${dy}px)`;
}

function onDragPointerUp(e) {
  if (!dragState) return;
  const pointerY = e.clientY;
  const newIndex = dragState.others.filter(o => o.mid < pointerY).length;

  planOrder = planOrder.filter(x => x !== dragState.id);
  planOrder.splice(newIndex, 0, dragState.id);

  dragState.card.classList.remove('dragging');
  dragState.card.style.transform = '';
  window.removeEventListener('pointermove', onDragPointerMove);
  window.removeEventListener('pointerup', onDragPointerUp);
  dragState = null;
  renderPlan();
}

/** One-click suggestion. The main sale always leads -- from there, every other stop gets
 *  inserted wherever it adds the least extra driving distance on the path back to your zip
 *  code, so smaller/ongoing sales get peppered in on the way home. Falls back to plain
 *  nearest-neighbor if there's no main sale set. */
function suggestRoute() {
  const byId = stopsById();
  const selected = planOrder.map(id => byId.get(id)).filter(Boolean);
  if (selected.length < 2) return;

  const anchor = selected.find(s => s.sale.id === anchorId);
  const ordered = anchor
    ? cheapestInsertionPath(anchor, origin, selected.filter(s => s.sale.id !== anchorId))
    : buildRoute(origin, selected);

  planOrder = ordered.map(s => s.sale.id);
  renderPlan();
}

/** Cheapest-insertion heuristic for an open path: the main sale is pinned first, home
 *  (origin) is the fixed destination, and every remaining stop gets inserted at whichever
 *  point along that path adds the least extra distance -- so it lands on the way out or the
 *  way back, whichever is cheaper, but never ahead of the main sale. */
function cheapestInsertionPath(anchor, origin, others) {
  const originPoint = { lat: origin.lat, lng: origin.lng, isOrigin: true };
  const path = [anchor, originPoint];
  const pointOf = node => node.isOrigin ? node : { lat: node.sale.lat, lng: node.sale.lng };

  const remaining = others.slice();
  while (remaining.length) {
    let bestStopIdx = 0, bestPathIdx = 1, bestCost = Infinity;
    remaining.forEach((stop, stopIdx) => {
      for (let i = 0; i < path.length - 1; i++) {
        const a = pointOf(path[i]);
        const b = pointOf(path[i + 1]);
        const s = pointOf(stop);
        const cost = haversineMiles(a, s) + haversineMiles(s, b) - haversineMiles(a, b);
        if (cost < bestCost) {
          bestCost = cost;
          bestPathIdx = i + 1;
          bestStopIdx = stopIdx;
        }
      }
    });
    path.splice(bestPathIdx, 0, remaining[bestStopIdx]);
    remaining.splice(bestStopIdx, 1);
  }

  return path.slice(0, -1); // drop the origin sentinel at the end; anchor stays at index 0
}

function stopsById() {
  const map = new Map();
  weekendStops.concat(ongoingStops).forEach(s => map.set(s.sale.id, s));
  return map;
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
  document.getElementById('tab-weekend').style.display = name === 'weekend' ? '' : 'none';
  document.getElementById('tab-ongoing').style.display = name === 'ongoing' ? '' : 'none';
}

function renderBrowseLists() {
  document.getElementById('weekend-count').textContent = `(${weekendStops.length})`;
  document.getElementById('ongoing-count').textContent = `(${ongoingStops.length})`;
  document.getElementById('tab-weekend').innerHTML = weekendStops.map(pickRowHTML).join('') ||
    '<div class="empty-state">No dated sales found in range for this date.</div>';
  document.getElementById('tab-ongoing').innerHTML = ongoingStops.map(pickRowHTML).join('') ||
    '<div class="empty-state">No ongoing sales found in range.</div>';
}

function pickRowHTML(stop) {
  const sale = stop.sale;
  const title = stop.headline || sale.venue || sale.city;
  const checked = planOrder.includes(sale.id);
  const badge = stop.isOngoing
    ? '<span class="badge ongoing">Ongoing</span>'
    : `<span class="badge dated">${formatDateRange(stop.occurrence.start, stop.occurrence.end)}</span>`;
  const hoursText = stop.hours ? stop.hours.raw : (stop.isOngoing ? 'check hours' : 'hours vary');

  return `
    <label class="pick-row ${checked ? 'checked' : ''}">
      <input type="checkbox" data-sale-id="${sale.id}" ${checked ? 'checked' : ''}
        onchange="toggleStop('${sale.id}', this.checked)">
      <div class="pick-main">
        <div class="pick-title">${escapeHTML(title)} ${badge}</div>
        <div class="pick-sub">${escapeHTML(sale.city)} · ${stop.distanceFromOrigin.toFixed(1)} mi · ${escapeHTML(hoursText)}</div>
      </div>
    </label>
  `;
}

function formatDateRange(startISO, endISO) {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  if (startISO === endISO) return `${MONTH_ABBR[sm - 1]} ${sd}`;
  if (sm === em) return `${MONTH_ABBR[sm - 1]} ${sd}–${ed}`;
  return `${MONTH_ABBR[sm - 1]} ${sd}–${MONTH_ABBR[em - 1]} ${ed}`;
}

function renderPlan() {
  pinAnchorFirst();
  const byId = stopsById();
  const selected = planOrder.map(id => byId.get(id)).filter(Boolean);
  const emptyEl = document.getElementById('plan-empty');
  const resultsEl = document.getElementById('plan-results');
  const suggestBtn = document.getElementById('suggest-btn');
  const mapsBtn = document.getElementById('maps-btn');

  if (!selected.length) {
    emptyEl.style.display = '';
    emptyEl.textContent = 'Check off sales below to add them to your plan.';
    resultsEl.innerHTML = '';
    suggestBtn.style.display = 'none';
    mapsBtn.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  suggestBtn.style.display = (anchorId || selected.length > 1) ? '' : 'none';
  mapsBtn.style.display = '';
  mapsBtn.href = googleMapsUrl(selected);

  // Plan order follows the order stops were added (or manually rearranged) --
  // just annotate each stop with the straight-line distance from whatever came before it.
  let current = origin;
  const annotated = selected.map(stop => {
    const distance = haversineMiles(current, { lat: stop.sale.lat, lng: stop.sale.lng });
    current = { lat: stop.sale.lat, lng: stop.sale.lng };
    return { ...stop, distanceFromPrev: distance };
  });

  resultsEl.innerHTML = annotated.map((stop, i) =>
    stopCardHTML(stop, i + 1)).join('');
}

/** Builds a Google Maps multi-stop directions link following the current plan order. */
function googleMapsUrl(selected) {
  const addressOf = stop => `${stop.sale.address || ''} ${stop.sale.city} CA`;
  const originParam = encodeURIComponent(`${origin.lat},${origin.lng}`);
  const destination = encodeURIComponent(addressOf(selected[selected.length - 1]));
  const waypoints = selected.slice(0, -1).map(s => encodeURIComponent(addressOf(s))).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${originParam}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  return url;
}

/** Greedy nearest-neighbor from origin, straight-line distance only -- used by the
 *  "Sort by distance" suggestion, not applied automatically. */
function buildRoute(origin, candidates) {
  const remaining = candidates.slice();
  const route = [];
  let current = origin;

  while (remaining.length) {
    remaining.sort((a, b) =>
      haversineMiles(current, { lat: a.sale.lat, lng: a.sale.lng }) -
      haversineMiles(current, { lat: b.sale.lat, lng: b.sale.lng }));
    const next = remaining.shift();
    const distance = haversineMiles(current, { lat: next.sale.lat, lng: next.sale.lng });

    route.push({ ...next, distanceFromPrev: distance });
    current = { lat: next.sale.lat, lng: next.sale.lng };
  }
  return route;
}

function haversineMiles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function toRad(deg) { return (deg * Math.PI) / 180; }

async function geocodeZip(zip) {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!res.ok) throw new Error('zip not found');
  const data = await res.json();
  const place = data.places[0];
  return { lat: Number(place.latitude), lng: Number(place.longitude) };
}

function stopCardHTML(stop, order) {
  const sale = stop.sale;
  const title = stop.headline || sale.venue || sale.city;
  const mapsQuery = encodeURIComponent(`${sale.address || ''} ${sale.city} CA`);
  const isAnchor = sale.id === anchorId;
  const tags = [];

  if (isAnchor) {
    tags.push(`<span class="tag anchor">★ Main sale</span>`);
  }
  tags.push(stop.isOngoing
    ? `<span class="tag ongoing">Ongoing</span>`
    : `<span class="tag dated">${formatDateRange(stop.occurrence.start, stop.occurrence.end)}</span>`);

  if (stop.hours) {
    tags.push(`<span class="tag hours">${stop.hours.raw}</span>`);
  } else {
    tags.push(`<span class="tag">hours not listed for this day — check ahead</span>`);
  }

  if (order > 1) {
    tags.push(`<span class="tag drive">${stop.distanceFromPrev.toFixed(1)} mi from last stop</span>`);
  } else {
    tags.push(`<span class="tag drive">${stop.distanceFromOrigin.toFixed(1)} mi from start</span>`);
  }

  const notes = (stop.notes || []).filter(Boolean);
  const notesHTML = notes.length
    ? `<div class="stop-notes"><ul>${notes.map(n => `<li>${escapeHTML(n)}</li>`).join('')}</ul></div>`
    : '';

  return `
    <div class="stop-card ${stop.isOngoing ? 'ongoing-only' : ''} ${isAnchor ? 'is-anchor' : ''}">
      <div class="stop-head">
        <div class="stop-order">${order}</div>
        <div class="stop-head-main">
          <div class="stop-title">${escapeHTML(title)}</div>
          <div class="stop-city">${escapeHTML(sale.city)}</div>
        </div>
        <button type="button" class="anchor-btn ${isAnchor ? 'active' : ''}" onclick="setAnchor('${sale.id}')"
          aria-label="Make this the main sale you're planning around" title="Plan the day around this sale">★</button>
        <button type="button" class="remove-btn" onclick="removeStop('${sale.id}')" aria-label="Remove from plan">✕</button>
        ${isAnchor ? '' : `
        <button type="button" class="drag-handle" data-sale-id="${sale.id}" aria-label="Drag to reorder">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
            <circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
            <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
          </svg>
        </button>`}
      </div>
      <div class="stop-address">
        <a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener">${escapeHTML(sale.address || sale.city)}</a>
        ${sale.phone ? ` · <a href="tel:${sale.phone.replace(/[^\d+]/g, '')}">${escapeHTML(sale.phone)}</a>` : ''}
      </div>
      <div class="stop-meta">${tags.join('')}</div>
      ${notesHTML}
    </div>
  `;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
