#!/usr/bin/env python3
"""
Tracker Map v5 — PRODUCTION HARDENED STATE ENGINE
Pipeline: raw -> build_state(raw, prev_state) -> state -> UI
Frontend: dumb renderer. Backend: intelligent inference engine.

STATE v5 Contract:
  meta:        timestamp, device_id, version
  location:    lat, lng, accuracy_m, place_label, geofence_id
  movement:    speed_kmh, motion_class, is_moving, confidence
  activity:    score_0_100, level, ui_status, stability_score
  connectivity:type, confidence
  device:      battery_pct, charging, screen_state
  spoof:       risk_score_0_100, classification, triggers[]
  proximity:   home_distance_m, arrival_state, arrival_mode
  ghostrail:   points_24h, clusters_max5
  events:      [{type, message, timestamp}]

Rules:
  - SINGLE SOURCE OF TRUTH = STATE OBJECT
  - frontend = render(state) ONLY
  - backend = inferencia + scoring + eventos
  - cero logica distribuida
  - cero calculos en JS
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

# ---- POI System ----
POI_LIST = [
    {"id": "home", "name": "Casa", "lat": HOME_ZONE_CENTER[0], "lng": HOME_ZONE_CENTER[1], "radius": HOME_ZONE_RADIUS_M},
    {"id": "work", "name": "Trabajo", "lat": WORK_ZONE_CENTER[0], "lng": WORK_ZONE_CENTER[1], "radius": WORK_ZONE_RADIUS_M},
]

# ---- Proximity targets (for arrival warnings) ----
PROXIMITY_TARGETS = [
    {"name": "Casa", "lat": HOME_ZONE_CENTER[0], "lng": HOME_ZONE_CENTER[1]},
    {"name": "Trabajo", "lat": WORK_ZONE_CENTER[0], "lng": WORK_ZONE_CENTER[1]},
]

HEADING_NAMES = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

# ---- Motion classification v5 thresholds ----
MOTION_STATIC_MAX = 1        # km/h
MOTION_WALK_MIN = 1          # km/h
MOTION_WALK_MAX = 6          # km/h
MOTION_MIX_MIN = 6           # km/h
MOTION_MIX_MAX = 25          # km/h
MOTION_CAR_MIN = 25          # km/h
MOTION_CAR_MAX = 120         # km/h
MOTION_ANOMALY_MIN = 120     # km/h - spoof trigger
MOTION_EMA_ALPHA = 0.7       # EMA smoothing factor
MOTION_BUS_STOP_THRESHOLD = 2  # stops needed for BUS detection
MOTION_BUS_MIN_AVG = 10      # km/h min average for BUS
MOTION_BUS_MAX_AVG = 60      # km/h max average for BUS

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
SCREEN_ON_THRESHOLD_S = 30  # updates within 30s = screen ON

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
    d = haversine_m(WORK_ZONE_CENTER[0], WORK_ZONE_CENTER[1], lat, lng)
    return d <= WORK_ZONE_RADIUS_M


def is_in_home_zone(lat, lng):
    if lat is None or lng is None:
        return False
    d = haversine_m(HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1], lat, lng)
    return d <= HOME_ZONE_RADIUS_M


def is_in_user_home_zone(lat, lng):
    if lat is None or lng is None:
        return False
    d = haversine_m(USER_HOME_CENTER[0], USER_HOME_CENTER[1], lat, lng)
    return d <= USER_HOME_RADIUS_M


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
            "total_distance_km": 0,
            "max_speed_kmh": 0,
            "avg_speed_kmh": 0,
            "total_time_s": 0,
            "stopped_time_s": 0,
            "moving_time_s": 0,
            "current_speed_kmh": 0,
            "current_heading": 0,
            "current_heading_name": "N/A",
            "current_state": "sin_datos",
        }

    total_dist = 0.0
    max_speed = 0.0
    stopped_s = 0.0
    speed_sum = 0.0
    speed_count = 0

    for i in range(1, len(points)):
        d = haversine_m(points[i - 1]["lat"], points[i - 1]["lng"], points[i]["lat"], points[i]["lng"])
        total_dist += d
        spd = float(points[i].get("speed_kmh", 0))
        if spd > 120:
            spd = 0.0
        if spd > max_speed:
            max_speed = spd
        if spd > 0:
            speed_sum += spd
            speed_count += 1

    try:
        t0 = datetime.fromisoformat(points[0]["timestamp"])
        t1 = datetime.fromisoformat(points[-1]["timestamp"])
        total_s = (t1 - t0).total_seconds()
    except Exception:
        total_s = 0

    if total_s > 0 and speed_count > 0:
        for i in range(1, len(points)):
            try:
                ta = datetime.fromisoformat(points[i - 1]["timestamp"])
                tb = datetime.fromisoformat(points[i]["timestamp"])
                seg_s = (tb - ta).total_seconds()
                if points[i]["speed_kmh"] < 1.0:
                    stopped_s += seg_s
            except Exception:
                pass

    last = points[-1]
    current_speed = float(last.get("speed_kmh", 0)) if last.get("speed_kmh") is not None else 0.0
    if current_speed > 120:
        current_speed = 0.0
    hdg_name = heading_name(last["heading"]) if last["heading"] is not None else "N/A"

    return {
        "total_distance_km": round(total_dist / 1000, 3),
        "max_speed_kmh": round(max_speed, 1),
        "avg_speed_kmh": round(speed_sum / speed_count, 1) if speed_count > 0 else 0,
        "total_time_s": int(total_s),
        "stopped_time_s": int(stopped_s),
        "moving_time_s": int(total_s - stopped_s),
        "current_speed_kmh": round(current_speed, 1),
        "current_heading": last["heading"],
        "current_heading_name": hdg_name,
        "current_state": last["movement_state"],
    }


# ════════════════════════════════════════════════════════════════
# STATE ENGINE v5 — PRODUCTION HARDENED (SOURCE OF TRUTH)
# ════════════════════════════════════════════════════════════════

def _classify_zone(lat, lng, speed):
    """Clasificador de zonas v5. POI priority: HOME > WORK > TRANSIT > IDLE."""
    if lat is None or lng is None:
        return "IDLE", None

    # Check POI list in priority order
    for poi in POI_LIST:
        d = haversine_m(poi["lat"], poi["lng"], lat, lng)
        if d <= poi["radius"]:
            return poi["id"].upper(), poi["id"]

    if speed > 3:
        return "TRANSIT", None

    return "IDLE", None


def _classify_motion_v5(speed, prev_state):
    """
    Motion classification v5.
    0-1      STATIC
    1-6      WALK
    6-25     MIX (BUS/WALK ambiguous)
    25-120   CAR
    120+     ANOMALY -> spoof trigger

    Returns: (motion_class, smoothed_speed, confidence)
    """
    # Get smoothed speed via EMA
    if prev_state and "_internal" in prev_state:
        prev_smooth = prev_state["_internal"].get("motion_speed_smooth", 0)
    else:
        prev_smooth = 0

    # EMA smoothing
    smooth = speed * MOTION_EMA_ALPHA + prev_smooth * (1 - MOTION_EMA_ALPHA)

    # Check for BUS pattern: stops in speed history
    is_bus = False
    confidence = 0.5
    if prev_state and "_internal" in prev_state:
        speed_history = prev_state["_internal"].get("speed_history", [])
        if len(speed_history) >= 5:
            recent = speed_history[-10:]
            stops = sum(1 for s in recent if s < 1)
            avg_speed = sum(recent) / len(recent)
            if stops >= MOTION_BUS_STOP_THRESHOLD and MOTION_BUS_MIN_AVG <= avg_speed <= MOTION_BUS_MAX_AVG:
                is_bus = True
                confidence = 0.7

    # Classify based on smoothed speed
    if smooth < MOTION_STATIC_MAX:
        motion_class = "STATIC"
        confidence = 0.9
    elif smooth <= MOTION_WALK_MAX:
        motion_class = "WALK"
        confidence = 0.8
    elif smooth <= MOTION_MIX_MAX:
        if is_bus:
            motion_class = "BUS"
            confidence = 0.6
        else:
            motion_class = "MIX"
            confidence = 0.4
    elif smooth <= MOTION_CAR_MAX:
        motion_class = "CAR"
        confidence = 0.85
    else:
        motion_class = "ANOMALY"
        confidence = 0.95

    # Adjust confidence by accuracy and stability
    if prev_state:
        stability = prev_state.get("activity", {}).get("stability_score", 1.0)
        confidence = confidence * 0.7 + stability * 0.3
        confidence = max(0.1, min(1.0, confidence))

    return motion_class, round(smooth, 2), round(confidence, 2)


def _compute_activity_score_v5(speed, zone, gps_stability, device_context):
    """
    Activity score v5: deterministic 0-100.

    40% movement score
    25% zone relevance
    20% GPS stability
    15% device context
    """
    score = 0

    # 40% Movement (0-40)
    if speed > 5:
        score += 40
    elif speed > 1:
        score += 20
    elif speed > 0.5:
        score += 5

    # 25% Zone relevance (0-25)
    if zone == "WORK":
        score += 25
    elif zone == "TRANSIT":
        score += 20
    elif zone == "HOME":
        score += 15

    # 20% GPS stability (0-20)
    score += gps_stability * 20

    # 15% Device context (0-15)
    battery_pct = device_context.get("battery_pct", 50)
    charging = device_context.get("charging", False)
    if charging:
        score += 10
    else:
        score += (battery_pct / 100) * 10
    # Screen ON bonus
    if device_context.get("screen_on", False):
        score += 5

    return max(0, min(100, round(score)))


def _compute_activity_level(score):
    """0-25 LOW, 26-65 MEDIUM, 66-100 HIGH."""
    if score <= 25:
        return "LOW"
    elif score <= 65:
        return "MEDIUM"
    return "HIGH"


def _compute_ui_status(zone):
    """Zone -> UI status mapping. No 'EN' prefix."""
    return {
        "HOME": "CASA",
        "WORK": "TRABAJO",
        "TRANSIT": "MOVIMIENTO",
        "IDLE": "INACTIVO",
    }.get(zone, "INACTIVO")


def _compute_stability_v5(prev_state, speed, accuracy):
    """
    Stability score v5: anti-jitter, considers speed delta + GPS accuracy.
    Returns 0.0-1.0
    """
    if not prev_state:
        return 1.0

    prev_speed = prev_state.get("movement", {}).get("speed_kmh", 0)
    speed_diff = abs(speed - prev_speed)
    speed_stability = max(0, 1 - (speed_diff / 15))

    # GPS accuracy factor
    if accuracy > 0:
        acc_factor = max(0, 1 - (accuracy / 200))
    else:
        acc_factor = 0.5

    return round(max(0, min(1, speed_stability * 0.6 + acc_factor * 0.4)), 2)


def _detect_spoof_v5(lat, lng, speed, accuracy, stability, prev_state):
    """
    Anti-Spoof v5 — Bayesian probabilistic scoring with triggers.

    Returns: {risk_score_0_100, classification, triggers: []}
    Classification: OK (0-39) / SUSPICIOUS (40-69) / HIGH_RISK (70-100)
    """
    risk = 0
    triggers = []

    if not prev_state:
        return {"risk_score_0_100": 0, "classification": "OK", "triggers": []}

    prev_loc = prev_state.get("location", {})
    prev_lat = prev_loc.get("lat")
    prev_lng = prev_loc.get("lng")
    prev_speed = prev_state.get("movement", {}).get("speed_kmh", 0)
    prev_zone = prev_state.get("activity", {}).get("zone", "IDLE")

    # 1. Impossible speed: large distance but low reported speed
    if prev_lat is not None and prev_lng is not None and lat is not None and lng is not None:
        dist = haversine_m(prev_lat, prev_lng, lat, lng)
        if dist > 2000 and speed < 5:
            risk += SPOOF_WEIGHT_VELOCITY
            triggers.append("impossible_speed")
        elif dist > 500 and speed < 2:
            risk += SPOOF_WEIGHT_VELOCITY * 0.7
            triggers.append("impossible_speed_moderate")

        # 5. Absurd acceleration
        if prev_speed < 2 and speed > 60:
            risk += SPOOF_WEIGHT_ACCEL
            triggers.append("absurd_acceleration")
        elif abs(speed - prev_speed) > 50:
            risk += SPOOF_WEIGHT_ACCEL * 0.7
            triggers.append("acceleration_spike")

    # 2. GPS jitter (low accuracy / high variance)
    if accuracy > 0:
        if accuracy > 200:
            risk += SPOOF_WEIGHT_JITTER
            triggers.append("gps_jitter_high")
        elif accuracy > 100:
            risk += SPOOF_WEIGHT_JITTER * 0.5
            triggers.append("gps_jitter_moderate")

    # Stability-based jitter
    if stability < 0.3:
        risk += SPOOF_WEIGHT_JITTER * 0.3
        triggers.append("stability_low")

    # 3. Network inconsistency: accuracy suggests WIFI but fast movement
    if accuracy > 0 and accuracy <= 30 and speed > 40:
        risk += SPOOF_WEIGHT_NETWORK
        triggers.append("network_inconsistency")
    elif accuracy > 150 and speed < 0.5:
        risk += SPOOF_WEIGHT_NETWORK * 0.3
        triggers.append("network_accuracy_mismatch")

    # 4. Impossible zone jump: HOME to WORK without transit
    if prev_zone == "HOME" and lat is not None and lng is not None:
        current_zone, _ = _classify_zone(lat, lng, speed)
        if current_zone == "WORK" and prev_speed < 3:
            risk += SPOOF_WEIGHT_ZONE_JUMP
            triggers.append("geofence_jump_impossible")

    # 6. Repetitive patterns: same coords but speed > 0
    if prev_lat is not None and prev_lng is not None and lat is not None and lng is not None:
        dist = haversine_m(prev_lat, prev_lng, lat, lng)
        if dist < 1 and speed > 0:
            risk += SPOOF_WEIGHT_PATTERN
            triggers.append("repetition_pattern")

    # 120+ km/h = ANOMALY = spoof trigger
    if speed > MOTION_ANOMALY_MIN:
        risk += SPOOF_WEIGHT_VELOCITY
        triggers.append("speed_anomaly")

    risk = min(100, risk)

    # Classification
    if risk >= SPOOF_HIGH_RISK_THRESHOLD:
        classification = "HIGH_RISK"
    elif risk >= SPOOF_SUSPICIOUS_THRESHOLD:
        classification = "SUSPICIOUS"
    else:
        classification = "OK"

    return {"risk_score_0_100": risk, "classification": classification, "triggers": triggers}


def _detect_connectivity_v5(accuracy, speed, charging):
    """
    Connectivity inference v5.

    WIFI:  alta estabilidad GPS + baja movilidad
    4G:   movilidad media + jitter moderado
    5G:   alta precision + movilidad
    UNKNOWN: fallback
    """
    if accuracy is None or accuracy <= 0:
        return {"type": "UNKNOWN", "confidence": 0.0}

    if accuracy <= 20 and speed < 5:
        return {"type": "WIFI", "confidence": 0.8}
    elif accuracy <= 30 and speed < 10:
        return {"type": "WIFI", "confidence": 0.6}
    elif accuracy <= 50 and speed > 5:
        return {"type": "5G", "confidence": 0.5}
    elif accuracy <= 100 and speed > 3:
        return {"type": "4G", "confidence": 0.7}
    elif accuracy > 100:
        return {"type": "4G", "confidence": 0.6}

    return {"type": "UNKNOWN", "confidence": 0.2}


def _infer_screen_state(prev_state, timestamp):
    """
    Screen state inference.
    ON  -> si hay updates recientes (<30s)
    OFF -> si no hay movimiento + no polling activo
    """
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

    # Check if moving
    is_moving = prev_state.get("movement", {}).get("is_moving", False)
    if is_moving:
        return "ON"

    return "OFF"


def _infer_place_label_v5(zone, geofence_id, address, lat, lng):
    """
    Place label v5: POI priority system.
    HOME > WORK > POI > TRANSIT
    """
    # Known zones first
    if zone == "HOME":
        return "Casa"
    if zone == "WORK":
        return "Trabajo"

    # Check POI list
    if geofence_id:
        for poi in POI_LIST:
            if poi["id"] == geofence_id:
                return poi["name"]

    # If there's an address from RPC
    if address:
        parts = address.split(",")
        label = parts[0].strip()
        if label:
            return label

    # Reverse geocoding fallback (lazy, cached)
    if lat is not None and lng is not None:
        place = _reverse_geocode_cached(lat, lng)
        if place:
            return place

    if zone == "TRANSIT":
        return "En ruta"

    return "Sin ubicacion"


def _reverse_geocode_cached(lat, lng):
    """Reverse geocode con cache. Solo consulta si no hay cache."""
    key = (round(lat, 4), round(lng, 4))
    if key in _NOMINATIM_CACHE:
        return _NOMINATIM_CACHE[key]
    try:
        url = (
            f"https://nominatim.openstreetmap.org/reverse?"
            f"format=jsonv2&lat={lat}&lon={lng}&zoom=18"
            f"&accept-language=es&addressdetails=1"
        )
        req = urllib.request.Request(url, headers={
            "User-Agent": "STracker/5.0",
        })
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


def _compute_proximity_v5(lat, lng, motion_class):
    """
    Proximity v5: arrival engine.

    CAR MODE:  300m -> APPROACHING "LLEGANDO", 200m -> ARRIVED "CASI LLEGAS"
    WALK MODE: 200m -> APPROACHING "LLEGANDO"

    Returns: {home_distance_m, arrival_state, arrival_mode}
    arrival_state: NONE / APPROACHING / ARRIVED
    arrival_mode: CAR / WALK
    """
    result = {
        "home_distance_m": None,
        "arrival_state": "NONE",
        "arrival_mode": None,
    }

    if lat is None or lng is None:
        return result

    # Check proximity to home
    home_dist = haversine_m(lat, lng, HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1])
    result["home_distance_m"] = round(home_dist)

    # Determine arrival mode based on motion class
    if motion_class in ("CAR",):
        result["arrival_mode"] = "CAR"
        if home_dist <= ARRIVAL_CAR_CLOSE_M:
            result["arrival_state"] = "ARRIVED"
        elif home_dist <= ARRIVAL_CAR_APPROACH_M:
            result["arrival_state"] = "APPROACHING"
    elif motion_class in ("WALK", "BUS", "MIX"):
        result["arrival_mode"] = "WALK"
        if home_dist <= ARRIVAL_WALK_APPROACH_M:
            result["arrival_state"] = "APPROACHING"

    return result


def _compute_ghostrail_v5(prev_state, lat, lng, speed, zone):
    """GhostRail v5: last 24h simplified, cluster by zone, max 5 nodes."""
    zone_labels = {"HOME": "Casa", "WORK": "Trabajo", "TRANSIT": "En ruta", "IDLE": "Otro"}
    zone_label = zone_labels.get(zone, "Otro")

    if not prev_state:
        return {
            "points_24h": 1,
            "clusters_max5": [{"name": zone_label, "duration_min": 1}],
        }

    prev = prev_state.get("ghostrail", {})
    clusters = list(prev.get("clusters_max5", []))
    points_24h = prev.get("points_24h", 0) + 1

    # Update zone clusters (incremental)
    found = False
    for c in clusters:
        if c["name"] == zone_label:
            c["duration_min"] = c.get("duration_min", 0) + 1
            found = True
            break
    if not found:
        clusters.insert(0, {"name": zone_label, "duration_min": 1})

    # Keep max 5
    clusters = clusters[:5]

    return {
        "points_24h": points_24h,
        "clusters_max5": clusters,
    }


def build_state(raw, prev_state=None):
    """
    STATE ENGINE v5 — unico punto de construccion de estado.
    Frontend SOLO lee lo que sale de aqui.

    Pipeline:
      1.  Meta layer
      2.  Movement layer (EMA smoothing, motion classification)
      3.  Zone classification (POI system)
      4.  Connectivity inference
      5.  Anti-spoof Bayesian v5
      6.  GhostRail v5
      7.  Activity score + level
      8.  Proximity engine
      9.  Screen state
      10. Place label
      11. Events FIFO
      12. Final state object
    """
    lat = raw.get("lat")
    lng = raw.get("lng")
    speed = float(raw.get("speed_kmh") or 0)
    battery = raw.get("battery")
    accuracy = float(raw.get("accuracy") or 0)
    address = raw.get("address") or ""
    charging = raw.get("charging") or False
    timestamp = raw.get("timestamp")
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── 1. META ──
    meta = {
        "timestamp": now_iso,
        "device_id": "sofi",
        "version": "v5",
    }

    # ── 2. MOVEMENT LAYER ──
    motion_class, smoothed_speed, motion_confidence = _classify_motion_v5(speed, prev_state)
    is_moving = speed > 1

    # ── 3. ZONE CLASSIFICATION ──
    zone, geofence_id = _classify_zone(lat, lng, speed)

    # ── 4. CONNECTIVITY ──
    connectivity = _detect_connectivity_v5(accuracy, speed, charging)

    # ── 5. ANTI-SPOOF v5 ──
    gps_stability = _compute_stability_v5(prev_state, speed, accuracy)
    spoof = _detect_spoof_v5(lat, lng, speed, accuracy, gps_stability, prev_state)

    # If HIGH_RISK, log critical event
    if spoof["classification"] == "HIGH_RISK":
        logger.warning("SPOOF HIGH_RISK detected! score=%d triggers=%s",
                       spoof["risk_score_0_100"], spoof["triggers"])

    # ── 6. GHOSTRAIL v5 ──
    ghostrail = _compute_ghostrail_v5(prev_state, lat, lng, speed, zone)

    # ── 7. ACTIVITY SCORE + LEVEL ──
    battery_pct = 50
    if battery is not None:
        try:
            battery_pct = int(str(battery).replace("%", ""))
        except (ValueError, TypeError):
            pass

    screen_on = _infer_screen_state(prev_state, timestamp) == "ON"

    device_context = {
        "battery_pct": battery_pct,
        "charging": bool(charging),
        "screen_on": screen_on,
    }

    activity_score = _compute_activity_score_v5(
        speed=speed,
        zone=zone,
        gps_stability=gps_stability,
        device_context=device_context,
    )
    activity_level = _compute_activity_level(activity_score)
    ui_status = _compute_ui_status(zone)

    # ── 8. PROXIMITY ENGINE ──
    proximity = _compute_proximity_v5(lat, lng, motion_class)

    # ── 9. SCREEN STATE ──
    screen_state = _infer_screen_state(prev_state, timestamp)

    # ── 10. PLACE LABEL ──
    place_label = _infer_place_label_v5(zone, geofence_id, address, lat, lng)

    # ── 11. EVENTS FIFO ──
    events = list(prev_state.get("events", [])) if prev_state else []
    now_ts = now_iso

    # Activity spike
    if prev_state:
        prev_score = prev_state.get("activity", {}).get("score_0_100", 0)
        if abs(activity_score - prev_score) > 30:
            events.append({
                "type": "ACTIVITY_SPIKE",
                "message": f"Actividad {prev_score}% -> {activity_score}%",
                "timestamp": now_ts,
            })

    # Zone change
    if prev_state:
        prev_zone = prev_state.get("activity", {}).get("zone", "")
        if prev_zone and prev_zone != zone:
            zone_labels = {"HOME": "Casa", "WORK": "Trabajo", "TRANSIT": "En ruta", "IDLE": "Otro"}
            events.append({
                "type": "ZONE_CHANGE",
                "message": f"{zone_labels.get(prev_zone, prev_zone)} -> {zone_labels.get(zone, zone)}",
                "timestamp": now_ts,
            })

    # Spoof warning
    if spoof["classification"] == "HIGH_RISK":
        events.append({
            "type": "SPOOF_WARNING",
            "message": f"Riesgo GPS alto ({spoof['risk_score_0_100']}%)",
            "timestamp": now_ts,
        })
    elif spoof["classification"] == "SUSPICIOUS":
        events.append({
            "type": "SPOOF_WARNING",
            "message": f"GPS sospechoso ({spoof['risk_score_0_100']}%)",
            "timestamp": now_ts,
        })

    # Network change
    if prev_state:
        prev_net = prev_state.get("connectivity", {}).get("type", "UNKNOWN")
        if prev_net != connectivity["type"] and connectivity["type"] != "UNKNOWN":
            events.append({
                "type": "NETWORK_CHANGE",
                "message": f"{prev_net} -> {connectivity['type']}",
                "timestamp": now_ts,
            })

    # Battery drop
    if prev_state and battery is not None:
        prev_batt = prev_state.get("device", {}).get("battery_pct")
        if prev_batt is not None:
            delta = battery_pct - prev_batt
            if delta < -10:
                events.append({
                    "type": "BATTERY_DROP",
                    "message": f"Bateria {prev_batt}% -> {battery_pct}%",
                    "timestamp": now_ts,
                })

    # Arrival events
    if proximity["arrival_state"] == "ARRIVED":
        events.append({
            "type": "ARRIVAL_CASI",
            "message": f"CASI LLEGAS a Casa ({proximity['home_distance_m']}m)",
            "timestamp": now_ts,
        })
    elif proximity["arrival_state"] == "APPROACHING":
        events.append({
            "type": "ARRIVAL_LLEGANDO",
            "message": f"LLEGANDO a Casa ({proximity['home_distance_m']}m)",
            "timestamp": now_ts,
        })

    # Trim events to FIFO max
    events = events[-MAX_EVENTS:]

    # ── Speed history for BUS/COLECTIVO detection ──
    speed_history = []
    if prev_state and "_internal" in prev_state:
        speed_history = list(prev_state["_internal"].get("speed_history", []))
    speed_history.append(speed)
    if len(speed_history) > 20:
        speed_history = speed_history[-20:]

    # ── FINAL STATE OBJECT v5 ──
    state = {
        "meta": meta,
        "location": {
            "lat": lat,
            "lng": lng,
            "accuracy_m": accuracy if accuracy else None,
            "place_label": place_label,
            "geofence_id": geofence_id,
        },
        "movement": {
            "speed_kmh": round(speed, 1),
            "motion_class": motion_class,
            "is_moving": is_moving,
            "confidence": motion_confidence,
        },
        "activity": {
            "score_0_100": activity_score,
            "level": activity_level,
            "ui_status": ui_status,
            "stability_score": gps_stability,
        },
        "connectivity": {
            "type": connectivity["type"],
            "confidence": round(connectivity["confidence"], 2),
        },
        "device": {
            "battery_pct": battery_pct,
            "charging": bool(charging),
            "screen_state": screen_state,
        },
        "spoof": {
            "risk_score_0_100": spoof["risk_score_0_100"],
            "classification": spoof["classification"],
            "triggers": spoof["triggers"],
        },
        "proximity": proximity,
        "ghostrail": ghostrail,
        "events": events,
        # Internal state (not for frontend)
        "_internal": {
            "motion_speed_smooth": smoothed_speed,
            "speed_history": speed_history,
            "zone": zone,
        },
    }

    return state


# ------------------------------------------------------------
# PLAYWRIGHT TRACKING (unchanged)
# ------------------------------------------------------------
def _check_profile_lock():
    candidates = [
        PROFILE_DIR / "SingletonLock",
        PROFILE_DIR / "SingletonCookie",
        PROFILE_DIR / "lockfile",
    ]
    locks = [p for p in candidates if p.exists()]
    if locks:
        logger.warning(
            "Profile lock detectado: %s. "
            "Si no hay otro Chrome abierto, borra estos archivos y reintenta.",
            ", ".join(str(p.name) for p in locks),
        )


def _load_cookie_header():
    """Carga cookies.json y devuelve header Cookie listo para usar."""
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
    logger.warning("No se pudieron obtener cookies por ningun metodo.")
    return False


def _read_cookies_from_sqlite(db_path):
    import sqlite3
    if not db_path.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{db_path}?immutable=1", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT host_key, name, value, path, is_secure, is_httponly, "
            "has_expires, expires_utc, samesite "
            "FROM cookies WHERE host_key LIKE ?",
            ("%.google.com",)
        )
        rows = cur.fetchall()
        conn.close()
        if not rows or len(rows) < 5:
            return False
        CHROME_EPOCH_DELTA = 11644473600000000
        normalized = []
        for row in rows:
            entry = {
                "name": row["name"],
                "value": row["value"],
                "domain": row["host_key"],
                "path": row["path"],
                "secure": bool(row["is_secure"]),
                "httpOnly": bool(row["is_httponly"]),
                "sameSite": _chrome_same_site(row["samesite"]) if "samesite" in row else "no_restriction",
                "hostOnly": row["host_key"].startswith(".") is False,
            }
            if row["has_expires"] and row["expires_utc"]:
                ts = (row["expires_utc"] - CHROME_EPOCH_DELTA) / 1_000_000
                if ts > 0:
                    entry["expirationDate"] = round(ts, 6)
            normalized.append(entry)
        COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
        logger.info("Cookies actualizadas via SQLite: %d cookies.", len(normalized))
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
            if not pages:
                continue
            try:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as pw:
                    browser = pw.chromium.connect_over_cdp(f"http://localhost:{port}")
                    context = browser.contexts[0] if browser.contexts else browser.new_context()
                    cookies = context.cookies()
                    google_cookies = [c for c in cookies if "google.com" in c.get("domain", "")]
                    if google_cookies:
                        normalized = []
                        for c in google_cookies:
                            entry = {
                                "name": c["name"], "value": c["value"],
                                "domain": c.get("domain", ""), "path": c.get("path", "/"),
                                "secure": c.get("secure", False),
                                "httpOnly": c.get("httpOnly", False),
                                "sameSite": c.get("sameSite", "no_restriction"),
                                "hostOnly": c.get("domain", "").startswith(".") is False,
                            }
                            if "expires" in c and c["expires"]:
                                entry["expirationDate"] = c["expires"]
                            normalized.append(entry)
                        COOKIES_PATH.write_text(_json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
                        logger.info("Cookies actualizadas via CDP: %d cookies.", len(normalized))
                        browser.close()
                        return True
                    browser.close()
            except ImportError:
                pass
        except Exception:
            continue
    return False


def _read_cookies_via_playwright_headless():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    try:
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(
                str(PROFILE_DIR),
                headless=True,
                no_viewport=True,
                locale="es-AR",
                args=["--disable-blink-features=AutomationControlled"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://www.google.com/maps", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(5000)
            cookies = context.cookies()
            google_cookies = [c for c in cookies if "google.com" in c.get("domain", "")]
            if google_cookies and len(google_cookies) > 5:
                normalized = []
                for c in google_cookies:
                    entry = {
                        "name": c["name"], "value": c["value"],
                        "domain": c.get("domain", ""), "path": c.get("path", "/"),
                        "secure": c.get("secure", False),
                        "httpOnly": c.get("httpOnly", False),
                        "sameSite": c.get("sameSite", "no_restriction"),
                        "hostOnly": c.get("domain", "").startswith(".") is False,
                    }
                    if "expires" in c and c["expires"]:
                        entry["expirationDate"] = c["expires"]
                    normalized.append(entry)
                COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
                logger.info("Cookies actualizadas via Playwright headless: %d cookies.", len(normalized))
                context.close()
                return True
            context.close()
    except Exception as e:
        logger.debug("Playwright headless fallo: %s", e)
    return False


def _extract_coords_from_json(obj, depth=0):
    if depth > 10 or obj is None:
        return None
    if isinstance(obj, list):
        if len(obj) == 2 and all(isinstance(x, (int, float)) for x in obj):
            a, b = float(obj[0]), float(obj[1])
            if -90 <= a <= 90 and -180 <= b <= 180 and abs(a) > 1 and abs(b) > 1:
                return (a, b)
            if -180 <= a <= 180 and -90 <= b <= 90 and abs(a) > 1 and abs(b) > 1:
                return (b, a)
        for item in obj:
            r = _extract_coords_from_json(item, depth + 1)
            if r:
                return r
    elif isinstance(obj, dict):
        for v in obj.values():
            r = _extract_coords_from_json(v, depth + 1)
            if r:
                return r
    return None


def _fetch_location(cookie_header):
    """Scrapea ubicacion desde Google Maps via RPC + HTML."""
    import urllib.request, urllib.error, json as _json

    # ---- INTENTO 1: RPC DIRECTA ----
    try:
        req = urllib.request.Request(
            LOCATIONSHARING_URL,
            headers={
                "Cookie": cookie_header,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.google.com/maps",
                "X-Goog-AuthUser": "0",
            },
        )
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
        if m:
            lng, lat = float(m.group(1)), float(m.group(2))
            found = (lat, lng)
        if not found:
            m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', text)
            if m:
                lng, lat = float(m.group(1)), float(m.group(2))
                found = (lat, lng)
        if not found:
            try:
                data = _json.loads(text)
                coords = _extract_coords_from_json(data)
                if coords:
                    found = coords
            except Exception:
                pass
        if found:
            lat, lng = found
            bat, address, accuracy, charging = _parse_rpc_details(text)
            return lat, lng, bat, address, accuracy, charging

    # ---- INTENTO 2: PAGINA HTML ----
    try:
        req = urllib.request.Request(
            GMAPS_SHARE_URL,
            headers={
                "Cookie": cookie_header,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.google.com/maps",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.warning("HTML fetch error: %s", e)
        return None, None, None, "", 0, 0

    m = re.search(r'\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]', html)
    if not m:
        m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', html)
    if not m:
        m2 = re.search(r'window\.APP_INITIALIZATION_STATE\s*=\s*([^;]+)', html)
        if m2:
            try:
                data = _json.loads(m2.group(1))
                coords = _extract_coords_from_json(data)
                if coords:
                    lat, lng = coords
                    m = True
            except Exception:
                pass

    if not m:
        logger.warning("No se encontraron coordenadas en RPC ni HTML")
        return None, None, None, "", 0, 0

    if isinstance(m, tuple):
        lat, lng = m
    else:
        lng = float(m.group(1))
        lat = float(m.group(2))

    bat, address, _, _ = _parse_rpc_details(html)
    return lat, lng, bat, address, 0, 0


def _parse_rpc_details(text):
    """Extrae bateria, direccion, accuracy y charging de una respuesta RPC."""
    bat = None
    bm = BAT_API_RE.search(text)
    if bm:
        try:
            pct = int(bm.group(1))
            if 1 <= pct <= 100:
                bat = f"{pct}%"
        except Exception:
            pass
    address = ""
    addr_m = re.search(r',\d+,"([^"]{10,})"', text)
    if addr_m:
        address = addr_m.group(1).strip()
        if address:
            address = address.split(',')[0].strip()
            if address:
                address = f"{address}, Santa Fe"
    acc_m = ACCURACY_RE.search(text)
    accuracy = int(acc_m.group(1)) if acc_m else 0
    ch_m = CHARGE_RE.search(text)
    charging = int(ch_m.group(1)) if ch_m else 0
    return bat, address, accuracy, charging


def extract_battery_from_page(page, page_url=""):
    """Extrae el % de bateria del panel de Live Location via Playwright."""
    try:
        try:
            if page.is_closed():
                logger.warning("Pagina cerrada, no se puede extraer bateria")
                return None
        except Exception:
            pass

        html = page.content()

        debug_path = BASE_DIR / "debug_battery.html"
        try:
            debug_path.write_text(html, encoding="utf-8")
        except Exception:
            pass

        patterns = [
            r'(\d{1,3})\s*%\s*(?:··|•|\s+)(?:cargando|charging)',
            r'Bater[i\xed]a[^<]{0,30}?(\d{1,3})\s*%',
            r'(\d{1,3})\s*%[^<]{0,50}?bater',
            r'(\d{1,3})\s*%\s*(?:·|•)',
            r'charging[^<]{0,30}?(\d{1,3})\s*%',
        ]

        for i, pat in enumerate(patterns):
            match = re.search(pat, html, re.IGNORECASE)
            if match:
                pct = int(match.group(1))
                if 0 <= pct <= 100:
                    logger.info("BATERIA detectada (patron #%d): %s%%", i+1, pct)
                    return f"{pct}%"

        try:
            for selector in [
                '[aria-label*="bater"]',
                '[aria-label*="battery"]',
                '[aria-label*="%"]',
            ]:
                try:
                    elements = page.query_selector_all(selector)
                    for el in elements:
                        aria = el.get_attribute("aria-label") or ""
                        text = el.inner_text() or ""
                        combined = f"{aria} {text}"
                        match = re.search(r'(\d{1,3})\s*%', combined)
                        if match:
                            pct = int(match.group(1))
                            if 0 <= pct <= 100:
                                logger.info("BATERIA via aria-label: %s%%", pct)
                                return f"{pct}%"
                except Exception:
                    continue
        except Exception:
            pass

        logger.warning("BATERIA NO detectada.")
        return None

    except Exception as e:
        logger.error("Error critico extrayendo bateria: %s", e)
        return None


# ------------------------------------------------------------
# TRACKING LOOP v5 — STATE PIPELINE
# ------------------------------------------------------------
def tracking_loop(stop_event):
    """Loop principal: raw -> build_state -> prev_state."""
    global _CURRENT_BATTERY, _CURRENT_ADDRESS, _LAST_POLL_TIME, _LAST_POLL_LAT, _LAST_POLL_LNG
    global _PREV_STATE, _LAST_UPDATE, _CURRENT_CHARGING

    init_csv()
    battery_info = None
    logger.info("Inicio de captura via API (v5 state pipeline).")
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

            if address:
                _CURRENT_ADDRESS = address
                logger.info("Direccion: %s", address)

            if bat:
                battery_info = bat
                _CURRENT_BATTERY = bat
                _update_battery_estimate(bat)
                logger.info("Bateria: %s (carga=%d)", bat, charging)

            _CURRENT_CHARGING = "cargando" if charging == 1 else ""

            if lat is not None and lng is not None:
                _no_coords_count = 0
                logger.info("COORDENADAS: lat=%.6f, lng=%.6f", lat, lng)

                if not is_duplicate(lat, lng):
                    now = datetime.now(timezone.utc)
                    speed, hdg, state = compute_telemetry(lat, lng, now)

                    # Real speed between polls
                    if _LAST_POLL_TIME is not None and _LAST_POLL_LAT is not None and speed == 0:
                        delta_s = (now - _LAST_POLL_TIME).total_seconds()
                        if delta_s > 0:
                            dist_m = haversine_m(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            speed = dist_m * 3.6 / delta_s
                            hdg = bearing(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            state = classify_speed(speed)

                    # Save for next poll
                    _LAST_POLL_TIME = now
                    _LAST_POLL_LAT = lat
                    _LAST_POLL_LNG = lng
                    _LAST_UPDATE = now

                    # PIPELINE: raw -> build_state -> prev_state
                    raw = {
                        "lat": lat,
                        "lng": lng,
                        "speed_kmh": speed,
                        "battery": battery_info,
                        "accuracy": accuracy,
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
                        "Punto registrado | zona=%s score=%d motion=%s spoof=%s",
                        _PREV_STATE["_internal"]["zone"],
                        _PREV_STATE["activity"]["score_0_100"],
                        _PREV_STATE["movement"]["motion_class"],
                        _PREV_STATE["spoof"]["classification"],
                    )
                else:
                    _update_battery_estimate(bat)
                    logger.info("Sin cambio (duplicado)")
            else:
                _no_coords_count += 1
                logger.warning("Sin coordenadas (intento %d/3)", _no_coords_count)
                if _no_coords_count >= 3:
                    _no_coords_count = 0
                    logger.info("--- 3 polls sin coordenadas ---")
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
    if not bat:
        return
    pct = int(bat.replace('%', ''))
    now = time.time()
    _BATTERY_HISTORY.append((now, pct))
    if len(_BATTERY_HISTORY) > _MAX_BATTERY_HISTORY:
        _BATTERY_HISTORY.pop(0)
    if len(_BATTERY_HISTORY) < 3:
        _BATTERY_LIFE_ESTIMATE = "N/A"
        return
    first = _BATTERY_HISTORY[0]
    last = _BATTERY_HISTORY[-1]
    elapsed_h = (last[0] - first[0]) / 3600
    if elapsed_h <= 0 or last[1] >= first[1]:
        _BATTERY_LIFE_ESTIMATE = "N/A"
        return
    drain_pct_h = (first[1] - last[1]) / elapsed_h
    if drain_pct_h <= 0:
        _BATTERY_LIFE_ESTIMATE = "N/A"
        return
    remaining_h = last[1] / drain_pct_h
    if remaining_h < 0:
        _BATTERY_LIFE_ESTIMATE = "N/A"
        return
    if remaining_h < 1:
        mins = int(remaining_h * 60)
        _BATTERY_LIFE_ESTIMATE = f"~{mins}m"
    else:
        hrs = int(remaining_h)
        mins = int((remaining_h - hrs) * 60)
        _BATTERY_LIFE_ESTIMATE = f"~{hrs}h {mins:02d}m"


# ------------------------------------------------------------
# GENERACION HTML — APPLE MAPS PURE UI (v5 STATE RENDERER)
# ------------------------------------------------------------
def _fmt_seconds(secs):
    h = secs // 3600
    m = (secs % 3600) // 60
    if h > 0:
        return f"{h}h {m}m"
    return f"{m}m"


def generate_html(points, stats, battery=None):
    logger.info("Generando dashboard v5 con %d puntos", len(points))
    geojson = json.dumps(points)
    stats_json = json.dumps(stats)

    # Use _PREV_STATE if available
    if _PREV_STATE is not None:
        state = _PREV_STATE
    else:
        last = points[-1] if points else {}
        speed = stats.get("current_speed_kmh", 0) or 0
        raw = {
            "lat": last.get("lat"),
            "lng": last.get("lng"),
            "speed_kmh": speed,
            "battery": battery,
            "accuracy": None,
            "address": "",
            "charging": None,
            "timestamp": last.get("timestamp"),
        }
        state = build_state(raw, None)
    state_json = json.dumps(state)

    last_ts = ""
    if points:
        try:
            dt = datetime.fromisoformat(points[-1]["timestamp"])
            last_ts = dt.strftime("%H:%M:%S")
        except Exception:
            last_ts = points[-1]["timestamp"]

    html = """<!DOCTYPE html>
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
body{background:#000;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue',sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color:#fff}
#map{position:fixed;inset:0;z-index:1}
.leaflet-container{background:#000}
.leaflet-popup-content-wrapper{background:rgba(20,20,20,.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:#fff;border:1px solid rgba(255,255,255,.06);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.leaflet-popup-tip{background:rgba(20,20,20,.92)}
.leaflet-popup-content{font-size:13px;line-height:1.5;margin:10px 14px}
.leaflet-control-zoom{border:none!important;box-shadow:none!important;margin:10px!important}
.leaflet-control-zoom a{background:rgba(20,20,20,.72)!important;backdrop-filter:blur(16px)!important;color:#8a8a8a!important;border:1px solid rgba(255,255,255,.06)!important;width:36px!important;height:36px!important;line-height:36px!important;font-size:16px!important;border-radius:10px!important;margin-bottom:2px!important}
.leaflet-control-zoom a:hover{background:rgba(40,40,40,.85)!important;color:#fff!important}
.marker-cluster-small,.marker-cluster-medium,.marker-cluster-large{background-color:rgba(100,100,100,.12)!important}
.marker-cluster-small div,.marker-cluster-medium div,.marker-cluster-large div{background-color:rgba(100,100,100,.35)!important;color:#fff!important;font-weight:600!important}

/* Live marker */
.live-marker{position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none}
.live-dot{width:18px;height:18px;border-radius:50%;background:#007aff;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,122,255,.4);position:relative}
.live-dot::after{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(0,122,255,.5);animation:livePulse 2s ease-out infinite}
@keyframes livePulse{0%{transform:scale(.8);opacity:.6}100%{transform:scale(2);opacity:0}}
.live-speed{font-size:11px;font-weight:600;color:#fff;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:4px;margin-top:3px;white-space:nowrap}

/* Bottom card */
.card{position:fixed;left:16px;right:16px;bottom:18px;z-index:1000;background:rgba(20,20,20,.72);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.06);border-radius:18px;padding:14px 16px calc(14px + env(safe-area-inset-bottom, 0px));max-height:55vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.card::-webkit-scrollbar{width:0;display:none}
@media(min-width:700px){
  .card{left:50%;right:auto;transform:translateX(-50%);width:420px;max-width:90vw}
}

/* Place label */
.place{font-size:15px;font-weight:600;color:#fff;letter-spacing:-.2px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}

/* Time row */
.time-row{font-size:11px;color:#636363;margin-bottom:8px}

/* Status row */
.status-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}
.status{font-size:22px;font-weight:700;letter-spacing:-.5px;line-height:1}
.status.casa{color:#34c759}.status.trabajo{color:#007aff}.status.movimiento{color:#ff9500}.status.inactivo{color:#8a8a8a}
.speed{font-size:20px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;line-height:1}
.speed-unit{font-size:12px;color:#8a8a8a;font-weight:500;margin-left:2px}

/* Motion class badge */
.motion-badge{display:inline-block;font-size:11px;font-weight:600;color:#fff;background:rgba(255,255,255,.08);padding:2px 8px;border-radius:6px;margin-left:8px;letter-spacing:.3px}
.motion-badge.walk{background:rgba(52,199,89,.15);color:#34c759}
.motion-badge.car{background:rgba(0,122,255,.15);color:#007aff}
.motion-badge.bus{background:rgba(255,149,0,.15);color:#ff9500}
.motion-badge.static{background:rgba(142,142,147,.15);color:#8e8e93}
.motion-badge.mix{background:rgba(175,82,222,.15);color:#af52de}
.motion-badge.anomaly{background:rgba(255,59,48,.15);color:#ff3b30}

/* Activity level badge */
.level-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;letter-spacing:.3px;margin-left:6px}
.level-badge.low{background:rgba(142,142,147,.15);color:#8e8e93}
.level-badge.medium{background:rgba(255,149,0,.15);color:#ff9500}
.level-badge.high{background:rgba(52,199,89,.15);color:#34c759}

/* Info rows */
.info-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#8a8a8a;margin-bottom:4px}
.info-row:last-child{margin-bottom:0}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot.green{background:#34c759}.dot.blue{background:#007aff}.dot.orange{background:#ff9500}.dot.gray{background:#8a8a8a}.dot.red{background:#ff3b30}.dot.yellow{background:#ffd60a}.dot.purple{background:#af52de}
.val{color:#fff;font-weight:500}
.bar-wrap{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden;margin-left:6px}
.bar-fill{height:100%;border-radius:2px;transition:width .5s}

/* Network badge */
.net-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;letter-spacing:.3px;margin-left:4px}
.net-badge.wifi{background:rgba(52,199,89,.15);color:#34c759}
.net-badge.fourg{background:rgba(255,149,0,.15);color:#ff9500}
.net-badge.fiveg{background:rgba(0,122,255,.15);color:#007aff}
.net-badge.unknown{background:rgba(142,142,147,.15);color:#8e8e93}

/* Screen state indicator */
.screen-indicator{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;vertical-align:middle}
.screen-indicator.on{background:#34c759;box-shadow:0 0 4px rgba(52,199,89,.5)}
.screen-indicator.off{background:#ff3b30;box-shadow:0 0 4px rgba(255,59,48,.5)}

/* Proximity row */
.proximity-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#8a8a8a;margin-top:4px;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.03)}
.proximity-row.approaching{background:rgba(0,122,255,.08);color:#007aff}
.proximity-row.arrived{background:rgba(52,199,89,.08);color:#34c759}

/* GhostRail mini */
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

/* Signal loss overlay */
#signalOverlay{position:fixed;inset:0;z-index:999;pointer-events:none;opacity:0;transition:opacity .5s}
#signalOverlay.active{opacity:1;animation:signalPulse 2s ease-in-out infinite}
@keyframes signalPulse{0%{box-shadow:inset 0 0 60px 10px rgba(255,149,0,.08)}50%{box-shadow:inset 0 0 160px 40px rgba(255,149,0,.15)}100%{box-shadow:inset 0 0 60px 10px rgba(255,149,0,.08)}}

/* Float buttons */
#floatBtns{position:fixed;right:12px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.fb{width:44px;height:44px;border-radius:50%;background:rgba(20,20,20,.72);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);color:#8a8a8a;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;padding:0;-webkit-tap-highlight-color:transparent}
.fb:hover{background:rgba(40,40,40,.85);color:#fff}
.fb:active{transform:scale(.9)}
.fb.active{color:#007aff;border-color:rgba(0,122,255,.3)}

/* Toast */
#toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2000;background:rgba(20,20,20,.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 4px 24px rgba(0,0,0,.4);text-align:center;max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s;display:none}

/* Debug panel */
#debugPanel{position:fixed;top:60px;left:12px;z-index:2000;background:rgba(20,20,20,.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px 14px;font-size:11px;color:#636363;font-family:'SF Mono',Menlo,Consolas,monospace;line-height:1.9;max-width:260px;display:none}
.dbg-row{display:flex;justify-content:space-between;gap:10px}
.dbg-val{color:#8a8a8a;text-align:right}
</style>
</head>
<body>
<div id="map"></div>
<div id="spoofOverlay"></div>
<div id="signalOverlay"></div>

<!-- Bottom card -->
<div class="card">
  <div class="place" id="placeLabel">---</div>
  <div class="time-row" id="timeRow">---</div>
  <div class="status-row">
    <div>
      <span class="status" id="status">---</span>
      <span class="motion-badge static" id="motionBadge">STATIC</span>
      <span class="level-badge low" id="levelBadge">LOW</span>
    </div>
    <div class="speed" id="speedRow" style="display:none"></div>
  </div>
  <!-- Activity score -->
  <div class="info-row" id="actRow" style="display:none">
    <span class="dot blue"></span>
    <span>Actividad</span>
    <span class="val" id="actVal">0</span><span>%</span>
    <div class="bar-wrap"><div class="bar-fill" id="actBar" style="width:0;background:#8a8a8a"></div></div>
  </div>
  <!-- Network -->
  <div class="info-row" id="netRow" style="display:none">
    <span class="dot purple" id="netDot"></span>
    <span>Red</span>
    <span class="val" id="netVal">---</span>
    <span class="net-badge unknown" id="netBadge">---</span>
  </div>
  <!-- Battery + Screen -->
  <div class="info-row" id="battRow" style="display:none">
    <span class="dot green" id="battDot"></span>
    <span>Bateria</span>
    <span class="val" id="battVal">N/A</span>
    <span class="screen-indicator on" id="screenInd" title="Screen ON"></span>
  </div>
  <!-- Spoof -->
  <div class="info-row" id="spoofRow" style="display:none">
    <span class="dot green" id="spoofDot"></span>
    <span>GPS</span>
    <span class="val" id="spoofVal">OK</span>
    <span id="spoofScore" style="font-size:10px;color:#636363"></span>
  </div>
  <!-- Proximity -->
  <div class="proximity-row" id="proxRow" style="display:none">
    <span class="dot blue"></span>
    <span id="proxVal">---</span>
  </div>
  <!-- GhostRail mini -->
  <div class="gr-row" id="grRow" style="display:none"></div>
  <!-- Events panel -->
  <div class="events-panel" id="eventsPanel" style="display:none">
    <div class="events-title">Eventos</div>
    <div id="eventsList"></div>
  </div>
</div>

<!-- Float buttons -->
<div id="floatBtns">
  <button id="btnSatellite" class="fb" title="Satelite">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg>
  </button>
  <button id="btnCenter" class="fb" title="Centrar">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
  </button>
  <button id="btnCookies" class="fb" title="Cookies" onclick="window.open('/cookies.html','_blank')">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r=".8" fill="currentColor" stroke="none"/></svg>
  </button>
</div>

<!-- Toast -->
<div id="toast"></div>

<!-- Debug panel (D key) -->
<div id="debugPanel">
  <div class="dbg-row"><span>version</span><span class="dbg-val" id="dbgVersion">v5</span></div>
  <div class="dbg-row"><span>vel</span><span class="dbg-val" id="dbgSpeed">0</span></div>
  <div class="dbg-row"><span>vel_smooth</span><span class="dbg-val" id="dbgSmooth">0</span></div>
  <div class="dbg-row"><span>zona</span><span class="dbg-val" id="dbgZone">---</span></div>
  <div class="dbg-row"><span>motion</span><span class="dbg-val" id="dbgMotion">---</span></div>
  <div class="dbg-row"><span>spoof</span><span class="dbg-val" id="dbgSpoof">---</span></div>
  <div class="dbg-row"><span>red</span><span class="dbg-val" id="dbgNet">---</span></div>
  <div class="dbg-row"><span>screen</span><span class="dbg-val" id="dbgScreen">---</span></div>
  <div class="dbg-row"><span>prox</span><span class="dbg-val" id="dbgProx">---</span></div>
  <div class="dbg-row"><span>score</span><span class="dbg-val" id="dbgScore">0</span></div>
  <div class="dbg-row"><span>events</span><span class="dbg-val" id="dbgEvents">0</span></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
/* ====================================================================
   DATA & GLOBALS
   ==================================================================== */
var data = """ + geojson + """;
var stats = """ + stats_json + """;
var INIT_STATE = """ + state_json + """;
var REFRESH_MS = """ + str(int(os.environ.get("REFRESH_INTERVAL_MS", "10000"))) + """;
var _lastGoodDataTime = Date.now();
var _signalLost = false;
var _alertStop = null;
var _lastArrivalState = "NONE";

var pts = data.filter(function(p){return p.lat!=null&&p.lng!=null&&isFinite(p.lat)&&isFinite(p.lng)});
console.log('[Tracker v5]', pts.length, 'puntos validos');

/* ====================================================================
   MAP INITIALIZATION
   ==================================================================== */
var initCenter=[-31.65,-60.71],initZoom=16;
if(pts.length>0){var lp=pts[pts.length-1];if(isFinite(lp.lat)&&isFinite(lp.lng))initCenter=[lp.lat,lp.lng]}

var map=L.map('map',{zoomControl:true,attributionControl:false,center:initCenter,zoom:initZoom});

var darkTile=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:22,attribution:'CARTO'});
var satTile=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:22,attribution:'Esri'});
var satLabels=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',{maxZoom:22});
darkTile.addTo(map);

var mapMode='standard';
function toggleMapMode(){
  if(mapMode==='standard'){
    map.removeLayer(darkTile);
    satTile.addTo(map);satLabels.addTo(map);
    mapMode='satellite';
  }else{
    map.removeLayer(satTile);map.removeLayer(satLabels);
    darkTile.addTo(map);
    mapMode='standard';
  }
  var btn=document.getElementById('btnSatellite');
  if(btn)btn.classList.toggle('active',mapMode==='satellite');
}

/* Geofences */
L.circle([-31.6366,-60.7012],{radius:150,color:'#2a2a2a',fillColor:'#007aff',fillOpacity:.03,weight:1,opacity:.12}).addTo(map);
L.circle([-31.64693,-60.71598],{radius:150,color:'#2a2a2a',fillColor:'#34c759',fillOpacity:.03,weight:1,opacity:.12}).addTo(map);
L.circle([-31.643,-60.714],{radius:200,color:'#2a2a2a',fillColor:'#ff9500',fillOpacity:.03,weight:1,opacity:.12}).addTo(map);

map.invalidateSize();

/* Markers */
var clusterGroup=L.markerClusterGroup({maxClusterRadius:50,spiderfyOnMaxZoom:true,disableClusteringAtZoom:17,chunkedLoading:true});
pts.forEach(function(p,i){
  if(!isFinite(p.lat)||!isFinite(p.lng))return;
  var c=i===0?'#34c759':(i===pts.length-1?'#007aff':'#555'),r=i===0||i===pts.length-1?6:4;
  var m=L.circleMarker([p.lat,p.lng],{radius:r,fillColor:c,color:'rgba(255,255,255,.12)',weight:1,opacity:.35,fillOpacity:.35});
  m.bindPopup('<b>#'+(i+1)+'</b>'+(p.speed_kmh!==undefined?'<br>'+p.speed_kmh.toFixed(1)+' km/h':'')+'<br>'+new Date(p.timestamp).toLocaleString('es-AR'));
  clusterGroup.addLayer(m);
});
map.addLayer(clusterGroup);

/* Live marker */
var liveMarker=null;
function updateLiveMarker(lat,lng,speed){
  if(!isFinite(lat)||!isFinite(lng))return;
  if(liveMarker)map.removeLayer(liveMarker);
  var spd=speed||0;
  var sHtml=spd>1?'<div class="live-speed">'+Math.round(spd)+' km/h</div>':'';
  liveMarker=L.marker([lat,lng],{
    icon:L.divIcon({className:'',html:'<div class="live-marker"><div class="live-dot"></div>'+sHtml+'</div>',iconSize:[40,40],iconAnchor:[20,20]}),
    zIndexOffset:10000
  }).addTo(map);
}

if(pts.length>0){
  var last=pts[pts.length-1];
  updateLiveMarker(last.lat,last.lng,last.speed_kmh||0);
}

window.__tracker={map:map,pts:pts,clusterGroup:clusterGroup,liveMarker:liveMarker,lastPointCount:pts.length};

/* ====================================================================
   RENDER — STATE v5 ONLY (ZERO FRONTEND LOGIC)
   ==================================================================== */
function render(state){
  if(!state)return;

  /* Place label */
  var pl=document.getElementById('placeLabel');
  if(pl)pl.textContent=(state.location&&state.location.place_label)||'Sin ubicacion';

  /* Status */
  var st=document.getElementById('status');
  if(st&&state.activity){
    st.textContent=state.activity.ui_status||'INACTIVO';
    var us=state.activity.ui_status||'INACTIVO';
    st.className='status '+(us==='CASA'?'casa':us==='TRABAJO'?'trabajo':us==='MOVIMIENTO'?'movimiento':'inactivo');
  }

  /* Motion class badge */
  var mb=document.getElementById('motionBadge');
  if(mb&&state.movement){
    var mc=state.movement.motion_class||'STATIC';
    mb.textContent=mc;
    mb.className='motion-badge '+(mc==='WALK'?'walk':mc==='CAR'?'car':mc==='BUS'?'bus':mc==='MIX'?'mix':mc==='ANOMALY'?'anomaly':'static');
  }

  /* Activity level badge */
  var lb=document.getElementById('levelBadge');
  if(lb&&state.activity){
    var lvl=state.activity.level||'LOW';
    lb.textContent=lvl;
    lb.className='level-badge '+(lvl==='LOW'?'low':lvl==='MEDIUM'?'medium':'high');
  }

  /* Speed */
  var sr=document.getElementById('speedRow');
  if(sr&&state.movement){
    var sp=state.movement.speed_kmh||0;
    if(sp>1){sr.style.display='block';sr.innerHTML=Math.round(sp)+'<span class="speed-unit">km/h</span>'}
    else{sr.style.display='none'}
  }

  /* Activity score */
  var ar=document.getElementById('actRow');
  if(ar&&state.activity){
    ar.style.display='flex';
    var score=state.activity.score_0_100||0;
    var av=document.getElementById('actVal');if(av)av.textContent=score;
    var ab=document.getElementById('actBar');
    if(ab){ab.style.width=score+'%';ab.style.background=score>=66?'#34c759':score>=26?'#ff9500':'#8a8a8a'}
  }

  /* Network */
  var nr=document.getElementById('netRow');
  if(nr&&state.connectivity){
    nr.style.display='flex';
    var nv=document.getElementById('netVal');if(nv)nv.textContent=state.connectivity.type;
    var nb=document.getElementById('netBadge');
    if(nb){
      var nt=state.connectivity.type;
      nb.textContent=nt;
      nb.className='net-badge '+(nt==='WIFI'?'wifi':nt==='4G'?'fourg':nt==='5G'?'fiveg':'unknown');
    }
    var nd=document.getElementById('netDot');
    if(nd){nd.className='dot '+(nt==='WIFI'?'green':nt==='4G'?'orange':nt==='5G'?'blue':'gray')}
  }

  /* Battery + Screen */
  var br=document.getElementById('battRow');
  if(br&&state.device){
    br.style.display='flex';
    var bv=document.getElementById('battVal');
    if(bv){
      var btxt=state.device.battery_pct+'%';
      if(state.device.charging)btxt+=' (carga)';
      bv.textContent=btxt;
    }
    var bd=document.getElementById('battDot');
    if(bd){var bp=state.device.battery_pct;bd.className='dot '+(bp>50?'green':bp>20?'orange':'red')}
    /* Screen indicator */
    var si=document.getElementById('screenInd');
    if(si){
      var ss=state.device.screen_state||'OFF';
      si.className='screen-indicator '+(ss==='ON'?'on':'off');
      si.title='Screen '+ss;
    }
  }

  /* Spoof */
  var spr=document.getElementById('spoofRow');
  if(spr&&state.spoof){
    spr.style.display='flex';
    var sv=document.getElementById('spoofVal');
    if(sv){
      var cls=state.spoof.classification;
      sv.textContent=cls==='OK'?'OK':cls==='SUSPICIOUS'?'SOSPECHOSO':'ALTO RIESGO';
    }
    var sd=document.getElementById('spoofDot');
    if(sd){sd.className='dot '+(state.spoof.classification==='OK'?'green':state.spoof.risk_score_0_100>60?'red':'yellow')}
    var ss2=document.getElementById('spoofScore');
    if(ss2)ss2.textContent=state.spoof.risk_score_0_100>0?'('+state.spoof.risk_score_0_100+'%)':'';

    /* Spoof overlay */
    var so=document.getElementById('spoofOverlay');
    if(so){
      if(state.spoof.classification==='HIGH_RISK')so.classList.add('active');
      else so.classList.remove('active');
    }
  }

  /* Proximity */
  var pr=document.getElementById('proxRow');
  if(pr&&state.proximity){
    var px=state.proximity;
    if(px.home_distance_m!=null){
      pr.style.display='flex';
      var pv=document.getElementById('proxVal');
      if(pv){
        var ptxt='A '+px.home_distance_m+'m de Casa';
        if(px.arrival_state==='APPROACHING')ptxt='LLEGANDO - '+px.home_distance_m+'m';
        else if(px.arrival_state==='ARRIVED')ptxt='CASI LLEGAS - '+px.home_distance_m+'m';
        pv.textContent=ptxt;
      }
      pr.className='proximity-row '+(px.arrival_state==='APPROACHING'?'approaching':px.arrival_state==='ARRIVED'?'arrived':'');
    }else{
      pr.style.display='none';
    }
  }

  /* GhostRail mini */
  var gr=document.getElementById('grRow');
  if(gr&&state.ghostrail){
    var clusters=state.ghostrail.clusters_max5||[];
    var pts24=state.ghostrail.points_24h||0;
    if(clusters.length>0){
      gr.style.display='flex';
      var html='';
      var zc={'Casa':'home','Trabajo':'work','En ruta':'transit'};
      clusters.forEach(function(z){
        var cls=zc[z.name]||'other';
        var dur=z.duration_min||0;
        var durTxt=dur>=60?Math.floor(dur/60)+'h '+Math.floor(dur%60)+'m':dur+'m';
        html+='<span class="gr-item"><span class="gr-dot '+cls+'"></span>'+z.name+' <span class="gr-dur">'+durTxt+'</span></span>';
      });
      gr.innerHTML=html;
    }else{gr.style.display='none'}
  }

  /* Events panel */
  var ep=document.getElementById('eventsPanel');
  var el=document.getElementById('eventsList');
  if(ep&&el&&state.events&&state.events.length>0){
    ep.style.display='block';
    var ehtml='';
    state.events.forEach(function(ev){
      var dotCls='zone';
      if(ev.type==='SPOOF_WARNING')dotCls='spoof';
      else if(ev.type==='ARRIVAL_LLEGANDO'||ev.type==='ARRIVAL_CASI')dotCls='arrival';
      else if(ev.type==='NETWORK_CHANGE')dotCls='network';
      else if(ev.type==='BATTERY_DROP')dotCls='battery';
      else if(ev.type==='ACTIVITY_SPIKE')dotCls='activity';
      ehtml+='<div class="event-item"><span class="event-dot '+dotCls+'"></span><span class="event-msg">'+ev.message+'</span></div>';
    });
    el.innerHTML=ehtml;
  }else if(ep){ep.style.display='none'}

  /* Auto-center live marker */
  if(state.location&&state.location.lat!=null&&state.location.lng!=null){
    updateLiveMarker(state.location.lat,state.location.lng,state.movement.speed_kmh||0);
  }

  /* Toast for zone change / arrival */
  if(state.events&&state.events.length>0){
    var latest=state.events[state.events.length-1];
    if(latest.type==='ZONE_CHANGE'||latest.type==='ARRIVAL_LLEGANDO'||latest.type==='ARRIVAL_CASI'){
      _showToast(latest.message);
    }
    if(latest.type==='ARRIVAL_LLEGANDO'||latest.type==='ARRIVAL_CASI'){
      _playVoice(latest.message);
    }
  }

  /* Debug */
  var h=function(id,val){var e=document.getElementById(id);if(e)e.textContent=val};
  if(state.meta)h('dbgVersion',state.meta.version||'v5');
  if(state.movement){
    h('dbgSpeed',state.movement.speed_kmh);
    h('dbgSmooth',state.movement.confidence);
    h('dbgMotion',state.movement.motion_class);
  }
  if(state.activity){
    h('dbgZone',state.activity.ui_status);
    h('dbgScore',state.activity.score_0_100);
  }
  if(state.spoof)h('dbgSpoof',state.spoof.classification+' ('+state.spoof.risk_score_0_100+')');
  if(state.connectivity)h('dbgNet',state.connectivity.type+' ('+state.connectivity.confidence+')');
  if(state.device)h('dbgScreen',state.device.screen_state);
  if(state.proximity)h('dbgProx',state.proximity.arrival_state+' '+state.proximity.home_distance_m+'m');
  if(state.events)h('dbgEvents',state.events.length);
}

/* ---- Utilities ---- */
function _showToast(msg){
  var t=document.getElementById('toast');
  if(t){t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none'},5000)}
}

function _playVoice(text){
  if(_alertStop){_alertStop();_alertStop=null}
  try{if(!window.speechSynthesis)return;var stopped=false;
  var say=function(){if(stopped)return;var u=new SpeechSynthesisUtterance(text);u.lang='es-AR';u.rate=1;u.volume=.8;window.speechSynthesis.speak(u)};
  say();var iv=setInterval(function(){if(stopped){clearInterval(iv);return}say()},3500);
  var at=setTimeout(function(){if(!stopped){stopped=true;clearInterval(iv);window.speechSynthesis.cancel()}},10000);
  _alertStop=function(){if(stopped)return;stopped=true;clearInterval(iv);clearTimeout(at);window.speechSynthesis.cancel()}}catch(e){}
}

/* ---- Initial render ---- */
render(INIT_STATE);

/* ---- Relative time updater ---- */
if(pts.length>0){
  var _lastTs=new Date(pts[pts.length-1].timestamp).getTime();
  setInterval(function(){
    var diff=Math.floor((Date.now()-_lastTs)/1000);
    var txt='';
    if(diff<60)txt='Hace '+diff+'s';
    else if(diff<3600)txt='Hace '+Math.floor(diff/60)+'m';
    else txt='Hace '+Math.floor(diff/3600)+'h';
    var el=document.getElementById('timeRow');if(el)el.textContent=txt;
  },1000);
}

/* ---- Debug toggle ---- */
document.addEventListener('keydown',function(e){
  if(e.key==='d'||e.key==='D'){
    var dp=document.getElementById('debugPanel');
    if(dp)dp.style.display=dp.style.display==='none'?'block':'none';
  }
});

/* ---- Signal loss monitor ---- */
setInterval(function(){
  var elapsed=Date.now()-_lastGoodDataTime;
  if(elapsed>1500000&&!_signalLost){
    _signalLost=true;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.add('active');
  }
  if(elapsed<=1500000&&_signalLost){
    _signalLost=false;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.remove('active');
  }
},5000);

/* ====================================================================
   LIVE POLLING — reads STATE from /points, calls render()
   ==================================================================== */
setInterval(async function(){
  var t=window.__tracker;if(!t)return;
  try{
    var resp=await fetch('/points');if(!resp.ok)return;
    var body=await resp.json();
    if(!body.state)return;

    _lastGoodDataTime=Date.now();
    if(_signalLost){_signalLost=false;var ov=document.getElementById('signalOverlay');if(ov)ov.classList.remove('active')}

    /* Update markers if new points */
    if(body.points&&body.points.length>t.lastPointCount){
      var newPts=body.points.filter(function(p){return isFinite(p.lat)&&isFinite(p.lng)});
      t.clusterGroup.clearLayers();
      newPts.forEach(function(p,i){
        if(!isFinite(p.lat)||!isFinite(p.lng))return;
        var c=i===0?'#34c759':'#555',r=i===0?6:4;
        var m=L.circleMarker([p.lat,p.lng],{radius:r,fillColor:c,color:'rgba(255,255,255,.12)',weight:1,opacity:.35,fillOpacity:.35});
        m.bindPopup('<b>#'+(i+1)+'</b>'+(p.speed_kmh!==undefined?'<br>'+p.speed_kmh.toFixed(1)+' km/h':'')+'<br>'+new Date(p.timestamp).toLocaleString('es-AR'));
        t.clusterGroup.addLayer(m);
      });
      t.pts=newPts;t.lastPointCount=newPts.length;
    }

    /* Render state (ONLY this touches the UI) */
    render(body.state);

    /* Title */
    var mc=body.state.movement&&body.state.movement.motion_class;
    document.title=(mc==='CAR'||mc==='BUS')?'EN MOVIMIENTO - Tracker':'Tracker';

    /* Time reset */
    if(body.last_update){_lastTs=new Date(body.last_update).getTime()}

  }catch(e){
    console.warn('[Live] Error:',e.message);
  }
},REFRESH_MS);

/* ====================================================================
   CONTROLS
   ==================================================================== */
document.getElementById('btnCenter').onclick=function(){
  var t=window.__tracker;
  if(t&&t.map&&INIT_STATE.location) t.map.setView([INIT_STATE.location.lat,INIT_STATE.location.lng],17);
};
document.getElementById('btnSatellite').onclick=toggleMapMode;
</script>
</body>
</html>"""
    with open(HTML_PATH, "w", encoding="utf-8", errors="replace") as f:
        f.write(html)
    logger.info("Dashboard v5 generado: %s (%d puntos, %.2f km)",
                 HTML_PATH, len(points), stats["total_distance_km"])


# ------------------------------------------------------------
# SERVIDOR HTTP
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
    """Sirve archivos estaticos y expone endpoints JSON."""

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
                if csv_exists:
                    point_count = max(
                        0, sum(1 for _ in open(CSV_PATH, encoding="utf-8")) - 1
                    )
                self._send_json({
                    "status": "ok",
                    "uptime_s": round(time.time() - _SERVER_START_TS, 2),
                    "base_dir": str(BASE_DIR),
                    "html_exists": html_exists,
                    "csv_exists": csv_exists,
                    "points": point_count,
                    "version": "v5",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as e:
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        if self.path in ("/points", "/points/"):
            try:
                pts = read_all_points() if CSV_PATH.exists() else []
                sts = compute_stats(pts) if pts else {}
                logger.info("/points: %d puntos servidos", len(pts))

                # State from pipeline (source of truth)
                if _PREV_STATE is not None:
                    state = _PREV_STATE
                else:
                    speed = sts.get("current_speed_kmh", 0) or 0
                    raw = {
                        "lat": pts[-1].get("lat") if pts else None,
                        "lng": pts[-1].get("lng") if pts else None,
                        "speed_kmh": speed,
                        "battery": _CURRENT_BATTERY,
                        "accuracy": None,
                        "address": _CURRENT_ADDRESS or "",
                        "charging": None,
                        "timestamp": _LAST_UPDATE.isoformat() if _LAST_UPDATE else None,
                    }
                    state = build_state(raw, None)

                self._send_json({
                    "points": pts,
                    "stats": sts,
                    "state": state,
                    "last_update": _LAST_UPDATE.isoformat() if _LAST_UPDATE else None,
                })
            except Exception as e:
                logger.error("/points error: %s", e)
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        if self.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/mapa.html")
            self.end_headers()
            return

        if self.path == "/cookies.html":
            self._serve_cookies_page()
            return

        return super().do_GET()

    def do_POST(self):
        if self.path in ("/api/cookies", "/cookies"):
            self._handle_cookies_upload()
            return
        self.send_response(404)
        self.end_headers()

    def _serve_cookies_page(self):
        html = """<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Refrescar Cookies - Tracker v5</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;background:#000;color:#fff;padding:20px;max-width:800px;margin:auto}
h1{color:#007aff;font-size:22px;font-weight:700}
code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:13px}
ol li{margin:12px 0;line-height:1.6;color:#8a8a8a}
strong{color:#fff}
a{color:#007aff}
textarea{width:100%;height:250px;background:rgba(255,255,255,.04);color:#34c759;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px;font-family:'SF Mono',Menlo,monospace;font-size:13px}
button{background:#007aff;color:#fff;border:none;padding:12px 28px;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;margin-top:10px}
button:hover{background:#0056b3}
#status{margin-top:12px;padding:10px;border-radius:8px;display:none;font-size:14px}
.ok{background:rgba(52,199,89,.1);color:#34c759;border:1px solid rgba(52,199,89,.2)}
.err{background:rgba(255,59,48,.1);color:#ff3b30;border:1px solid rgba(255,59,48,.2)}
</style></head><body>
<h1>Refrescar Cookies</h1>
<p style="color:#8a8a8a;margin-bottom:16px">Las cookies expiran cada ~7 dias. Segui estos pasos:</p>
<ol>
<li>Instala <strong><a href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank">Cookie-Editor</a></strong> en Chrome</li>
<li>Anda a <a href="https://www.google.com/maps" target="_blank">Google Maps</a> y asegurate de estar logueado</li>
<li>Hace clic en Cookie-Editor > <strong>Export</strong> > <strong>JSON</strong></li>
<li>Copia el JSON y pegalo abajo</li>
</ol>
<textarea id="jsonInput" placeholder="Pega el JSON exportado de Cookie-Editor..."></textarea>
<br>
<button onclick="enviarCookies()">Enviar Cookies</button>
<div id="status"></div>
<script>
async function enviarCookies(){
    var s=document.getElementById('status');s.style.display='none';
    var txt=document.getElementById('jsonInput').value.trim();
    if(!txt){s.className='err';s.textContent='Pega el JSON primero';s.style.display='block';return}
    try{JSON.parse(txt)}catch(e){s.className='err';s.textContent='JSON invalido: '+e.message;s.style.display='block';return}
    var btn=document.querySelector('button');btn.disabled=true;btn.textContent='Enviando...';
    try{
        var r=await fetch('/api/cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:txt});
        var d=await r.json();
        if(r.ok){s.className='ok';s.textContent=d.message;document.getElementById('jsonInput').value=''}
        else{s.className='err';s.textContent=d.error}
    }catch(e){s.className='err';s.textContent='Error de red: '+e.message}
    s.style.display='block';btn.disabled=false;btn.textContent='Enviar Cookies';
}
</script>
</body></html>"""
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
            if not isinstance(cookies, list):
                raise ValueError("El JSON debe ser un array de cookies")
            for c in cookies:
                if "name" not in c or "value" not in c:
                    raise ValueError("Cada cookie debe tener 'name' y 'value'")
            COOKIES_PATH.write_text(json.dumps(cookies, indent=2), encoding="utf-8")
            logger.info("Cookies actualizadas: %d cookies", len(cookies))
            self._send_json({"status": "ok", "message": f"{len(cookies)} cookies guardadas. El tracker las usara en el proximo poll."})
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
            if e.errno in (errno.EADDRINUSE, errno.EACCES, 10048, 10013):
                logger.warning("Puerto %d ocupado (%s), probando siguiente...", port, e)
                continue
            logger.error("Error bindeando puerto %d: %s", port, e)
            continue
    if last_err is not None:
        logger.error("No se pudo bindear ningun puerto. Ultimo error: %s", last_err)
    return None, None


def start_http_server(stop_event):
    server, port = _bind_server()
    if server is None:
        logger.error("FATAL: servidor HTTP no arranco. Saliendo.")
        return None, None, None

    sock_name = server.socket.getsockname()
    logger.info(
        "Servidor escuchando en http://localhost:%d  (bind=%s, dir=%s)",
        port, sock_name, BASE_DIR,
    )
    logger.info("Endpoints: /mapa.html | /health | /points | /cookies.html")

    def _serve():
        try:
            server.serve_forever(poll_interval=0.5)
        except Exception as e:
            logger.error("serve_forever() lanzo excepcion: %s\n%s", e, traceback.format_exc())
        finally:
            logger.info("serve_forever() salio")

    t = threading.Thread(target=_serve, name="http-server", daemon=False)
    t.start()

    def _watch_stop():
        stop_event.wait()
        logger.info("Cerrando servidor HTTP...")
        try:
            server.shutdown()
            server.server_close()
        except Exception as e:
            logger.warning("Error cerrando server: %s", e)

    threading.Thread(target=_watch_stop, name="http-stop-watcher", daemon=True).start()
    return server, port, t


def _find_chrome_exe():
    candidates = []
    if os.name == "nt":
        env_paths = [
            os.environ.get("PROGRAMFILES", r"C:\Program Files"),
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", ""),
        ]
        for base in env_paths:
            if not base:
                continue
            candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    else:
        candidates += [
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/google-chrome-stable"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/chromium-browser"),
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    for c in candidates:
        if c.exists():
            return str(c)
    try:
        import shutil
        for name in ("chrome", "chrome.exe", "google-chrome"):
            found = shutil.which(name)
            if found:
                return found
    except Exception:
        pass
    return None


def _launch_chrome(url):
    if not FORCE_CHROME:
        return False
    chrome = _find_chrome_exe()
    if not chrome:
        logger.info("Chrome no encontrado en rutas tipicas; usare el navegador default.")
        return False
    try:
        import subprocess
        subprocess.Popen(
            [chrome, url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        logger.info("Chrome lanzado: %s", chrome)
        return True
    except Exception as e:
        logger.warning("No se pudo lanzar Chrome (%s); cayendo al default", e)
        return False


def _open_browser_when_ready(port, stop_event):
    deadline = time.time() + 10
    url = f"http://localhost:{port}/mapa.html"
    while time.time() < deadline and not stop_event.is_set():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                logger.info("Healthcheck TCP ok en puerto %d", port)
                break
        except OSError:
            time.sleep(0.25)
    if not OPEN_BROWSER or stop_event.is_set():
        return
    logger.info("Abriendo navegador en %s", url)

    if _launch_chrome(url):
        return
    try:
        webbrowser.open_new_tab(url)
    except Exception as e:
        logger.warning("No se pudo abrir el navegador automaticamente: %s", e)


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------
def main():
    setup_logging()
    logger.info("=" * 50)
    logger.info("Tracker Map v5 — PRODUCTION HARDENED STATE ENGINE")
    logger.info("=" * 50)
    logger.info("BASE_DIR = %s", BASE_DIR)
    logger.info("Python   = %s", sys.version.split()[0])
    logger.info("PID      = %d", os.getpid())

    os.chdir(str(BASE_DIR))
    init_csv()
    clean_old_points()

    stop_event = threading.Event()

    def signal_handler(sig, frame):
        logger.info("Senial recibida (%s), deteniendo...", sig)
        stop_event.set()

    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, signal_handler)
        except (AttributeError, ValueError):
            logger.warning("No se pudo instalar handler para %s (no main thread)", sig_name)

    # Generate initial mapa.html
    pts = read_all_points()
    stats = compute_stats(pts)
    try:
        generate_html(pts, stats, None)
    except Exception as e:
        logger.error("Error generando mapa.html inicial: %s", e)

    # Start HTTP server
    server, port, http_thread = start_http_server(stop_event)
    if server is None:
        logger.error("FATAL: servidor HTTP no arranco. Saliendo.")
        return 2

    # Open browser
    threading.Thread(
        target=_open_browser_when_ready, args=(port, stop_event),
        name="open-browser", daemon=True,
    ).start()

    # Tracking loop with guard
    backoff = 5
    while not stop_event.is_set():
        try:
            tracking_loop(stop_event)
            if stop_event.is_set():
                break
            logger.warning("tracking_loop salio sin stop_event, reintentando en %ds", backoff)
            stop_event.wait(backoff)
            backoff = min(backoff * 2, 120)
        except Exception as e:
            logger.error("Error fatal en tracking_loop: %s\n%s", e, traceback.format_exc())
            backoff = min(backoff * 2, 120)
            stop_event.wait(backoff)

    # Clean shutdown
    logger.info("Apagando servidor...")
    if server:
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass

    logger.info("Tracker v5 detenido.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
