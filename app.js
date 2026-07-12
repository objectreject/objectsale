const AVG_SPEED_MPH = 25; // straight-line-distance travel estimate, not real routing
const MIN_STOP_MINUTES = 30; // assumed browsing time per stop
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let salesData = null;

async function init() {
  const dateInput = document.getElementById('date-input');
  const today = new Date();
  dateInput.value = toISODate(today);
  dateInput.min = toISODate(today);

  try {
    const res = await fetch(`data/sales.json?_=${Date.now()}`);
    salesData = await res.json();
    document.getElementById('data-age').textContent = `data as of ${salesData.scrapedAt}`;
  } catch (err) {
    document.getElementById('data-age').textContent = 'data unavailable';
    setStatus('Could not load sales data. Try refreshing.', true);
  }
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.className = isError ? 'error' : '';
}

async function planDay() {
  if (!salesData) {
    setStatus('Sales data is still loading, try again in a moment.', true);
    return;
  }
  const dateStr = document.getElementById('date-input').value;
  const zip = document.getElementById('zip-input').value.trim();
  const startTime = document.getElementById('time-input').value || '09:00';
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
  document.getElementById('results').innerHTML = '';

  let origin;
  try {
    origin = await geocodeZip(zip);
  } catch (err) {
    setStatus(`Couldn't find zip ${zip}. Double-check it and try again.`, true);
    btn.disabled = false;
    return;
  }

  setStatus('Building your route…');

  const weekday = DAY_ABBR[new Date(dateStr + 'T00:00:00').getDay()];
  const candidates = salesData.sales
    .map(sale => eligibleStop(sale, dateStr, weekday))
    .filter(Boolean)
    .map(stop => ({
      ...stop,
      distanceFromOrigin: haversineMiles(origin, { lat: stop.sale.lat, lng: stop.sale.lng }),
    }))
    .filter(stop => stop.distanceFromOrigin <= radiusMiles);

  if (!candidates.length) {
    setStatus('');
    document.getElementById('results').innerHTML =
      '<div class="empty-state">No sales found for that date within range. Try a wider radius or a different day.</div>';
    btn.disabled = false;
    return;
  }

  const ordered = buildRoute(origin, candidates, startTime);
  renderResults(ordered);
  setStatus('');
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

/** Greedy nearest-neighbor from origin, skipping stops whose close time has already passed
 *  given today's date, and flagging stops we likely can't reach before closing. */
function buildRoute(origin, candidates, startTime) {
  const remaining = candidates.slice();
  const route = [];
  let current = origin;
  let clockMinutes = timeToMinutes(startTime);

  while (remaining.length) {
    remaining.sort((a, b) =>
      haversineMiles(current, { lat: a.sale.lat, lng: a.sale.lng }) -
      haversineMiles(current, { lat: b.sale.lat, lng: b.sale.lng }));
    const next = remaining.shift();
    const distance = haversineMiles(current, { lat: next.sale.lat, lng: next.sale.lng });
    const travelMinutes = Math.max(10, (distance / AVG_SPEED_MPH) * 60);
    const arrival = clockMinutes + travelMinutes;

    let warn = false;
    if (next.hours && next.hours.close) {
      const closeMinutes = timeToMinutes(next.hours.close);
      if (arrival > closeMinutes) warn = true;
    }

    route.push({ ...next, distanceFromPrev: distance, travelMinutes, arrivalMinutes: arrival, warn });

    clockMinutes = arrival + MIN_STOP_MINUTES;
    current = { lat: next.sale.lat, lng: next.sale.lng };
  }
  return route;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToClock(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
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

function renderResults(route) {
  const container = document.getElementById('results');
  container.innerHTML = route.map((stop, i) => stopCardHTML(stop, i + 1)).join('');
}

function stopCardHTML(stop, order) {
  const sale = stop.sale;
  const title = stop.headline || sale.venue || sale.city;
  const mapsQuery = encodeURIComponent(`${sale.address || ''} ${sale.city} CA`);
  const tags = [];

  if (stop.hours) {
    tags.push(`<span class="tag hours">${stop.hours.raw}</span>`);
  } else if (stop.isOngoing) {
    tags.push(`<span class="tag ongoing">Ongoing — check hours</span>`);
  } else {
    tags.push(`<span class="tag ongoing">Hours not listed for ${DAY_ABBR[new Date().getDay()]}</span>`);
  }

  if (order > 1) {
    tags.push(`<span class="tag drive">${stop.distanceFromPrev.toFixed(1)} mi / ~${Math.round(stop.travelMinutes)} min from last stop</span>`);
  } else {
    tags.push(`<span class="tag drive">${stop.distanceFromOrigin.toFixed(1)} mi from start</span>`);
  }

  tags.push(`<span class="tag">arrive ~${minutesToClock(stop.arrivalMinutes)}</span>`);

  if (stop.warn) {
    tags.push(`<span class="tag warn">may be closed by the time you arrive</span>`);
  }

  const notes = (stop.notes || []).filter(Boolean);
  const notesHTML = notes.length
    ? `<div class="stop-notes"><ul>${notes.map(n => `<li>${escapeHTML(n)}</li>`).join('')}</ul></div>`
    : '';

  return `
    <div class="stop-card ${stop.isOngoing ? 'ongoing-only' : ''} ${stop.warn ? 'warn' : ''}">
      <div class="stop-head">
        <div class="stop-order">${order}</div>
        <div>
          <div class="stop-title">${escapeHTML(title)}</div>
          <div class="stop-city">${escapeHTML(sale.city)}</div>
        </div>
      </div>
      <div class="stop-address">
        <a href="https://maps.apple.com/?q=${mapsQuery}" target="_blank" rel="noopener">${escapeHTML(sale.address || sale.city)}</a>
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
