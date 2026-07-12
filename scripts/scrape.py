#!/usr/bin/env python3
"""Scrapes booksalefinder.com's Southern California page into data/sales.json.

The source page has two relevant parts:
  1. Compact monthly calendar tables ("Upcoming Sales" + "Future Sales") --
     rows like <td>17-18</td><td><a href="#X1391">City</a></td><td>tag</td>,
     grouped under month/year header rows. This is the authoritative source
     of *when* each sale happens (the source doesn't repeat the year anywhere
     else).
  2. A detail table keyed by the same anchor ids -- venue name, address,
     phone, and freeform hours/notes text. Some ids belong to sponsored
     placements where the anchor sits in its own marker row and the real
     content is the next sibling row.

We merge the two into one record per anchor id, then geocode addresses
(caching known ones) and filter to Southern California.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
from datetime import date

from bs4 import BeautifulSoup

SOURCE_URL = "https://www.booksalefinder.com/CAS.html"
USER_AGENT = "objectsale scraper (personal/non-commercial schedule tool; contact via github.com/objectreject)"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data", "sales.json")
GEOCODE_CACHE_PATH = os.path.join(ROOT, "data", "geocode-cache.json")

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
MONTH_HEADER_RE = re.compile(r"^([A-Za-z]+),?\s+(\d{4})$")
WEEKDAY_RE = re.compile(
    r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+"
    r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)",
    re.IGNORECASE,
)

# Southern California bounding box (rough) -- used to drop cross-posted
# sponsor entries from other regions (NorCal, out of state, etc).
SOCAL_BOUNDS = {"lat_min": 32.4, "lat_max": 35.9, "lng_min": -121.0, "lng_max": -114.1}


def fetch_html():
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_day_range(text, month, year):
    """Parse a compact calendar cell like '17-18', '31-8/2', '17', '?'."""
    text = text.strip()
    if not text or text == "?":
        return None
    m = re.match(r"^(\d{1,2})-(\d{1,2})/(\d{1,2})$", text)
    if m:
        start_day, end_month, end_day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        start = safe_date(year, month, start_day)
        end_year = year if end_month >= month else year + 1
        end = safe_date(end_year, end_month, end_day)
        return (start, end)
    m = re.match(r"^(\d{1,2})-(\d{1,2})$", text)
    if m:
        start_day, end_day = int(m.group(1)), int(m.group(2))
        return (safe_date(year, month, start_day), safe_date(year, month, end_day))
    m = re.match(r"^(\d{1,2})$", text)
    if m:
        d = safe_date(year, month, int(m.group(1)))
        return (d, d)
    return None


def safe_date(year, month, day):
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_compact_calendar(soup, scrape_date):
    """Returns {anchor_id: [(start_iso, end_iso, headline), ...]}."""
    occurrences = {}
    month, year = scrape_date.month, scrape_date.year
    last_month_num = month
    for tr in soup.find_all("tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) == 1 and tds[0].get("colspan"):
            header_text = tds[0].get_text(strip=True)
            m = MONTH_HEADER_RE.match(header_text)
            if m:
                mon_num = MONTHS.get(m.group(1)[:3].lower())
                if mon_num:
                    month, year = mon_num, int(m.group(2))
                    last_month_num = mon_num
            continue
        if len(tds) != 3:
            continue
        link = tds[1].find("a", href=re.compile(r"^#X\d+$"))
        if not link:
            continue
        anchor_id = link["href"].lstrip("#")
        day_text = tds[0].get_text(strip=True)
        headline = tds[2].get_text(strip=True)
        rng = parse_day_range(day_text, month, year)
        if rng and rng[0] and rng[1]:
            occurrences.setdefault(anchor_id, []).append((rng[0], rng[1], headline or None))
    return occurrences


def clean_text(s):
    return re.sub(r"\s+", " ", s or "").strip()


def parse_hours_lines(ul):
    """Best-effort: pull weekday open/close pairs plus keep raw notes."""
    if ul is None:
        return [], []
    hours = []
    notes = []
    for li in ul.find_all("li", recursive=False):
        raw = clean_text(li.get_text(" "))
        if not raw:
            continue
        found_any = False
        for part in raw.split(","):
            m = WEEKDAY_RE.search(part)
            if m:
                found_any = True
                day, open_raw, close_raw = m.group(1)[:3].capitalize(), m.group(2), m.group(3)
                parsed = to_24h_pair(open_raw, close_raw)
                if parsed:
                    hours.append({"day": day, "open": parsed[0], "close": parsed[1], "raw": clean_text(part)})
        if not found_any:
            notes.append(raw)
        else:
            # keep the segment text as a note too when it has more than hours (e.g. "Preview: ...")
            pass
    return hours, notes


def to_24h_pair(open_raw, close_raw):
    def parse_one(raw, default_meridiem=None):
        raw = raw.strip().lower().replace(" ", "")
        m = re.match(r"^(\d{1,2})(?::(\d{2}))?(am|pm)?$", raw)
        if not m:
            return None
        h = int(m.group(1))
        mins = int(m.group(2) or 0)
        mer = m.group(3) or default_meridiem
        return h, mins, mer

    o = parse_one(open_raw)
    c = parse_one(close_raw)
    if not o or not c:
        return None
    oh, om, omer = o
    ch, cm, cmer = c
    # Heuristic: sale hours are always daytime. If no am/pm given, assume the
    # open hour is AM (9-11ish) and the close hour is PM, unless explicitly marked.
    if omer is None:
        omer = "am" if oh != 12 else "pm"
    if cmer is None:
        cmer = "pm" if ch != 12 else "am"
    oh24 = oh_24(oh, omer)
    ch24 = oh_24(ch, cmer)
    if ch24 <= oh24:
        ch24 = min(ch24 + 12, 23)
    return (f"{oh24:02d}:{om:02d}", f"{ch24:02d}:{cm:02d}")


def oh_24(h, meridiem):
    h = h % 12
    return h + 12 if meridiem == "pm" else h


def parse_detail_blob(td):
    """Split a detail right-column cell into (summary_text, dated_hours, dated_notes, ongoing_hours, ongoing_notes)."""
    html = str(td)
    parts = re.split(r"<hr\s*/?>", html, flags=re.IGNORECASE)
    dated_html = parts[0]
    ongoing_html = parts[1] if len(parts) > 1 else ""

    dated_soup = BeautifulSoup(dated_html, "lxml")
    summary = clean_text(dated_soup.find("td").find(string=True, recursive=False) or "") if dated_soup.find("td") else ""
    if not summary:
        # first text node before the first <ul>/<br>
        first_ul = dated_soup.find("ul")
        summary = clean_text(dated_soup.get_text(" ").split("\n")[0]) if not first_ul else ""
    dated_hours, dated_notes = parse_hours_lines(dated_soup.find("ul"))

    ongoing_soup = BeautifulSoup(ongoing_html, "lxml")
    ongoing_hours, ongoing_notes = parse_hours_lines(ongoing_soup.find("ul"))

    return summary, dated_hours, dated_notes, ongoing_hours, ongoing_notes


PHONE_RE = re.compile(r"^[\d\s()+.-]{7,}$")
ADDRESS_RE = re.compile(r"^\d{1,6}\s+\S|^P\.?O\.?\s*Box\b", re.IGNORECASE)


def parse_venue_block(td):
    """Extract venue name, address, phone from the left <td> of a detail row."""
    p = td.find("p")
    container = p if p else td
    # Drop the "edit this listing" pencil link and promo headline banners.
    for a in container.find_all("a", href=re.compile(r"sendedit\.php")):
        a.decompose()
    for span in container.find_all("span", class_=re.compile(r"xdtext")):
        span.decompose()

    city_state = clean_text(td.find("b").get_text()) if td.find("b") else ""
    city, _, state = city_state.partition(",")
    city, state = clean_text(city), clean_text(state)

    # Walk contents split on <br> to get venue / address / phone lines.
    lines = []
    current = []
    for node in container.contents:
        name = getattr(node, "name", None)
        if name == "br":
            if current:
                lines.append(clean_text("".join(current)))
                current = []
        elif name == "b":
            continue  # already used as city/state
        else:
            current.append(node.get_text() if hasattr(node, "get_text") else str(node))
    if current:
        lines.append(clean_text("".join(current)))
    lines = [l for l in lines if l]

    phone = None
    address_lines = []
    info_lines = []
    for line in lines:
        if PHONE_RE.match(line):
            phone = line
        elif ADDRESS_RE.match(line):
            address_lines.append(line)
        else:
            info_lines.append(line)
    venue = " — ".join(info_lines) or None
    address = ", ".join(address_lines) or None
    return city, state, venue, address, phone


def find_detail_rows(soup):
    """Yield (anchor_id, detail_tr) pairs, following the sponsor marker-row indirection."""
    for a in soup.find_all("a", attrs={"name": re.compile(r"^X\d+$")}):
        anchor_id = a["name"]
        tr = a.find_parent("tr")
        if tr is None:
            continue
        first_td = tr.find(["td", "th"])
        if first_td and first_td.find("b"):
            yield anchor_id, tr
        else:
            nxt = tr.find_next_sibling("tr")
            if nxt and nxt.find("b"):
                yield anchor_id, nxt


def geocode(address_full, cache, session_delay=1.1):
    if address_full in cache:
        return cache[address_full]
    query = urllib.parse.urlencode({"q": address_full, "format": "json", "limit": 1})
    url = f"https://nominatim.openstreetmap.org/search?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            results = json.loads(resp.read().decode("utf-8"))
        time.sleep(session_delay)
        if results:
            coord = {"lat": float(results[0]["lat"]), "lng": float(results[0]["lon"])}
            cache[address_full] = coord
            return coord
    except Exception as exc:
        print(f"  geocode failed for {address_full!r}: {exc}", file=sys.stderr)
    cache[address_full] = None
    return None


def in_socal(coord):
    if not coord:
        return False
    return (
        SOCAL_BOUNDS["lat_min"] <= coord["lat"] <= SOCAL_BOUNDS["lat_max"]
        and SOCAL_BOUNDS["lng_min"] <= coord["lng"] <= SOCAL_BOUNDS["lng_max"]
    )


def main():
    scrape_date = date.today()
    print(f"Fetching {SOURCE_URL} ...")
    html = fetch_html()
    soup = BeautifulSoup(html, "lxml")

    print("Parsing compact calendar for occurrence dates ...")
    occurrences = parse_compact_calendar(soup, scrape_date)

    try:
        with open(GEOCODE_CACHE_PATH) as f:
            geocode_cache = json.load(f)
    except FileNotFoundError:
        geocode_cache = {}

    sales = []
    seen_ids = set()
    for anchor_id, tr in find_detail_rows(soup):
        if anchor_id in seen_ids:
            continue
        seen_ids.add(anchor_id)
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        left_td, right_td = tds[0], tds[1]

        city, state, venue, address, phone = parse_venue_block(left_td)
        if not city or state != "CA":
            continue

        summary, dated_hours, dated_notes, ongoing_hours, ongoing_notes = parse_detail_blob(right_td)
        occ = occurrences.get(anchor_id, [])
        if not occ and not ongoing_hours and not ongoing_notes:
            continue  # nothing schedulable

        full_address = f"{address}, {city}, CA" if address else f"{city}, CA"
        coord = geocode(full_address, geocode_cache)
        if not in_socal(coord):
            continue

        sales.append({
            "id": anchor_id,
            "city": city,
            "venue": venue,
            "address": address,
            "phone": phone,
            "lat": coord["lat"],
            "lng": coord["lng"],
            "occurrences": [
                {"start": s, "end": e, "headline": h, "hours": dated_hours, "notes": dated_notes}
                for s, e, h in occ
            ],
            "ongoing": (
                {"hours": ongoing_hours, "notes": ongoing_notes}
                if (ongoing_hours or ongoing_notes) else None
            ),
        })
        print(f"  parsed {city} ({anchor_id}) -- {len(occ)} occurrence(s), ongoing={bool(ongoing_hours or ongoing_notes)}")

    os.makedirs(os.path.dirname(GEOCODE_CACHE_PATH), exist_ok=True)
    with open(GEOCODE_CACHE_PATH, "w") as f:
        json.dump(geocode_cache, f, indent=2, sort_keys=True)

    output = {
        "scrapedAt": scrape_date.isoformat(),
        "source": SOURCE_URL,
        "sales": sales,
    }
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(sales)} sales to {DATA_PATH}")


if __name__ == "__main__":
    main()
