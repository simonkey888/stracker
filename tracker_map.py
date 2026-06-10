#!/usr/bin/env python3
"""
Tracker Map v5 — ARCHITECTURE REAL CLEAN SPLIT (PALANTIR STYLE)
Pipeline: raw -> build_state(raw, prev_state) -> state -> render(state)

3 LAYERS:
  [LAYER 1] RAW INGESTION — RPC / Google / Device signals
  [LAYER 2] STATE ENGINE — deterministic + probabilistic fusion
  [LAYER 3] UI RENDERER — dumb visualizer, 0 logic

STATE v5 CANONICAL CONTRACT:
  meta:        timestamp, device_id, version
  location:    lat, lng, label_primary, since_sec, distance_to_home_m
  movement:    speed_kmh (0 if STATIC), mode, confidence
  activity:    score, level, screen_state
  network:     type, signal_quality
  device:      battery, charging
  spoof:       risk, label
  proximity:   arrival, mode, distance_m
  ghostrail:   enabled, points_24h, last_zones, timeline_active
  events:      [{type, msg, ts}]

Rules:
  - SINGLE SOURCE OF TRUTH = STATE OBJECT
  - ONE PLACE RULE: label_primary is the ONLY place field rendered in UI
  - UI PRIORITY STACK: Location > Movement > Activity > Network/GPS
  - frontend = render(state) ONLY (ZERO logic, ZERO calculations)
  - backend = inferencia + scoring + eventos
  - NO ghost speed (variance < 0.15 → speed=0)
  - NO duplicate labels (DEDUPE: skip if same as last render)
  - NO double percent %%
  - NO N/A in UI
"""

import csv
import errno
import json
import logging
import math
import os
import re
import signal
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ------------------------------------------------------------
# CONFIGURACION
# ------------------------------------------------------------
try:
    BASE_DIR = Path(__file__).resolve().parent
except NameError:
    BASE_DIR = Path(r"C:\Users\Simon\tracker")
PROFILE_DIR = BASE_DIR / "playwright_profile"
COOKIES_PATH = BASE_DIR / "cookies.json"
CSV_PATH = BASE_DIR / "historial.csv"
HTML_PATH = BASE_DIR / "mapa.html"
LOG_PATH = BASE_DIR / "tracker.log"

GMAPS_SHARE_URL = (
    "https://www.google.com/maps/@-31.6469679,-60.7161333,21z"
    "/data=!4m2!7m1!2e1?hl=es&entry=ttu&g_ep=EgoyMDI6MDUyMC4wIKXMDSoASAFQAw%3D%3D"
)

POLL_INTERVAL = 20
MAX_RETRIES = 3
RETRY_DELAY = 5
DUPLICATE_MIN_METERS = 5
RELOAD_EVERY_N_POLLS = 6
HTTP_PORT = int(os.environ.get("PORT", 8765))
HTTP_PORT_FALLBACKS = [HTTP_PORT, 8765, 8766, 8767, 8768, 8769, 8770]
OPEN_BROWSER = True
FORCE_CHROME = True
COORD_RE = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")

SKIP_PLAYWRIGHT = os.environ.get("TRACKER_SKIP_PLAYWRIGHT", "0") == "1"

# ---- API endpoint (no Playwright) ----
LOCATIONSHARING_URL = (
    "https://www.google.com/maps/rpc/locationsharing/read"
    "?authuser=0&hl=es&gl=ar&pb="
)
COORD_API_RE = re.compile(
    r"\[null,(-(?:5[3-9]|6\d|7[0-3])\.\d+),(-(?:2[1-9]|[3-4]\d|5[0-5])\.\d+)\]"
)
BAT_API_RE = re.compile(r'\[0,(\d{1,3})\],3,null,\[1\]')
CHARGE_RE = re.compile(r'\[0,\d{1,3}\]\s*,\s*(\d)\s*,')
ACCURACY_RE = re.compile(r'\]\s*,\s*\d{13}\s*,\s*(\d+)\s*,\s*"')

GPS_NOISE_THRESHOLD = 20

# ---- Zonas de geofencing ----
HOME_ZONE_CENTER = (-31.64693, -60.71598)
HOME_ZONE_RADIUS_M = 150
WORK_ZONE_CENTER = (-31.6366, -60.7012)
WORK_ZONE_RADIUS_M = 150
USER_HOME_CENTER = (-31.643, -60.714)
USER_HOME_RADIUS_M = 200

# ---- POI System (priority order) ----
POI_LIST = [
    {"id": "home", "name": "Casa", "lat": HOME_ZONE_CENTER[0], "lng": HOME_ZONE_CENTER[1], "radius": HOME_ZONE_RADIUS_M},
    {"id": "work", "name": "Trabajo", "lat": WORK_ZONE_CENTER[0], "lng": WORK_ZONE_CENTER[1], "radius": WORK_ZONE_RADIUS_M},
]

# ---- Proximity targets ----
PROXIMITY_TARGETS = [
    {"name": "Casa", "lat": HOME_ZONE_CENTER[0], "lng": HOME_ZONE_CENTER[1]},
    {"name": "Trabajo", "lat": WORK_ZONE_CENTER[0], "lng": WORK_ZONE_CENTER[1]},
]

HEADING_NAMES = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

# ---- Motion classification v5 thresholds (SIMPLIFIED) ----
MOTION_STATIC_MAX = 2        # km/h — below this = STATIC
MOTION_WALK_MAX = 7          # km/h
MOTION_CAR_MAX = 40          # km/h — above = BUS
MOTION_EMA_ALPHA = 0.7       # EMA smoothing factor
MOTION_VARIANCE_THRESHOLD = 0.15  # Ghost speed threshold

# ---- Anti-spoof Bayesian v5 weights ----
SPOOF_WEIGHT_VELOCITY = 30
SPOOF_WEIGHT_JITTER = 20
SPOOF_WEIGHT_NETWORK = 15
SPOOF_WEIGHT_ZONE_JUMP = 15
SPOOF_WEIGHT_ACCEL = 15
SPOOF_WEIGHT_PATTERN = 5
SPOOF_HIGH_RISK_THRESHOLD = 70
SPOOF_SUSPICIOUS_THRESHOLD = 40

# ---- Events FIFO ----
MAX_EVENTS = 5

# ---- Screen state ----
SCREEN_ON_THRESHOLD_S = 30

# ---- Arrival thresholds ----
ARRIVAL_CAR_APPROACH_M = 300
ARRIVAL_CAR_CLOSE_M = 200
ARRIVAL_WALK_APPROACH_M = 200

# ---- Nominatim cache ----
_NOMINATIM_CACHE = {}


# ------------------------------------------------------------
# LOGGING
# ------------------------------------------------------------
logger = logging.getLogger("tracker")


def setup_logging():
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.handlers.clear()
    logger.addHandler(fh)
    if sys.stdout is not None and hasattr(sys.stdout, "write"):
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        logger.addHandler(sh)


# ------------------------------------------------------------
# GEOMETRIA Y TELEMETRIA
# ------------------------------------------------------------
def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing(lat1, lng1, lat2, lng2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lng2 - lng1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def heading_name(deg):
    idx = round(deg / 22.5) % 16
    return HEADING_NAMES[idx]


def classify_speed(speed_kmh):
    if speed_kmh < 1.0:
        return "detenido"
    elif speed_kmh < 10.0:
        return "lento"
    return "rapido"


# ------------------------------------------------------------
# CSV HISTORIAL
# ------------------------------------------------------------
CSV_HEADERS = ["timestamp", "lat", "lng", "speed_kmh", "heading", "movement_state", "address", "accuracy"]


def init_csv():
    if not CSV_PATH.exists():
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(CSV_HEADERS)
        logger.info("CSV creado: %s", CSV_PATH)


def clean_old_points():
    """Elimina del CSV los puntos previos a la fecha actual (UTC)."""
    if not CSV_PATH.exists():
        return
    today = datetime.now(timezone.utc).date()
    rows = []
    try:
        with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                ts = row.get("timestamp", "")
                try:
                    row_dt = datetime.fromisoformat(ts)
                except Exception:
                    continue
                if row_dt.date() == today:
                    rows.append(row)
    except Exception as e:
        logger.warning("Error limpiando CSV antiguo: %s", e)
        return
    try:
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
            writer.writeheader()
            writer.writerows(rows)
        logger.info("CSV limpio: se conservaron %d puntos de hoy", len(rows))
    except Exception as e:
        logger.warning("No se pudo reescribir CSV tras limpieza: %s", e)


def read_last_row():
    try:
        with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if rows:
            return rows[-1]
    except Exception:
        pass
    return None


def is_duplicate(lat, lng):
    last = read_last_row()
    if last is not None:
        try:
            last_lat = float(last["lat"])
            last_lng = float(last["lng"])
            d = haversine_m(last_lat, last_lng, lat, lng)
            if d < DUPLICATE_MIN_METERS:
                logger.debug("Duplicado (%.1f m < %d m)", d, DUPLICATE_MIN_METERS)
                return True
        except (ValueError, KeyError):
            pass
    return False


def compute_telemetry(lat, lng, timestamp):
    last = read_last_row()
    if last is not None:
        try:
            last_lat = float(last["lat"])
            last_lng = float(last["lng"])
            last_ts = datetime.fromisoformat(last["timestamp"])
            delta_s = (timestamp - last_ts).total_seconds()
            dist_m = haversine_m(last_lat, last_lng, lat, lng)
            if delta_s > 0 and dist_m > GPS_NOISE_THRESHOLD:
                speed_kmh = dist_m * 3.6 / delta_s
            else:
                speed_kmh = 0.0
            hdg = bearing(last_lat, last_lng, lat, lng)
            state = classify_speed(speed_kmh)
            return speed_kmh, hdg, state
        except (ValueError, KeyError, TypeError):
            pass
    return 0.0, 0.0, "detenido"


def is_in_work_zone(lat, lng):
    if lat is None or lng is None:
        return False
    return haversine_m(WORK_ZONE_CENTER[0], WORK_ZONE_CENTER[1], lat, lng) <= WORK_ZONE_RADIUS_M


def is_in_home_zone(lat, lng):
    if lat is None or lng is None:
        return False
    return haversine_m(HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1], lat, lng) <= HOME_ZONE_RADIUS_M


def is_in_user_home_zone(lat, lng):
    if lat is None or lng is None:
        return False
    return haversine_m(USER_HOME_CENTER[0], USER_HOME_CENTER[1], lat, lng) <= USER_HOME_RADIUS_M


def append_csv(timestamp, lat, lng, speed_kmh=0.0, heading=0.0, movement_state="detenido", address="", accuracy=0):
    with open(CSV_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            timestamp.isoformat(), f"{lat:.7f}", f"{lng:.7f}",
            f"{speed_kmh:.2f}", f"{heading:.1f}", movement_state,
            address, accuracy,
        ])
    logger.info(
        "Registrado: %.6f, %.6f | vel=%.1f km/h | rumbo=%s | %s",
        lat, lng, speed_kmh, heading_name(heading), timestamp.isoformat(),
    )


def read_all_points():
    points = []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    try:
        with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    ts = row["timestamp"]
                    row_dt = datetime.fromisoformat(ts)
                    if row_dt < cutoff:
                        continue
                    points.append({
                        "timestamp": ts,
                        "lat": float(row["lat"]),
                        "lng": float(row["lng"]),
                        "speed_kmh": float(row.get("speed_kmh", 0)),
                        "heading": float(row.get("heading", 0)),
                        "movement_state": row.get("movement_state", "detenido"),
                        "address": row.get("address", ""),
                        "accuracy": int(row.get("accuracy", 0)),
                    })
                except (ValueError, KeyError):
                    continue
    except Exception as e:
        logger.error("Error leyendo CSV: %s", e)
    return points


def compute_stats(points):
    if not points:
        return {
            "total_distance_km": 0, "max_speed_kmh": 0, "avg_speed_kmh": 0,
            "total_time_s": 0, "stopped_time_s": 0, "moving_time_s": 0,
            "current_speed_kmh": 0, "current_heading": 0,
            "current_heading_name": "N/A", "current_state": "sin_datos",
        }
    total_dist = 0.0
    max_speed = 0.0
    stopped_s = 0.0
    speed_sum = 0.0
    speed_count = 0
    for i in range(1, len(points)):
        d = haversine_m(points[i-1]["lat"], points[i-1]["lng"], points[i]["lat"], points[i]["lng"])
        total_dist += d
        spd = float(points[i].get("speed_kmh", 0))
        if spd > 120: spd = 0.0
        if spd > max_speed: max_speed = spd
        if spd > 0: speed_sum += spd; speed_count += 1
    try:
        t0 = datetime.fromisoformat(points[0]["timestamp"])
        t1 = datetime.fromisoformat(points[-1]["timestamp"])
        total_s = (t1 - t0).total_seconds()
    except Exception:
        total_s = 0
    if total_s > 0 and speed_count > 0:
        for i in range(1, len(points)):
            try:
                ta = datetime.fromisoformat(points[i-1]["timestamp"])
                tb = datetime.fromisoformat(points[i]["timestamp"])
                seg_s = (tb - ta).total_seconds()
                if points[i]["speed_kmh"] < 1.0: stopped_s += seg_s
            except Exception:
                pass
    last = points[-1]
    current_speed = float(last.get("speed_kmh", 0)) if last.get("speed_kmh") is not None else 0.0
    if current_speed > 120: current_speed = 0.0
    hdg_name = heading_name(last["heading"]) if last["heading"] is not None else "N/A"
    return {
        "total_distance_km": round(total_dist / 1000, 3),
        "max_speed_kmh": round(max_speed, 1),
        "avg_speed_kmh": round(speed_sum / speed_count, 1) if speed_count > 0 else 0,
        "total_time_s": int(total_s), "stopped_time_s": int(stopped_s),
        "moving_time_s": int(total_s - stopped_s),
        "current_speed_kmh": round(current_speed, 1),
        "current_heading": last["heading"],
        "current_heading_name": hdg_name,
        "current_state": last["movement_state"],
    }


# ════════════════════════════════════════════════════════════════
# LAYER 2: STATE ENGINE v5 — CANONICAL (SOURCE OF TRUTH)
# ════════════════════════════════════════════════════════════════

def _classify_zone(lat, lng, speed):
    """Zone classifier. POI priority: HOME > WORK > TRANSIT > IDLE."""
    if lat is None or lng is None:
        return "IDLE", None
    for poi in POI_LIST:
        d = haversine_m(poi["lat"], poi["lng"], lat, lng)
        if d <= poi["radius"]:
            return poi["id"].upper(), poi["id"]
    if speed > 3:
        return "TRANSIT", None
    return "IDLE", None


def _classify_motion(speed, prev_state):
    """
    Motion classification v5 — SIMPLIFIED.
    <2   → STATIC (speed forced to 0 if variance low)
    2-7  → WALK
    7-40 → CAR
    >40  → BUS

    Ghost speed fix: if movement_variance < 0.15, speed = 0, mode = STATIC
    """
    # Get EMA smoothed speed
    if prev_state and "_internal" in prev_state:
        prev_smooth = prev_state["_internal"].get("motion_speed_smooth", 0)
        speed_history = prev_state["_internal"].get("speed_history", [])
    else:
        prev_smooth = 0
        speed_history = []

    # EMA smoothing
    smooth = speed * MOTION_EMA_ALPHA + prev_smooth * (1 - MOTION_EMA_ALPHA)

    # Ghost speed detection: compute variance of recent speeds
    variance = 0
    if len(speed_history) >= 5:
        recent = speed_history[-10:]
        mean = sum(recent) / len(recent)
        variance = sum((s - mean) ** 2 for s in recent) / len(recent)

    # FIX: ghost speed — if variance very low, force STATIC
    if variance < MOTION_VARIANCE_THRESHOLD and smooth < MOTION_STATIC_MAX:
        smooth = 0
        return "STATIC", 0, 0.9

    # Classify based on smoothed speed
    if smooth < MOTION_STATIC_MAX:
        mode = "STATIC"
        confidence = 0.9
        smooth = 0  # No fake speed for STATIC
    elif smooth <= MOTION_WALK_MAX:
        mode = "WALK"
        confidence = 0.8
    elif smooth <= MOTION_CAR_MAX:
        mode = "CAR"
        confidence = 0.85
    else:
        mode = "BUS"
        confidence = 0.7

    return mode, round(smooth, 1), round(confidence, 2)


def _compute_place(zone, geofence_id, address, lat, lng):
    """Place label: HOME > WORK > POI > address > reverse geocode > TRANSIT > fallback."""
    zone_to_place = {
        "HOME": "Casa",
        "WORK": "Trabajo",
    }
    if zone in zone_to_place:
        return zone_to_place[zone]

    if geofence_id:
        for poi in POI_LIST:
            if poi["id"] == geofence_id:
                return poi["name"]

    if address:
        parts = address.split(",")
        label = parts[0].strip()
        if label:
            return label

    if lat is not None and lng is not None:
        place = _reverse_geocode_cached(lat, lng)
        if place:
            return place

    if zone == "TRANSIT":
        return "En ruta"

    return "Sin ubicacion"


def _reverse_geocode_cached(lat, lng):
    """Reverse geocode con cache."""
    key = (round(lat, 4), round(lng, 4))
    if key in _NOMINATIM_CACHE:
        return _NOMINATIM_CACHE[key]
    try:
        url = (
            f"https://nominatim.openstreetmap.org/reverse?"
            f"format=jsonv2&lat={lat}&lon={lng}&zoom=18"
            f"&accept-language=es&addressdetails=1"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "STracker/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        name = (
            data.get("address", {}).get("amenity", "")
            or data.get("address", {}).get("shop", "")
            or data.get("address", {}).get("building", "")
            or data.get("name", "")
        )
        if not name:
            dn = data.get("display_name", "")
            parts = dn.split(", ")
            name = parts[0] if parts else ""
        if name:
            _NOMINATIM_CACHE[key] = name
        return name
    except Exception:
        return ""


def _compute_since_sec(zone, prev_state):
    """FIX: tiempo real en lugar. since_sec = now - last zone change."""
    if not prev_state:
        return 0

    prev_zone = prev_state.get("_internal", {}).get("zone", "")
    if prev_zone != zone:
        return 0  # Zone changed, reset timer

    prev_since = prev_state.get("location", {}).get("since_sec", 0)
    return prev_since + POLL_INTERVAL


def _compute_signal_quality(accuracy):
    """FIX: GPS signal quality based on accuracy."""
    if accuracy is None or accuracy <= 0:
        return "NO_SIGNAL"
    if accuracy < 15:
        return "GOOD"
    if accuracy < 50:
        return "WEAK"
    return "NO_SIGNAL"


def _infer_network_type(accuracy, speed):
    """Infer network type from accuracy + speed."""
    if accuracy is None or accuracy <= 0:
        return "UNKNOWN"
    if accuracy <= 30 and speed < 10:
        return "WIFI"
    if accuracy <= 50 and speed > 5:
        return "5G"
    if accuracy > 50:
        return "4G"
    return "UNKNOWN"


def _infer_screen_state(prev_state, timestamp):
    """Screen state: ON if updates <30s, OFF otherwise."""
    if not prev_state or not timestamp:
        return "ON"
    try:
        if isinstance(timestamp, str):
            last_ts = datetime.fromisoformat(timestamp)
        else:
            last_ts = timestamp
        now = datetime.now(timezone.utc)
        delta = (now - last_ts).total_seconds()
        if delta < SCREEN_ON_THRESHOLD_S:
            return "ON"
    except Exception:
        pass
    mode = prev_state.get("movement", {}).get("mode", "STATIC")
    if mode != "STATIC":
        return "ON"
    return "OFF"


def _compute_activity_score(speed, zone, stability, battery, charging, screen_on):
    """Activity score: 40% movement + 25% zone + 20% GPS + 15% device."""
    score = 0
    # 40% Movement
    if speed > 5:
        score += 40
    elif speed > 1:
        score += 20
    # 25% Zone
    if zone == "WORK":
        score += 25
    elif zone == "TRANSIT":
        score += 20
    elif zone == "HOME":
        score += 15
    # 20% GPS stability
    score += stability * 20
    # 15% Device
    if charging:
        score += 10
    else:
        score += min(10, (battery / 100) * 10)
    if screen_on:
        score += 5
    return max(0, min(100, round(score)))


def _compute_activity_level(score):
    """0-25 LOW, 26-65 MID, 66-100 HIGH."""
    if score <= 25:
        return "LOW"
    if score <= 65:
        return "MID"
    return "HIGH"


def _compute_stability(prev_state, speed, accuracy):
    """Stability: anti-jitter. 0.0-1.0."""
    if not prev_state:
        return 1.0
    prev_speed = prev_state.get("movement", {}).get("speed_kmh", 0)
    diff = abs(speed - prev_speed)
    speed_stab = max(0, 1 - (diff / 15))
    acc_factor = max(0, 1 - (accuracy / 200)) if accuracy > 0 else 0.5
    return round(max(0, min(1, speed_stab * 0.6 + acc_factor * 0.4)), 2)


def _detect_spoof(lat, lng, speed, accuracy, stability, prev_state):
    """Anti-Spoof Bayesian. Returns {risk, label}."""
    risk = 0
    if not prev_state:
        return {"risk": 0, "label": "OK"}

    prev_loc = prev_state.get("location", {})
    prev_lat = prev_loc.get("lat")
    prev_lng = prev_loc.get("lng")
    prev_speed = prev_state.get("movement", {}).get("speed_kmh", 0)
    prev_zone = prev_state.get("_internal", {}).get("zone", "IDLE")

    if prev_lat is not None and prev_lng is not None and lat is not None and lng is not None:
        dist = haversine_m(prev_lat, prev_lng, lat, lng)
        if dist > 2000 and speed < 5:
            risk += SPOOF_WEIGHT_VELOCITY
        elif dist > 500 and speed < 2:
            risk += SPOOF_WEIGHT_VELOCITY * 0.7
        if prev_speed < 2 and speed > 60:
            risk += SPOOF_WEIGHT_ACCEL
        elif abs(speed - prev_speed) > 50:
            risk += SPOOF_WEIGHT_ACCEL * 0.7

    if accuracy > 200:
        risk += SPOOF_WEIGHT_JITTER
    elif accuracy > 100:
        risk += SPOOF_WEIGHT_JITTER * 0.5

    if stability < 0.3:
        risk += SPOOF_WEIGHT_JITTER * 0.3

    if accuracy > 0 and accuracy <= 30 and speed > 40:
        risk += SPOOF_WEIGHT_NETWORK

    if prev_zone == "HOME" and lat is not None and lng is not None:
        cur_zone, _ = _classify_zone(lat, lng, speed)
        if cur_zone == "WORK" and prev_speed < 3:
            risk += SPOOF_WEIGHT_ZONE_JUMP

    if prev_lat is not None and prev_lng is not None and lat is not None and lng is not None:
        dist = haversine_m(prev_lat, prev_lng, lat, lng)
        if dist < 1 and speed > 0:
            risk += SPOOF_WEIGHT_PATTERN

    risk = min(100, risk)

    if risk >= SPOOF_HIGH_RISK_THRESHOLD:
        label = "HIGH_RISK"
    elif risk >= SPOOF_SUSPICIOUS_THRESHOLD:
        label = "SUSPICIOUS"
    else:
        label = "OK"

    return {"risk": risk, "label": label}


def _compute_proximity(lat, lng, mode):
    """Proximity engine. CAR: 300m→APPROACHING, 200m→ARRIVED. WALK: 200m→APPROACHING."""
    result = {"arrival": "NONE", "mode": "NONE", "distance_m": None}

    if lat is None or lng is None:
        return result

    # Distance to home
    home_dist = round(haversine_m(lat, lng, HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1]))
    result["distance_m"] = home_dist

    if mode == "CAR":
        result["mode"] = "CAR"
        if home_dist <= ARRIVAL_CAR_CLOSE_M:
            result["arrival"] = "ARRIVED"
        elif home_dist <= ARRIVAL_CAR_APPROACH_M:
            result["arrival"] = "APPROACHING"
    elif mode in ("WALK", "BUS"):
        result["mode"] = "WALK"
        if home_dist <= ARRIVAL_WALK_APPROACH_M:
            result["arrival"] = "APPROACHING"

    return result


def _compute_ghostrail(prev_state, lat, lng, speed, zone):
    """GhostRail v5: restored timeline with last_zones max 5."""
    zone_map = {"HOME": "Casa", "WORK": "Trabajo", "TRANSIT": "En ruta", "IDLE": "Otro"}
    zone_label = zone_map.get(zone, "Otro")

    if not prev_state:
        return {
            "enabled": True,
            "points_24h": [{"lat": lat, "lng": lng, "zone": zone_label}] if lat and lng else [],
            "last_zones": [{"name": zone_label, "min": 1}],
            "timeline_active": True,
        }

    prev = prev_state.get("ghostrail", {})
    points_24h = list(prev.get("points_24h", []))
    last_zones = list(prev.get("last_zones", []))

    # Add point (keep last 200)
    if lat is not None and lng is not None:
        points_24h.append({"lat": lat, "lng": lng, "zone": zone_label})
    if len(points_24h) > 200:
        points_24h = points_24h[-200:]

    # Update zone clusters (incremental)
    found = False
    for z in last_zones:
        if z["name"] == zone_label:
            z["min"] = z.get("min", 0) + 1
            found = True
            break
    if not found:
        last_zones.insert(0, {"name": zone_label, "min": 1})

    # Keep max 5
    last_zones = last_zones[:5]

    return {
        "enabled": True,
        "points_24h": points_24h[-50:],  # Cap for performance
        "last_zones": last_zones,
        "timeline_active": True,
    }


def build_state(raw, prev_state=None):
    """
    STATE ENGINE v5 CANONICAL — single source of truth.
    Pipeline:
      1.  Movement layer (EMA + ghost speed fix)
      2.  Zone classification (POI system)
      3.  Place label + since_sec
      4.  Network inference + signal quality
      5.  Anti-spoof
      6.  Activity score + level
      7.  Screen state
      8.  Proximity engine
      9.  GhostRail v5 (restored)
      10. Events FIFO
      11. Final canonical state
    """
    lat = raw.get("lat")
    lng = raw.get("lng")
    speed = float(raw.get("speed_kmh") or 0)
    battery = raw.get("battery")
    accuracy = float(raw.get("accuracy") or 0)
    address = raw.get("address") or ""
    charging = bool(raw.get("charging") or False)
    timestamp = raw.get("timestamp")
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── 1. MOVEMENT LAYER (with ghost speed fix) ──
    mode, speed_kmh, confidence = _classify_motion(speed, prev_state)

    # ── 2. ZONE CLASSIFICATION ──
    zone, geofence_id = _classify_zone(lat, lng, speed_kmh)

    # ── 3. PLACE + SINCE_SEC ──
    place = _compute_place(zone, geofence_id, address, lat, lng)
    since_sec = _compute_since_sec(zone, prev_state)

    # Distance to home
    distance_to_home_m = None
    if lat is not None and lng is not None:
        distance_to_home_m = round(haversine_m(lat, lng, HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1]))

    # ── 4. NETWORK + SIGNAL QUALITY ──
    network_type = _infer_network_type(accuracy, speed_kmh)
    signal_quality = _compute_signal_quality(accuracy)

    # ── 5. ANTI-SPOOF ──
    stability = _compute_stability(prev_state, speed_kmh, accuracy)
    spoof = _detect_spoof(lat, lng, speed_kmh, accuracy, stability, prev_state)
    if spoof["label"] == "HIGH_RISK":
        logger.warning("SPOOF HIGH_RISK: risk=%d", spoof["risk"])

    # ── 6. ACTIVITY SCORE + LEVEL ──
    battery_val = 50
    if battery is not None:
        try:
            battery_val = int(str(battery).replace("%", ""))
        except (ValueError, TypeError):
            pass

    screen_on = _infer_screen_state(prev_state, timestamp) == "ON"
    score = _compute_activity_score(speed_kmh, zone, stability, battery_val, charging, screen_on)
    level = _compute_activity_level(score)

    # ── 7. SCREEN STATE ──
    screen_state = _infer_screen_state(prev_state, timestamp)

    # ── 8. PROXIMITY ENGINE ──
    proximity = _compute_proximity(lat, lng, mode)

    # ── 9. GHOSTRAIL (restored) ──
    ghostrail = _compute_ghostrail(prev_state, lat, lng, speed_kmh, zone)

    # ── 10. EVENTS FIFO ──
    events = list(prev_state.get("events", [])) if prev_state else []

    # Zone change
    if prev_state:
        prev_zone = prev_state.get("_internal", {}).get("zone", "")
        if prev_zone and prev_zone != zone:
            zm = {"HOME": "Casa", "WORK": "Trabajo", "TRANSIT": "En ruta", "IDLE": "Otro"}
            events.append({"type": "ZONE", "msg": f"{zm.get(prev_zone, prev_zone)} -> {zm.get(zone, zone)}", "ts": now_iso})

    # Spoof
    if spoof["label"] == "HIGH_RISK":
        events.append({"type": "SPOOF", "msg": f"GPS alto riesgo ({spoof['risk']}%)", "ts": now_iso})
    elif spoof["label"] == "SUSPICIOUS":
        events.append({"type": "SPOOF", "msg": f"GPS sospechoso ({spoof['risk']}%)", "ts": now_iso})

    # Network change
    if prev_state:
        prev_net = prev_state.get("network", {}).get("type", "UNKNOWN")
        if prev_net != network_type and network_type != "UNKNOWN":
            events.append({"type": "NETWORK", "msg": f"{prev_net} -> {network_type}", "ts": now_iso})

    # Battery drop
    if prev_state:
        prev_batt = prev_state.get("device", {}).get("battery")
        if prev_batt is not None and battery_val < prev_batt - 10:
            events.append({"type": "BATTERY", "msg": f"{prev_batt}% -> {battery_val}%", "ts": now_iso})

    # Arrival
    if proximity["arrival"] == "ARRIVED":
        events.append({"type": "ARRIVAL", "msg": "CASI LLEGAS", "ts": now_iso})
    elif proximity["arrival"] == "APPROACHING":
        events.append({"type": "ARRIVAL", "msg": "LLEGANDO", "ts": now_iso})

    # Activity spike
    if prev_state:
        prev_score = prev_state.get("activity", {}).get("score", 0)
        if abs(score - prev_score) > 30:
            events.append({"type": "ACTIVITY", "msg": f"{prev_score}% -> {score}%", "ts": now_iso})

    events = events[-MAX_EVENTS:]

    # Speed history for ghost detection
    speed_history = []
    if prev_state and "_internal" in prev_state:
        speed_history = list(prev_state["_internal"].get("speed_history", []))
    speed_history.append(speed)
    if len(speed_history) > 20:
        speed_history = speed_history[-20:]

    # ── FINAL CANONICAL STATE v5 ──
    state = {
        "meta": {
            "timestamp": now_iso,
            "device_id": "sofi",
            "version": "v5",
        },
        "location": {
            "lat": lat,
            "lng": lng,
            "label_primary": place,
            "since_sec": since_sec,
            "distance_to_home_m": distance_to_home_m,
        },
        "movement": {
            "speed_kmh": speed_kmh,
            "mode": mode,
            "confidence": confidence,
        },
        "activity": {
            "score": score,
            "level": level,
            "screen_state": screen_state,
        },
        "network": {
            "type": network_type,
            "signal_quality": signal_quality,
        },
        "device": {
            "battery": battery_val,
            "charging": charging,
        },
        "spoof": {
            "risk": spoof["risk"],
            "label": spoof["label"],
        },
        "proximity": proximity,
        "ghostrail": ghostrail,
        "events": events,
        # Internal (not for frontend)
        "_internal": {
            "motion_speed_smooth": speed_kmh if mode != "STATIC" else 0,
            "speed_history": speed_history,
            "zone": zone,
        },
    }

    return state


# ------------------------------------------------------------
# PLAYWRIGHT / COOKIES (unchanged)
# ------------------------------------------------------------
def _check_profile_lock():
    candidates = [PROFILE_DIR / "SingletonLock", PROFILE_DIR / "SingletonCookie", PROFILE_DIR / "lockfile"]
    locks = [p for p in candidates if p.exists()]
    if locks:
        logger.warning("Profile lock: %s", ", ".join(str(p.name) for p in locks))


def _load_cookie_header():
    try:
        with open(COOKIES_PATH, encoding="utf-8") as f:
            cookies = json.load(f)
        parts = [f"{c['name']}={c['value']}" for c in cookies if "google.com" in c.get("domain", "")]
        return "; ".join(parts)
    except Exception as e:
        logger.error("Error cargando cookies: %s", e)
        return ""


def _chrome_same_site(val):
    return {0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict"}.get(val, "unspecified")


def _refresh_cookies_via_playwright():
    if _read_cookies_from_sqlite(PROFILE_DIR / "Default" / "Network" / "Cookies"):
        return True
    if _read_cookies_via_cdp():
        return True
    if _read_cookies_via_playwright_headless():
        return True
    return False


def _read_cookies_from_sqlite(db_path):
    import sqlite3
    if not db_path.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{db_path}?immutable=1", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT host_key, name, value, path, is_secure, is_httponly, has_expires, expires_utc, samesite FROM cookies WHERE host_key LIKE ?", ("%.google.com",))
        rows = cur.fetchall()
        conn.close()
        if not rows or len(rows) < 5:
            return False
        CHROME_EPOCH_DELTA = 11644473600000000
        normalized = []
        for row in rows:
            entry = {"name": row["name"], "value": row["value"], "domain": row["host_key"], "path": row["path"], "secure": bool(row["is_secure"]), "httpOnly": bool(row["is_httponly"]), "sameSite": _chrome_same_site(row["samesite"]) if "samesite" in row else "no_restriction", "hostOnly": row["host_key"].startswith(".") is False}
            if row["has_expires"] and row["expires_utc"]:
                ts = (row["expires_utc"] - CHROME_EPOCH_DELTA) / 1_000_000
                if ts > 0: entry["expirationDate"] = round(ts, 6)
            normalized.append(entry)
        COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
        logger.info("Cookies via SQLite: %d", len(normalized))
        return True
    except Exception as e:
        logger.debug("SQLite fallo: %s", e)
        return False


def _read_cookies_via_cdp():
    import urllib.request, json as _json
    for port in [9222, 9223, 9224, 9225]:
        try:
            resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=2)
            pages = _json.loads(resp.read())
            if not pages: continue
            try:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as pw:
                    browser = pw.chromium.connect_over_cdp(f"http://localhost:{port}")
                    context = browser.contexts[0] if browser.contexts else browser.new_context()
                    cookies = context.cookies()
                    google_cookies = [c for c in cookies if "google.com" in c.get("domain", "")]
                    if google_cookies:
                        normalized = [{"name": c["name"], "value": c["value"], "domain": c.get("domain", ""), "path": c.get("path", "/"), "secure": c.get("secure", False), "httpOnly": c.get("httpOnly", False), "sameSite": c.get("sameSite", "no_restriction"), "hostOnly": c.get("domain", "").startswith(".") is False} for c in google_cookies]
                        COOKIES_PATH.write_text(_json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
                        logger.info("Cookies via CDP: %d", len(normalized))
                        browser.close()
                        return True
                    browser.close()
            except ImportError: pass
        except Exception: continue
    return False


def _read_cookies_via_playwright_headless():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    try:
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(str(PROFILE_DIR), headless=True, no_viewport=True, locale="es-AR", args=["--disable-blink-features=AutomationControlled"])
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://www.google.com/maps", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(5000)
            cookies = context.cookies()
            google_cookies = [c for c in cookies if "google.com" in c.get("domain", "")]
            if google_cookies and len(google_cookies) > 5:
                normalized = [{"name": c["name"], "value": c["value"], "domain": c.get("domain", ""), "path": c.get("path", "/"), "secure": c.get("secure", False), "httpOnly": c.get("httpOnly", False), "sameSite": c.get("sameSite", "no_restriction"), "hostOnly": c.get("domain", "").startswith(".") is False} for c in google_cookies]
                COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
                logger.info("Cookies via Playwright: %d", len(normalized))
                context.close()
                return True
            context.close()
    except Exception as e:
        logger.debug("Playwright fallo: %s", e)
    return False


def _extract_coords_from_json(obj, depth=0):
    if depth > 10 or obj is None: return None
    if isinstance(obj, list):
        if len(obj) == 2 and all(isinstance(x, (int, float)) for x in obj):
            a, b = float(obj[0]), float(obj[1])
            if -90 <= a <= 90 and -180 <= b <= 180 and abs(a) > 1 and abs(b) > 1: return (a, b)
            if -180 <= a <= 180 and -90 <= b <= 90 and abs(a) > 1 and abs(b) > 1: return (b, a)
        for item in obj:
            r = _extract_coords_from_json(item, depth + 1)
            if r: return r
    elif isinstance(obj, dict):
        for v in obj.values():
            r = _extract_coords_from_json(v, depth + 1)
            if r: return r
    return None


def _fetch_location(cookie_header):
    import urllib.request, urllib.error, json as _json
    try:
        req = urllib.request.Request(LOCATIONSHARING_URL, headers={"Cookie": cookie_header, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.google.com/maps", "X-Goog-AuthUser": "0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.warning("RPC error: %s", e)
        raw = ""

    if raw:
        text = re.sub(r"^\)\]\}'\s*\n?", "", raw)
        if re.match(r'^\[null,null,', text):
            logger.warning("Google Maps no reporta ubicacion activa.")
            return None, None, None, "", 0, 0
        found = None
        m = re.search(r'\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]', text)
        if m: lng, lat = float(m.group(1)), float(m.group(2)); found = (lat, lng)
        if not found:
            m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', text)
            if m: lng, lat = float(m.group(1)), float(m.group(2)); found = (lat, lng)
        if not found:
            try:
                data = _json.loads(text)
                coords = _extract_coords_from_json(data)
                if coords: found = coords
            except Exception: pass
        if found:
            lat, lng = found
            bat, address, accuracy, charging = _parse_rpc_details(text)
            return lat, lng, bat, address, accuracy, charging

    try:
        req = urllib.request.Request(GMAPS_SHARE_URL, headers={"Cookie": cookie_header, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.google.com/maps"})
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.warning("HTML fetch error: %s", e)
        return None, None, None, "", 0, 0

    m = re.search(r'\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]', html)
    if not m: m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', html)
    if not m:
        m2 = re.search(r'window\.APP_INITIALIZATION_STATE\s*=\s*([^;]+)', html)
        if m2:
            try:
                data = _json.loads(m2.group(1))
                coords = _extract_coords_from_json(data)
                if coords: lat, lng = coords; m = True
            except Exception: pass
    if not m:
        logger.warning("No se encontraron coordenadas")
        return None, None, None, "", 0, 0
    if isinstance(m, tuple): lat, lng = m
    else: lng = float(m.group(1)); lat = float(m.group(2))
    bat, address, _, _ = _parse_rpc_details(html)
    return lat, lng, bat, address, 0, 0


def _parse_rpc_details(text):
    bat = None
    bm = BAT_API_RE.search(text)
    if bm:
        try:
            pct = int(bm.group(1))
            if 1 <= pct <= 100: bat = f"{pct}%"
        except Exception: pass
    address = ""
    addr_m = re.search(r',\d+,"([^"]{10,})"', text)
    if addr_m:
        address = addr_m.group(1).strip()
        if address: address = address.split(',')[0].strip()
        if address: address = f"{address}, Santa Fe"
    acc_m = ACCURACY_RE.search(text)
    accuracy = int(acc_m.group(1)) if acc_m else 0
    ch_m = CHARGE_RE.search(text)
    charging = int(ch_m.group(1)) if ch_m else 0
    return bat, address, accuracy, charging


# ------------------------------------------------------------
# TRACKING LOOP v5
# ------------------------------------------------------------
def tracking_loop(stop_event):
    global _CURRENT_BATTERY, _CURRENT_ADDRESS, _LAST_POLL_TIME, _LAST_POLL_LAT, _LAST_POLL_LNG
    global _PREV_STATE, _LAST_UPDATE, _CURRENT_CHARGING

    init_csv()
    battery_info = None
    logger.info("Inicio tracking (v5 clean split).")
    _no_coords_count = 0
    poll_counter = 0

    while not stop_event.is_set():
        poll_counter += 1
        logger.info("=== POLL #%d ===", poll_counter)
        try:
            cookie_header = _load_cookie_header()
            if not cookie_header:
                logger.error("Sin cookies, esperando...")
                stop_event.wait(POLL_INTERVAL)
                continue

            lat, lng, bat, address, accuracy, charging = _fetch_location(cookie_header)

            if address: _CURRENT_ADDRESS = address
            if bat: battery_info = bat; _CURRENT_BATTERY = bat; _update_battery_estimate(bat)
            _CURRENT_CHARGING = "cargando" if charging == 1 else ""

            if lat is not None and lng is not None:
                _no_coords_count = 0
                if not is_duplicate(lat, lng):
                    now = datetime.now(timezone.utc)
                    speed, hdg, state = compute_telemetry(lat, lng, now)

                    if _LAST_POLL_TIME is not None and _LAST_POLL_LAT is not None and speed == 0:
                        delta_s = (now - _LAST_POLL_TIME).total_seconds()
                        if delta_s > 0:
                            dist_m = haversine_m(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            speed = dist_m * 3.6 / delta_s
                            hdg = bearing(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            state = classify_speed(speed)

                    _LAST_POLL_TIME = now
                    _LAST_POLL_LAT = lat
                    _LAST_POLL_LNG = lng
                    _LAST_UPDATE = now

                    raw = {
                        "lat": lat, "lng": lng, "speed_kmh": speed,
                        "battery": battery_info, "accuracy": accuracy,
                        "address": _CURRENT_ADDRESS,
                        "charging": charging if charging else False,
                        "timestamp": now.isoformat(),
                    }
                    _PREV_STATE = build_state(raw, _PREV_STATE)

                    append_csv(now, lat, lng, speed, hdg, state)
                    points = read_all_points()
                    stats = compute_stats(points)
                    generate_html(points, stats, battery_info)
                    logger.info(
                        "Punto | label_primary=%s mode=%s score=%d spoof=%s since=%ds",
                        _PREV_STATE["location"]["label_primary"],
                        _PREV_STATE["movement"]["mode"],
                        _PREV_STATE["activity"]["score"],
                        _PREV_STATE["spoof"]["label"],
                        _PREV_STATE["location"]["since_sec"],
                    )
                else:
                    _update_battery_estimate(bat)
            else:
                _no_coords_count += 1
                if _no_coords_count >= 3:
                    _no_coords_count = 0
                    if not SKIP_PLAYWRIGHT:
                        _refresh_cookies_via_playwright()
                    else:
                        logger.warning("Cookies expiradas. Carga nuevas via /cookies.html")
        except Exception as e:
            logger.error("Error en loop: %s", e)
        stop_event.wait(POLL_INTERVAL)
    logger.info("Tracking detenido.")


# ------------------------------------------------------------
# BATTERY ESTIMATION
# ------------------------------------------------------------
def _update_battery_estimate(bat):
    global _BATTERY_HISTORY, _BATTERY_LIFE_ESTIMATE
    if not bat: return
    pct = int(bat.replace('%', ''))
    now = time.time()
    _BATTERY_HISTORY.append((now, pct))
    if len(_BATTERY_HISTORY) > _MAX_BATTERY_HISTORY: _BATTERY_HISTORY.pop(0)
    if len(_BATTERY_HISTORY) < 3: _BATTERY_LIFE_ESTIMATE = "N/A"; return
    first = _BATTERY_HISTORY[0]; last = _BATTERY_HISTORY[-1]
    elapsed_h = (last[0] - first[0]) / 3600
    if elapsed_h <= 0 or last[1] >= first[1]: _BATTERY_LIFE_ESTIMATE = "N/A"; return
    drain_pct_h = (first[1] - last[1]) / elapsed_h
    if drain_pct_h <= 0: _BATTERY_LIFE_ESTIMATE = "N/A"; return
    remaining_h = last[1] / drain_pct_h
    if remaining_h < 1: _BATTERY_LIFE_ESTIMATE = f"~{int(remaining_h * 60)}m"
    else: _BATTERY_LIFE_ESTIMATE = f"~{int(remaining_h)}h {int((remaining_h % 1) * 60):02d}m"


# ------------------------------------------------------------
# LAYER 3: UI RENDERER — DUMB VISUALIZER (0 LOGIC)
# ------------------------------------------------------------
def generate_html(points, stats, battery=None):
    logger.info("Generando HTML v5 con %d puntos", len(points))
    geojson = json.dumps(points)
    stats_json = json.dumps(stats)

    if _PREV_STATE is not None:
        state = _PREV_STATE
    else:
        last = points[-1] if points else {}
        speed = stats.get("current_speed_kmh", 0) or 0
        raw = {"lat": last.get("lat"), "lng": last.get("lng"), "speed_kmh": speed, "battery": battery, "accuracy": None, "address": "", "charging": None, "timestamp": last.get("timestamp")}
        state = build_state(raw, None)
    state_json = json.dumps(state)

    html = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue',sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased;color:#fff}
#map{position:fixed;inset:0;z-index:1}
.leaflet-container{background:#000}
.leaflet-popup-content-wrapper{background:rgba(20,20,20,.92);backdrop-filter:blur(16px);color:#fff;border:1px solid rgba(255,255,255,.06);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.leaflet-popup-tip{background:rgba(20,20,20,.92)}
.leaflet-popup-content{font-size:13px;line-height:1.5;margin:10px 14px}
.leaflet-control-zoom{border:none!important;box-shadow:none!important;margin:10px!important}
.leaflet-control-zoom a{background:rgba(20,20,20,.72)!important;backdrop-filter:blur(16px)!important;color:#8a8a8a!important;border:1px solid rgba(255,255,255,.06)!important;width:36px!important;height:36px!important;line-height:36px!important;font-size:16px!important;border-radius:10px!important;margin-bottom:2px!important}
.leaflet-control-zoom a:hover{background:rgba(40,40,40,.85)!important;color:#fff!important}
.marker-cluster-small,.marker-cluster-medium,.marker-cluster-large{background-color:rgba(100,100,100,.12)!important}
.marker-cluster-small div,.marker-cluster-medium div,.marker-cluster-large div{background-color:rgba(100,100,100,.35)!important;color:#fff!important;font-weight:600!important}
.live-marker{position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none}
.live-dot{width:18px;height:18px;border-radius:50%;background:#007aff;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,122,255,.4);position:relative}
.live-dot::after{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(0,122,255,.5);animation:livePulse 2s ease-out infinite}
@keyframes livePulse{0%{transform:scale(.8);opacity:.6}100%{transform:scale(2);opacity:0}}
.live-speed{font-size:11px;font-weight:600;color:#fff;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:4px;margin-top:3px;white-space:nowrap}

/* Bottom card */
.card{position:fixed;left:16px;right:16px;bottom:18px;z-index:1000;background:rgba(20,20,20,.72);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.06);border-radius:18px;padding:14px 16px calc(14px + env(safe-area-inset-bottom, 0px));max-height:55vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.card::-webkit-scrollbar{width:0;display:none}
@media(min-width:700px){.card{left:50%;right:auto;transform:translateX(-50%);width:420px;max-width:90vw}}

/* ===== UI PRIORITY STACK ===== */
/* 1. LOCATION — sole big label (ONE PLACE RULE) */
.label-row{margin-bottom:2px}
.label-primary{font-size:22px;font-weight:700;letter-spacing:-.5px;line-height:1.1;color:#fff}
.label-primary.casa{color:#34c759}.label-primary.trabajo{color:#007aff}.label-primary.movimiento{color:#ff9500}.label-primary.inactivo{color:#8a8a8a}

/* Since + Time */
.since-row{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.since{font-size:12px;color:#636363;white-space:nowrap}
.time-row{font-size:12px;color:#636363;white-space:nowrap}

/* 2. MOVEMENT — badge */
.meta-row{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.mode-badge{display:inline-block;font-size:11px;font-weight:600;color:#fff;background:rgba(255,255,255,.08);padding:2px 8px;border-radius:6px;letter-spacing:.3px}
.mode-badge.static{background:rgba(142,142,147,.15);color:#8e8e93}
.mode-badge.walk{background:rgba(52,199,89,.15);color:#34c759}
.mode-badge.car{background:rgba(0,122,255,.15);color:#007aff}
.mode-badge.bus{background:rgba(255,149,0,.15);color:#ff9500}
.meta-sep{color:#636363;font-size:11px}

/* 3. ACTIVITY — level badge + score */
.level-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;letter-spacing:.3px}
.level-badge.low{background:rgba(142,142,147,.15);color:#8e8e93}
.level-badge.mid{background:rgba(255,149,0,.15);color:#ff9500}
.level-badge.high{background:rgba(52,199,89,.15);color:#34c759}
.speed-inline{font-size:13px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.speed-unit{font-size:10px;color:#8a8a8a;font-weight:500;margin-left:2px}

/* Info rows */
.info-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#8a8a8a;margin-bottom:4px}
.info-row:last-child{margin-bottom:0}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot.green{background:#34c759}.dot.blue{background:#007aff}.dot.orange{background:#ff9500}.dot.gray{background:#8a8a8a}.dot.red{background:#ff3b30}.dot.yellow{background:#ffd60a}.dot.purple{background:#af52de}
.val{color:#fff;font-weight:500}
.bar-wrap{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden;margin-left:6px}
.bar-fill{height:100%;border-radius:2px;transition:width .5s}

/* Signal quality */
.sq-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;letter-spacing:.3px;margin-left:4px}
.sq-badge.good{background:rgba(52,199,89,.15);color:#34c759}
.sq-badge.weak{background:rgba(255,149,0,.15);color:#ff9500}
.sq-badge.no_signal{background:rgba(255,59,48,.15);color:#ff3b30}

/* Screen indicator */
.screen-ind{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;vertical-align:middle}
.screen-ind.on{background:#34c759;box-shadow:0 0 4px rgba(52,199,89,.5)}
.screen-ind.off{background:#ff3b30;box-shadow:0 0 4px rgba(255,59,48,.5)}

/* Proximity row */
.prox-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#8a8a8a;margin-top:4px;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.03)}
.prox-row.approaching{background:rgba(0,122,255,.08);color:#007aff}
.prox-row.arrived{background:rgba(52,199,89,.08);color:#34c759}

/* GhostRail */
.gr-row{display:flex;align-items:center;gap:10px;font-size:12px;color:#8a8a8a;margin-top:8px;flex-wrap:wrap}
.gr-item{display:inline-flex;align-items:center;gap:4px}
.gr-dot{width:6px;height:6px;border-radius:2px;flex-shrink:0}
.gr-dot.home{background:#34c759}.gr-dot.work{background:#007aff}.gr-dot.transit{background:#ff9500}.gr-dot.other{background:#8e8e93}
.gr-dur{color:#fff;font-weight:500}

/* Events panel */
.events-panel{margin-top:10px;border-top:1px solid rgba(255,255,255,.06);padding-top:8px}
.events-title{font-size:10px;color:#636363;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.event-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#8a8a8a;margin-bottom:3px}
.event-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.event-dot.zone{background:#007aff}.event-dot.spoof{background:#ff3b30}.event-dot.arrival{background:#34c759}.event-dot.network{background:#ff9500}.event-dot.battery{background:#ffd60a}.event-dot.activity{background:#af52de}
.event-msg{color:#fff;font-weight:400}

/* Spoof overlay */
#spoofOverlay{position:fixed;inset:0;z-index:999;pointer-events:none;opacity:0;transition:opacity .5s}
#spoofOverlay.active{opacity:1;animation:spoofAlert 2s ease-in-out infinite}
@keyframes spoofAlert{0%{box-shadow:inset 0 0 60px 10px rgba(255,59,48,.08)}50%{box-shadow:inset 0 0 160px 40px rgba(255,59,48,.2)}100%{box-shadow:inset 0 0 60px 10px rgba(255,59,48,.08)}}
#signalOverlay{position:fixed;inset:0;z-index:999;pointer-events:none;opacity:0;transition:opacity .5s}
#signalOverlay.active{opacity:1;animation:signalPulse 2s ease-in-out infinite}
@keyframes signalPulse{0%{box-shadow:inset 0 0 60px 10px rgba(255,149,0,.08)}50%{box-shadow:inset 0 0 160px 40px rgba(255,149,0,.15)}100%{box-shadow:inset 0 0 60px 10px rgba(255,149,0,.08)}}

/* Float buttons */
#floatBtns{position:fixed;right:12px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.fb{width:44px;height:44px;border-radius:50%;background:rgba(20,20,20,.72);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);color:#8a8a8a;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;padding:0;-webkit-tap-highlight-color:transparent}
.fb:hover{background:rgba(40,40,40,.85);color:#fff}
.fb:active{transform:scale(.9)}
.fb.active{color:#007aff;border-color:rgba(0,122,255,.3)}
#toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2000;background:rgba(20,20,20,.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 4px 24px rgba(0,0,0,.4);text-align:center;max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s;display:none}
#debugPanel{position:fixed;top:60px;left:12px;z-index:2000;background:rgba(20,20,20,.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px 14px;font-size:11px;color:#636363;font-family:'SF Mono',Menlo,Consolas,monospace;line-height:1.9;max-width:260px;display:none}
.dbg-row{display:flex;justify-content:space-between;gap:10px}
.dbg-val{color:#8a8a8a;text-align:right}
</style>
</head>
<body>
<div id="map"></div>
<div id="spoofOverlay"></div>
<div id="signalOverlay"></div>

<div class="card">
  <!-- 1. LOCATION — ONE PLACE RULE: label_primary is the SOLE place rendered -->
  <div class="label-row">
    <span class="label-primary" id="labelPrimary">---</span>
  </div>
  <div class="since-row">
    <span class="since" id="since"></span>
    <span class="time-row" id="timeRow"></span>
  </div>
  <!-- 2. MOVEMENT + 3. ACTIVITY — meta row -->
  <div class="meta-row">
    <span class="mode-badge static" id="modeBadge">STATIC</span>
    <span class="meta-sep">·</span>
    <span class="level-badge low" id="levelBadge">LOW</span>
    <span class="speed-inline" id="speedInline" style="display:none"></span>
  </div>
  <!-- Activity bar -->
  <div class="info-row" id="actRow">
    <span class="dot blue"></span>
    <span>Actividad</span>
    <span class="val" id="actVal">0</span>
    <div class="bar-wrap"><div class="bar-fill" id="actBar" style="width:0;background:#8a8a8a"></div></div>
  </div>
  <!-- 4. NETWORK + Signal -->
  <div class="info-row" id="netRow">
    <span class="dot purple" id="netDot"></span>
    <span>Red</span>
    <span class="val" id="netVal">---</span>
    <span class="sq-badge good" id="sqBadge">GOOD</span>
  </div>
  <!-- Battery + Screen -->
  <div class="info-row" id="battRow">
    <span class="dot green" id="battDot"></span>
    <span>Bateria</span>
    <span class="val" id="battVal">---</span>
    <span class="screen-ind on" id="screenInd"></span>
  </div>
  <!-- GPS / Signal quality -->
  <div class="info-row" id="gpsRow">
    <span class="dot green" id="gpsDot"></span>
    <span>GPS</span>
    <span class="val" id="gpsVal">---</span>
  </div>
  <!-- Proximity -->
  <div class="prox-row" id="proxRow" style="display:none">
    <span class="dot blue"></span>
    <span id="proxVal"></span>
  </div>
  <!-- GhostRail -->
  <div class="gr-row" id="grRow" style="display:none"></div>
  <!-- Events -->
  <div class="events-panel" id="eventsPanel" style="display:none">
    <div class="events-title">Eventos</div>
    <div id="eventsList"></div>
  </div>
</div>

<div id="floatBtns">
  <button id="btnSatellite" class="fb" title="Satelite"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg></button>
  <button id="btnCenter" class="fb" title="Centrar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg></button>
  <button id="btnCookies" class="fb" title="Cookies" onclick="window.open('/cookies.html','_blank')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r=".8" fill="currentColor" stroke="none"/></svg></button>
</div>
<div id="toast"></div>

<div id="debugPanel">
  <div class="dbg-row"><span>version</span><span class="dbg-val" id="dbgVer">v5</span></div>
  <div class="dbg-row"><span>speed</span><span class="dbg-val" id="dbgSpeed">0</span></div>
  <div class="dbg-row"><span>mode</span><span class="dbg-val" id="dbgMode">---</span></div>
  <div class="dbg-row"><span>label</span><span class="dbg-val" id="dbgLabel">---</span></div>
  <div class="dbg-row"><span>since</span><span class="dbg-val" id="dbgSince">0</span></div>
  <div class="dbg-row"><span>spoof</span><span class="dbg-val" id="dbgSpoof">OK</span></div>
  <div class="dbg-row"><span>signal</span><span class="dbg-val" id="dbgSignal">---</span></div>
  <div class="dbg-row"><span>screen</span><span class="dbg-val" id="dbgScreen">ON</span></div>
  <div class="dbg-row"><span>prox</span><span class="dbg-val" id="dbgProx">---</span></div>
  <div class="dbg-row"><span>score</span><span class="dbg-val" id="dbgScore">0</span></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
var data=""" + geojson + """;
var stats=""" + stats_json + """;
var INIT_STATE=""" + state_json + """;
var REFRESH_MS=""" + str(int(os.environ.get("REFRESH_INTERVAL_MS", "10000"))) + """;
var _lastGoodDataTime=Date.now();
var _signalLost=false;
var _alertStop=null;

/* DEDUPE: cache last rendered values to skip redundant DOM updates */
var _lastRender={label_primary:null,mode:null,level:null,signal_quality:null,network_type:null,battery:null,charging:null,screen_state:null,since_sec:null,score:null};

var pts=data.filter(function(p){return p.lat!=null&&p.lng!=null&&isFinite(p.lat)&&isFinite(p.lng)});
console.log('[Tracker v5] ONE PLACE RULE', pts.length, 'puntos');

var initCenter=[-31.65,-60.71],initZoom=16;
if(pts.length>0){var lp=pts[pts.length-1];if(isFinite(lp.lat)&&isFinite(lp.lng))initCenter=[lp.lat,lp.lng]}
var map=L.map('map',{zoomControl:true,attributionControl:false,center:initCenter,zoom:initZoom});
var darkTile=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:22});
var satTile=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:22});
var satLabels=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',{maxZoom:22});
darkTile.addTo(map);
var mapMode='standard';
function toggleMapMode(){if(mapMode==='standard'){map.removeLayer(darkTile);satTile.addTo(map);satLabels.addTo(map);mapMode='satellite'}else{map.removeLayer(satTile);map.removeLayer(satLabels);darkTile.addTo(map);mapMode='standard'}var b=document.getElementById('btnSatellite');if(b)b.classList.toggle('active',mapMode==='satellite')}

L.circle([-31.6366,-60.7012],{radius:150,color:'#2a2a2a',fillColor:'#007aff',fillOpacity:.03,weight:1,opacity:.12}).addTo(map);
L.circle([-31.64693,-60.71598],{radius:150,color:'#2a2a2a',fillColor:'#34c759',fillOpacity:.03,weight:1,opacity:.12}).addTo(map);
map.invalidateSize();

var clusterGroup=L.markerClusterGroup({maxClusterRadius:50,spiderfyOnMaxZoom:true,disableClusteringAtZoom:17,chunkedLoading:true});
pts.forEach(function(p,i){if(!isFinite(p.lat)||!isFinite(p.lng))return;var c=i===0?'#34c759':(i===pts.length-1?'#007aff':'#555'),r=i===0||i===pts.length-1?6:4;var m=L.circleMarker([p.lat,p.lng],{radius:r,fillColor:c,color:'rgba(255,255,255,.12)',weight:1,opacity:.35,fillOpacity:.35});m.bindPopup('<b>#'+(i+1)+'</b>'+(p.speed_kmh!==undefined?'<br>'+p.speed_kmh.toFixed(1)+' km/h':'')+'<br>'+new Date(p.timestamp).toLocaleString('es-AR'));clusterGroup.addLayer(m)});
map.addLayer(clusterGroup);

var liveMarker=null;
function updateLiveMarker(lat,lng,speed){if(!isFinite(lat)||!isFinite(lng))return;if(liveMarker)map.removeLayer(liveMarker);var sHtml=speed>1?'<div class="live-speed">'+Math.round(speed)+' km/h</div>':'';liveMarker=L.marker([lat,lng],{icon:L.divIcon({className:'',html:'<div class="live-marker"><div class="live-dot"></div>'+sHtml+'</div>',iconSize:[40,40],iconAnchor:[20,20]}),zIndexOffset:10000}).addTo(map)}
if(pts.length>0){var last=pts[pts.length-1];updateLiveMarker(last.lat,last.lng,last.speed_kmh||0)}
window.__tracker={map:map,pts:pts,clusterGroup:clusterGroup,liveMarker:liveMarker,lastPointCount:pts.length};

/* ================================================================
   RENDER v5 — ONE PLACE RULE + DEDUPE + UI PRIORITY STACK
   ================================================================
   RULES:
     - SOLE source = state.location.label_primary (ONE PLACE RULE)
     - PROHIBITED: rendering location.place, activity.status, zone.label
     - DEDUPE: skip DOM update if value unchanged
     - NO N/A, NO double %%, NO emojis
   ================================================================ */
function _fmtSince(s){if(!s||s<=0)return'';var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);if(h>0)return'Hace '+h+'h '+m+'m';return'Hace '+m+'m'}

function render(state){
  if(!state)return;
  var L=state.location||{},M=state.movement||{},A=state.activity||{},N=state.network||{},D=state.device||{},S=state.spoof||{},P=state.proximity||{},G=state.ghostrail||{};

  /* 1. LOCATION — ONE PLACE RULE: label_primary is the SOLE place */
  var lp=L.label_primary||'Sin ubicacion';
  if(lp!==_lastRender.label_primary){
    var el=document.getElementById('labelPrimary');
    if(el){
      el.textContent=lp;
      /* Color by semantic category */
      var cls='label-primary '+(lp==='Casa'?'casa':lp==='Trabajo'?'trabajo':lp==='En ruta'?'movimiento':'inactivo');
      el.className=cls;
    }
    _lastRender.label_primary=lp;
  }

  /* Since */
  var stxt=_fmtSince(L.since_sec);
  if(L.since_sec!==_lastRender.since_sec){
    var si=document.getElementById('since');if(si)si.textContent=stxt;
    _lastRender.since_sec=L.since_sec;
  }

  /* 2. MOVEMENT — badge */
  if(M.mode!==_lastRender.mode){
    var mb=document.getElementById('modeBadge');
    if(mb){mb.textContent=M.mode||'STATIC';mb.className='mode-badge '+(M.mode||'static').toLowerCase()}
    _lastRender.mode=M.mode;
  }

  /* Speed inline (HIDDEN if STATIC) */
  var spEl=document.getElementById('speedInline');
  if(spEl){if(M.mode!=='STATIC'&&M.speed_kmh>1){spEl.style.display='inline';spEl.innerHTML=Math.round(M.speed_kmh)+'<span class="speed-unit">km/h</span>'}else{spEl.style.display='none'}}

  /* 3. ACTIVITY — level badge + score */
  if(A.level!==_lastRender.level){
    var lb=document.getElementById('levelBadge');
    if(lb){lb.textContent=A.level||'LOW';lb.className='level-badge '+(A.level||'low').toLowerCase()}
    _lastRender.level=A.level;
  }
  if(A.score!==_lastRender.score){
    var sc=A.score||0;
    var av=document.getElementById('actVal');if(av)av.textContent=sc;
    var ab=document.getElementById('actBar');if(ab){ab.style.width=sc+'%';ab.style.background=sc>=66?'#34c759':sc>=26?'#ff9500':'#8a8a8a'}
    _lastRender.score=sc;
  }

  /* 4. NETWORK + Signal quality */
  if(N.type!==_lastRender.network_type){
    var nv=document.getElementById('netVal');if(nv)nv.textContent=N.type||'DESCONOCIDA';
    var nd=document.getElementById('netDot');if(nd){nd.className='dot '+(N.type==='WIFI'?'green':N.type==='4G'?'orange':N.type==='5G'?'blue':'gray')}
    _lastRender.network_type=N.type;
  }
  if(N.signal_quality!==_lastRender.signal_quality){
    var sq=document.getElementById('sqBadge');
    if(sq){var sqv=N.signal_quality||'NO_SIGNAL';sq.textContent=sqv.replace(/_/g,' ');sq.className='sq-badge '+sqv.toLowerCase()}
    _lastRender.signal_quality=N.signal_quality;
  }

  /* Battery + Screen — FIX double %% by stripping any stray % */
  var battNum=D.battery!=null?parseInt(String(D.battery).replace(/%/g,''),10):null;
  var battKey=''+battNum+'_'+D.charging;
  if(battKey!==_lastRender.battery){
    var bv=document.getElementById('battVal');
    if(bv){
      var bt=battNum!==null?battNum+'%':'---';
      if(D.charging)bt+=' (carga)';
      bv.textContent=bt;
    }
    var bd=document.getElementById('battDot');if(bd&&battNum!==null){bd.className='dot '+(battNum>50?'green':battNum>20?'orange':'red')}
    _lastRender.battery=battKey;
  }

  /* Screen indicator */
  if(A.screen_state!==_lastRender.screen_state){
    var sc2=document.getElementById('screenInd');if(sc2){sc2.className='screen-ind '+(A.screen_state==='ON'?'on':'off')}
    _lastRender.screen_state=A.screen_state;
  }

  /* GPS — show signal_quality (GOOD/WEAK/NO_SIGNAL), not generic "OK" */
  var gpsEl=document.getElementById('gpsRow');
  if(gpsEl){
    var sv=document.getElementById('gpsVal');
    if(sv){
      if(S.label!=='OK'){
        sv.textContent=S.label==='SUSPICIOUS'?'SOSPECHOSO':'ALTO RIESGO';
      }else{
        sv.textContent=N.signal_quality||'SIN SENAL';
      }
    }
    var gd=document.getElementById('gpsDot');if(gd){gd.className='dot '+(S.label==='OK'?(N.signal_quality==='GOOD'?'green':N.signal_quality==='WEAK'?'yellow':'red'):(S.risk>60?'red':'yellow'))}
    var so=document.getElementById('spoofOverlay');if(so){if(S.label==='HIGH_RISK')so.classList.add('active');else so.classList.remove('active')}
  }

  /* Proximity */
  var pr=document.getElementById('proxRow');
  if(pr){
    if(P.distance_m!=null){
      pr.style.display='flex';
      var pv=document.getElementById('proxVal');
      if(pv){pv.textContent=P.arrival==='ARRIVED'?'CASI LLEGAS - '+P.distance_m+'m':P.arrival==='APPROACHING'?'LLEGANDO - '+P.distance_m+'m':P.distance_m+'m a Casa'}
      pr.className='prox-row '+(P.arrival==='APPROACHING'?'approaching':P.arrival==='ARRIVED'?'arrived':'');
    }else{pr.style.display='none'}
  }

  /* GhostRail */
  var gr=document.getElementById('grRow');
  if(gr&&G.last_zones&&G.last_zones.length>0){gr.style.display='flex';var ghtml='';var zc={'Casa':'home','Trabajo':'work','En ruta':'transit'};G.last_zones.forEach(function(z){var cls=zc[z.name]||'other';var dur=z.min||0;var dt=dur>=60?Math.floor(dur/60)+'h '+Math.floor(dur%60)+'m':dur+'m';ghtml+='<span class="gr-item"><span class="gr-dot '+cls+'"></span>'+z.name+' <span class="gr-dur">'+dt+'</span></span>'});gr.innerHTML=ghtml}else if(gr){gr.style.display='none'}

  /* Events */
  var ep=document.getElementById('eventsPanel');var el=document.getElementById('eventsList');
  if(ep&&el&&state.events&&state.events.length>0){ep.style.display='block';var ehtml='';state.events.forEach(function(ev){var dc='zone';if(ev.type==='SPOOF')dc='spoof';else if(ev.type==='ARRIVAL')dc='arrival';else if(ev.type==='NETWORK')dc='network';else if(ev.type==='BATTERY')dc='battery';else if(ev.type==='ACTIVITY')dc='activity';ehtml+='<div class="event-item"><span class="event-dot '+dc+'"></span><span class="event-msg">'+ev.msg+'</span></div>'});el.innerHTML=ehtml}else if(ep){ep.style.display='none'}

  /* Live marker */
  if(L.lat!=null&&L.lng!=null)updateLiveMarker(L.lat,L.lng,M.speed_kmh||0);

  /* Toast for arrival / zone */
  if(state.events&&state.events.length>0){var latest=state.events[state.events.length-1];if(latest.type==='ARRIVAL'||latest.type==='ZONE'){_showToast(latest.msg)}if(latest.type==='ARRIVAL'){_playVoice(latest.msg)}}

  /* Debug panel */
  var h=function(id,val){var e=document.getElementById(id);if(e)e.textContent=val};
  h('dbgVer',state.meta&&state.meta.version||'v5');
  h('dbgSpeed',M.speed_kmh);h('dbgMode',M.mode);h('dbgLabel',L.label_primary);h('dbgSince',L.since_sec);
  h('dbgSpoof',S.label+' ('+S.risk+')');h('dbgSignal',N.signal_quality);h('dbgScreen',A.screen_state);
  h('dbgProx',P.arrival+' '+P.distance_m+'m');h('dbgScore',A.score);
}

function _showToast(msg){var t=document.getElementById('toast');if(t){t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none'},5000)}}
function _playVoice(text){if(_alertStop){_alertStop();_alertStop=null}try{if(!window.speechSynthesis)return;var stopped=false;var say=function(){if(stopped)return;var u=new SpeechSynthesisUtterance(text);u.lang='es-AR';u.rate=1;u.volume=.8;window.speechSynthesis.speak(u)};say();var iv=setInterval(function(){if(stopped){clearInterval(iv);return}say()},3500);var at=setTimeout(function(){if(!stopped){stopped=true;clearInterval(iv);window.speechSynthesis.cancel()}},10000);_alertStop=function(){if(stopped)return;stopped=true;clearInterval(iv);clearTimeout(at);window.speechSynthesis.cancel()}}catch(e){}}

render(INIT_STATE);

if(pts.length>0){var _lastTs=new Date(pts[pts.length-1].timestamp).getTime();setInterval(function(){var diff=Math.floor((Date.now()-_lastTs)/1000);var txt='';if(diff<60)txt='Hace '+diff+'s';else if(diff<3600)txt='Hace '+Math.floor(diff/60)+'m';else txt='Hace '+Math.floor(diff/3600)+'h';var el=document.getElementById('timeRow');if(el)el.textContent=txt},1000)}

document.addEventListener('keydown',function(e){if(e.key==='d'||e.key==='D'){var dp=document.getElementById('debugPanel');if(dp)dp.style.display=dp.style.display==='none'?'block':'none'}});

setInterval(function(){var elapsed=Date.now()-_lastGoodDataTime;if(elapsed>1500000&&!_signalLost){_signalLost=true;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.add('active')}if(elapsed<=1500000&&_signalLost){_signalLost=false;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.remove('active')}},5000);

setInterval(async function(){var t=window.__tracker;if(!t)return;try{var resp=await fetch('/points');if(!resp.ok)return;var body=await resp.json();if(!body.state)return;_lastGoodDataTime=Date.now();if(_signalLost){_signalLost=false;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.remove('active')}if(body.points&&body.points.length>t.lastPointCount){var newPts=body.points.filter(function(p){return isFinite(p.lat)&&isFinite(p.lng)});t.clusterGroup.clearLayers();newPts.forEach(function(p,i){if(!isFinite(p.lat)||!isFinite(p.lng))return;var c=i===0?'#34c759':'#555',r=i===0?6:4;var m=L.circleMarker([p.lat,p.lng],{radius:r,fillColor:c,color:'rgba(255,255,255,.12)',weight:1,opacity:.35,fillOpacity:.35});m.bindPopup('<b>#'+(i+1)+'</b>'+(p.speed_kmh!==undefined?'<br>'+p.speed_kmh.toFixed(1)+' km/h':'')+'<br>'+new Date(p.timestamp).toLocaleString('es-AR'));t.clusterGroup.addLayer(m)});t.pts=newPts;t.lastPointCount=newPts.length}render(body.state);document.title=(body.state.movement&&body.state.movement.mode!=='STATIC')?'EN MOVIMIENTO - Tracker':'Tracker';if(body.last_update){_lastTs=new Date(body.last_update).getTime()}}catch(e){console.warn('[Live] Error:',e.message)}},REFRESH_MS);

document.getElementById('btnCenter').onclick=function(){var t=window.__tracker;if(t&&t.map&&INIT_STATE.location)t.map.setView([INIT_STATE.location.lat,INIT_STATE.location.lng],17)};
document.getElementById('btnSatellite').onclick=toggleMapMode;
</script>
</body>
</html>"""
    with open(HTML_PATH, "w", encoding="utf-8", errors="replace") as f:
        f.write(html)
    logger.info("HTML v5 generado: %s (%d pts)", HTML_PATH, len(points))


# ------------------------------------------------------------
# HTTP SERVER
# ------------------------------------------------------------
_SERVER_START_TS = time.time()
_CURRENT_BATTERY = None
_CURRENT_ADDRESS = ""
_LAST_POLL_TIME = None
_LAST_POLL_LAT = None
_LAST_POLL_LNG = None
_CURRENT_CHARGING = ""
_BATTERY_HISTORY = []
_BATTERY_LIFE_ESTIMATE = "N/A"
_MAX_BATTERY_HISTORY = 30
_LAST_UPDATE = ""
_PREV_STATE = None


class TrackerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, fmt, *args):
        logger.info("HTTP %s - %s", self.client_address[0], fmt % args)

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/health/", "/healthz"):
            try:
                csv_exists = CSV_PATH.exists()
                html_exists = HTML_PATH.exists()
                point_count = 0
                if csv_exists: point_count = max(0, sum(1 for _ in open(CSV_PATH, encoding="utf-8")) - 1)
                self._send_json({"status": "ok", "uptime_s": round(time.time() - _SERVER_START_TS, 2), "base_dir": str(BASE_DIR), "html_exists": html_exists, "csv_exists": csv_exists, "points": point_count, "version": "v5", "timestamp": datetime.now(timezone.utc).isoformat()})
            except Exception as e:
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        if self.path in ("/points", "/points/"):
            try:
                pts = read_all_points() if CSV_PATH.exists() else []
                sts = compute_stats(pts) if pts else {}
                if _PREV_STATE is not None:
                    state = _PREV_STATE
                else:
                    speed = sts.get("current_speed_kmh", 0) or 0
                    raw = {"lat": pts[-1].get("lat") if pts else None, "lng": pts[-1].get("lng") if pts else None, "speed_kmh": speed, "battery": _CURRENT_BATTERY, "accuracy": None, "address": _CURRENT_ADDRESS or "", "charging": None, "timestamp": _LAST_UPDATE.isoformat() if _LAST_UPDATE else None}
                    state = build_state(raw, None)
                self._send_json({"points": pts, "stats": sts, "state": state, "last_update": _LAST_UPDATE.isoformat() if _LAST_UPDATE else None})
            except Exception as e:
                logger.error("/points error: %s", e)
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        if self.path in ("", "/"):
            self.send_response(302); self.send_header("Location", "/mapa.html"); self.end_headers(); return

        if self.path == "/cookies.html":
            self._serve_cookies_page(); return

        return super().do_GET()

    def do_POST(self):
        if self.path in ("/api/cookies", "/cookies"):
            self._handle_cookies_upload(); return
        self.send_response(404); self.end_headers()

    def _serve_cookies_page(self):
        html = """<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cookies - Tracker v5</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;background:#000;color:#fff;padding:20px;max-width:800px;margin:auto}h1{color:#007aff;font-size:22px;font-weight:700}ol li{margin:12px 0;line-height:1.6;color:#8a8a8a}strong{color:#fff}a{color:#007aff}textarea{width:100%;height:250px;background:rgba(255,255,255,.04);color:#34c759;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px;font-family:'SF Mono',Menlo,monospace;font-size:13px}button{background:#007aff;color:#fff;border:none;padding:12px 28px;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;margin-top:10px}button:hover{background:#0056b3}#status{margin-top:12px;padding:10px;border-radius:8px;display:none;font-size:14px}.ok{background:rgba(52,199,89,.1);color:#34c759;border:1px solid rgba(52,199,89,.2)}.err{background:rgba(255,59,48,.1);color:#ff3b30;border:1px solid rgba(255,59,48,.2)}</style></head><body><h1>Refrescar Cookies</h1><p style="color:#8a8a8a;margin-bottom:16px">Las cookies expiran cada ~7 dias.</p><ol><li>Instala <strong><a href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank">Cookie-Editor</a></strong></li><li>Anda a <a href="https://www.google.com/maps" target="_blank">Google Maps</a></li><li>Cookie-Editor > <strong>Export</strong> > <strong>JSON</strong></li><li>Pega abajo</li></ol><textarea id="jsonInput" placeholder="Pega el JSON..."></textarea><br><button onclick="enviarCookies()">Enviar</button><div id="status"></div><script>async function enviarCookies(){var s=document.getElementById('status');s.style.display='none';var txt=document.getElementById('jsonInput').value.trim();if(!txt){s.className='err';s.textContent='Pega el JSON';s.style.display='block';return}try{JSON.parse(txt)}catch(e){s.className='err';s.textContent='JSON invalido';s.style.display='block';return}var btn=document.querySelector('button');btn.disabled=true;btn.textContent='Enviando...';try{var r=await fetch('/api/cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:txt});var d=await r.json();if(r.ok){s.className='ok';s.textContent=d.message;document.getElementById('jsonInput').value=''}else{s.className='err';s.textContent=d.error}}catch(e){s.className='err';s.textContent='Error: '+e.message}s.style.display='block';btn.disabled=false;btn.textContent='Enviar'}</script></body></html>"""
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_cookies_upload(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            cookies = json.loads(body)
            if not isinstance(cookies, list): raise ValueError("Debe ser array")
            for c in cookies:
                if "name" not in c or "value" not in c: raise ValueError("Cada cookie debe tener name y value")
            COOKIES_PATH.write_text(json.dumps(cookies, indent=2), encoding="utf-8")
            logger.info("Cookies actualizadas: %d", len(cookies))
            self._send_json({"status": "ok", "message": f"{len(cookies)} cookies guardadas."})
        except Exception as e:
            self._send_json({"status": "error", "error": str(e)}, status=400)


class _ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _bind_server():
    last_err = None
    for port in HTTP_PORT_FALLBACKS:
        try:
            srv = _ReusableThreadingHTTPServer(("0.0.0.0", port), TrackerHandler)
            return srv, port
        except OSError as e:
            last_err = e
            continue
    return None, None


def start_http_server(stop_event):
    server, port = _bind_server()
    if server is None:
        logger.error("FATAL: servidor HTTP no arranco.")
        return None, None, None
    logger.info("Servidor en http://localhost:%d", port)
    def _serve():
        try: server.serve_forever(poll_interval=0.5)
        except Exception as e: logger.error("serve_forever: %s", e)
    t = threading.Thread(target=_serve, name="http-server", daemon=False)
    t.start()
    def _watch_stop():
        stop_event.wait()
        try: server.shutdown(); server.server_close()
        except Exception: pass
    threading.Thread(target=_watch_stop, name="http-stop-watcher", daemon=True).start()
    return server, port, t


def _find_chrome_exe():
    candidates = []
    if os.name == "nt":
        for base in [os.environ.get("PROGRAMFILES", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")]:
            if base: candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    else:
        candidates += [Path("/usr/bin/google-chrome"), Path("/usr/bin/chromium"), Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    for c in candidates:
        if c.exists(): return str(c)
    try:
        import shutil
        for name in ("chrome", "google-chrome"):
            found = shutil.which(name)
            if found: return found
    except Exception: pass
    return None


def _launch_chrome(url):
    if not FORCE_CHROME: return False
    chrome = _find_chrome_exe()
    if not chrome: return False
    try:
        import subprocess
        subprocess.Popen([chrome, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        return True
    except Exception: return False


def _open_browser_when_ready(port, stop_event):
    deadline = time.time() + 10
    url = f"http://localhost:{port}/mapa.html"
    while time.time() < deadline and not stop_event.is_set():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5): break
        except OSError: time.sleep(0.25)
    if not OPEN_BROWSER or stop_event.is_set(): return
    if _launch_chrome(url): return
    try: webbrowser.open_new_tab(url)
    except Exception: pass


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------
def main():
    setup_logging()
    logger.info("=" * 50)
    logger.info("Tracker v5 — ARCHITECTURE REAL CLEAN SPLIT")
    logger.info("=" * 50)
    logger.info("BASE_DIR = %s | Python = %s | PID = %d", BASE_DIR, sys.version.split()[0], os.getpid())

    os.chdir(str(BASE_DIR))
    init_csv()
    clean_old_points()

    stop_event = threading.Event()
    def signal_handler(sig, frame): logger.info("Senial %s, deteniendo...", sig); stop_event.set()
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig: 
            try: signal.signal(sig, signal_handler)
            except (AttributeError, ValueError): pass

    pts = read_all_points()
    stats = compute_stats(pts)
    try: generate_html(pts, stats, None)
    except Exception as e: logger.error("Error HTML inicial: %s", e)

    server, port, http_thread = start_http_server(stop_event)
    if server is None: return 2

    threading.Thread(target=_open_browser_when_ready, args=(port, stop_event), name="open-browser", daemon=True).start()

    backoff = 5
    while not stop_event.is_set():
        try:
            tracking_loop(stop_event)
            if stop_event.is_set(): break
            stop_event.wait(backoff); backoff = min(backoff * 2, 120)
        except Exception as e:
            logger.error("Error fatal: %s", e); backoff = min(backoff * 2, 120); stop_event.wait(backoff)

    if server:
        try: server.shutdown(); server.server_close()
        except Exception: pass
    logger.info("Tracker v5 detenido.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
