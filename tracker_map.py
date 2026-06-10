#!/usr/bin/env python3
"""
Tracker Map v3
Captura coordenadas desde Google Maps Live Location usando Playwright,
computa telemetria en tiempo real y genera dashboard Leaflet avanzado.
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
# BASE_DIR se autodetecta a partir del .py para que el server sirva siempre
# desde el mismo directorio que el script (evita 404 si el .bat falla el cd).
# Si __file__ no esta disponible (ej. ejecutado desde stdin), cae al path
# Windows hardcoded como antes.
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
    "/data=!4m2!7m1!2e1?hl=es&entry=ttu&g_ep=EgoyMDI2MDUyMC4wIKXMDSoASAFQAw%3D%3D"
)

POLL_INTERVAL = 20  # segundos entre capturas
MAX_RETRIES = 3
RETRY_DELAY = 5
DUPLICATE_MIN_METERS = 5  # metros minimos para considerar punto nuevo (caminata ~5m)
RELOAD_EVERY_N_POLLS = 6  # recargar pagina cada N polls (~120s) para reducir crashes
HTTP_PORT = int(os.environ.get("PORT", 8765))
HTTP_PORT_FALLBACKS = [HTTP_PORT, 8765, 8766, 8767, 8768, 8769, 8770]
OPEN_BROWSER = True
# Fuerza la apertura en Chrome (no en Edge / default browser). Si Chrome no
# se encuentra cae al webbrowser default sin romper.
FORCE_CHROME = True
COORD_RE = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")

# Flag de testing
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
# Estado de carga: [0,XX],N,... donde N=3 no carga, N=1 cargando
CHARGE_RE = re.compile(r'\[0,\d{1,3}\]\s*,\s*(\d)\s*,')
# Precision en metros: despues del timestamp, antes de la direccion
ACCURACY_RE = re.compile(r'\]\s*,\s*\d{13}\s*,\s*(\d+)\s*,\s*"')

DETENIDO_THRESHOLD = 1.0
LENTO_THRESHOLD = 10.0
GPS_NOISE_THRESHOLD = 20

# Zona secundaria (trabajo)
WORK_ZONE_CENTER = (-31.6366, -60.7012)
WORK_ZONE_RADIUS_M = 150
# Zona primaria (radio generoso por deriva GPS)
HOME_ZONE_CENTER = (-31.64693, -60.71598)
HOME_ZONE_RADIUS_M = 150
# Zona terciaria (aprox)
USER_HOME_CENTER = (-31.643, -60.714)
USER_HOME_RADIUS_M = 200

HEADING_NAMES = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

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
    # StreamHandler solo si hay stdout real. En pythonw.exe (autostart sin
    # consola) sys.stdout puede ser None; agregar un handler nulo seria fatal.
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
    if speed_kmh < DETENIDO_THRESHOLD:
        return "detenido"
    elif speed_kmh < LENTO_THRESHOLD:
        return "lento"
    return "rapido"


def speed_color(speed_kmh):
    if speed_kmh < DETENIDO_THRESHOLD:
        return "#3498db"
    elif speed_kmh < LENTO_THRESHOLD:
        return "#f1c40f"
    return "#e74c3c"


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


def infer_connection(accuracy, charging):
    """Infere tipo de coneccion y estado de carga segun precision GPS."""
    if accuracy <= 0:
        conn = "---"
    elif accuracy <= 30:
        conn = "GPS"
    elif accuracy <= 100:
        conn = "WiFi"
    else:
        conn = "4G"
    chg = "⚡" if charging == 1 else ""
    return conn, chg


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
                    # Saltear filas con mas de 24hs de antiguedad
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
        if spd > 30:
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
                if points[i]["speed_kmh"] < DETENIDO_THRESHOLD:
                    stopped_s += seg_s
            except Exception:
                pass

    last = points[-1]
    current_speed = float(last.get("speed_kmh", 0)) if last.get("speed_kmh") is not None else 0.0
    if current_speed > 30:
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


def extract_battery_from_page(page, page_url=""):
    """
    Extrae el % de bateria del panel de Live Location.
    Devuelve string "NN%" o None.
    Guarda HTML para debug si falla.
    """
    try:
        # Verificar que la pagina siga viva antes de acceder al DOM
        try:
            if page.is_closed():
                logger.warning("Pagina cerrada, no se puede extraer bateria")
                return None
        except Exception:
            # page.is_closed() puede fallar si el navegador esta cerrándose
            logger.debug("No se pudo verificar si pagina esta viva")
            # Continuar de todas formas

        html = page.content()

        # DEBUG: guardar HTML para analisis manual
        debug_path = BASE_DIR / "debug_battery.html"
        try:
            debug_path.write_text(html, encoding="utf-8")
            logger.debug("HTML guardado para debug: %s (%d bytes)", debug_path, len(html))
        except Exception as e:
            logger.warning("No pude guardar debug HTML: %s", e)

        # ESTRATEGIA 1: Buscar patron "XX%" cerca de "bater" o "carg"
        # Patrones comunes en Google Maps Live Location
        patterns = [
            r'(\d{1,3})\s*%\s*(?:·|•|\s+)(?:cargando|charging)',  # "6% · cargando"
            r'Bater[i\xed]a[^<]{0,30}?(\d{1,3})\s*%',  # "Bateria 6%"
            r'(\d{1,3})\s*%[^<]{0,50}?bater',  # "6% ... bateria"
            r'(\d{1,3})\s*%\s*(?:·|•)',  # "6% ·" (generico)
            r'charging[^<]{0,30}?(\d{1,3})\s*%',  # "charging... 6%"
        ]

        for i, pat in enumerate(patterns):
            match = re.search(pat, html, re.IGNORECASE)
            if match:
                pct = int(match.group(1))
                if 0 <= pct <= 100:
                    logger.info("BATERIA detectada (patron #%d): %s%%", i+1, pct)
                    return f"{pct}%"

        # ESTRATEGIA 2: Buscar elementos con aria-label
        try:
            for selector in [
                '[aria-label*="bater"]',
                '[aria-label*="battery"]',
                '[aria-label*="%"]',
                '[aria-label*="cargando"]',
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
        except Exception as e:
            logger.debug("Error en estrategia aria-label: %s", e)

        # ESTRATEGIA 3: Buscar en el span/text normal cerca de "Live Location"
        try:
            # Google Maps suele tener un span con el % al lado del icono de bateria
            spans = page.query_selector_all('span, div')
            checked = 0
            for span in spans[:50]:  # Solo revisar primeros 50 para no ser lento
                try:
                    text = span.inner_text()
                    if '%' in text:
                        match = re.search(r'(\d{1,3})\s*%', text)
                        if match:
                            pct = int(match.group(1))
                            if 0 <= pct <= 100:
                                # Verificar que no es otro % (ej: descuento, oferta)
                                parent_text = ""
                                try:
                                    parent = span.evaluate_handle('el => el.parentElement?.innerText || ""')
                                    parent_text = str(parent) if parent else ""
                                except Exception:
                                    pass

                                # Si el texto cercano menciona bateria/carga, es valido
                                if any(kw in (text + parent_text).lower() for kw in ['bat', 'carg', 'battery', 'charge']):
                                    logger.info("BATERIA via span: %s%%", pct)
                                    return f"{pct}%"
                                checked += 1
                except Exception:
                    continue
            logger.debug("Revisados %d spans con '%%', ninguno era bateria", checked)
        except Exception as e:
            logger.debug("Error en estrategia spans: %s", e)

        # NO ENCONTRADO
        logger.warning("BATERIA NO detectada. Ver debug_battery.html para analisis manual.")
        return None

    except Exception as e:
        logger.error("Error critico extrayendo bateria: %s", e)
        return None


# ------------------------------------------------------------
# PLAYWRIGHT TRACKING
# ------------------------------------------------------------
def _check_profile_lock():
    """
    Chromium escribe SingletonLock dentro del user_data_dir cuando un proceso
    lo tiene abierto. Si el archivo existe y nadie lo esta usando, suele ser
    basura de un crash previo y conviene avisar al usuario.
    """
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
    """Mapea el entero same_site de Chrome al string."""
    return {0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict"}.get(val, "unspecified")


def _refresh_cookies_via_playwright():
    """
    Lee cookies de Google directamente de Chrome, sin abrir ventanas.
    
    Estrategia 1: Leer de la base SQLite del playwright_profile
                  (funciona si ya iniciaste sesion ahi alguna vez)
    Estrategia 2: Conectarse via CDP a Chrome ya abierto   
                  (solo si Chrome se inicio con --remote-debugging-port=9222)
    Estrategia 3: Playwright headless con playwright_profile
                  (lanza Chromium invisible, intenta renovar cookies)
    
    Returns True si se obtuvieron cookies, False si fallo.
    """
    # Estrategia 1: SQLite directa del playwright_profile
    if _read_cookies_from_sqlite(PROFILE_DIR / "Default" / "Network" / "Cookies"):
        return True

    # Estrategia 2: CDP a Chrome existente
    if _read_cookies_via_cdp():
        return True

    # Estrategia 3: Playwright headless
    if _read_cookies_via_playwright_headless():
        return True

    logger.warning("No se pudieron obtener cookies por ningun metodo.")
    return False


def _read_cookies_from_sqlite(db_path):
    """Intenta leer cookies de una base SQLite de Chrome."""
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
    """Conecta via CDP a Chrome ya abierto con --remote-debugging-port=9222."""
    import urllib.request, json as _json
    for port in [9222, 9223, 9224, 9225]:
        try:
            resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=2)
            pages = _json.loads(resp.read())
            if not pages:
                continue
            # Conectar via Playwright al CDP endpoint
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
    """Lanza Chromium headless (invisible) para renovar cookies del perfil."""
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
    """Busca recursivamente [lat,lng] o [lng,lat] en estructuras JSON."""
    if depth > 10 or obj is None:
        return None
    if isinstance(obj, list):
        # [lat, lng] o [lng, lat] - probar ambos
        if len(obj) == 2 and all(isinstance(x, (int, float)) for x in obj):
            a, b = float(obj[0]), float(obj[1])
            # Formato [lat, lng]
            if -90 <= a <= 90 and -180 <= b <= 180 and abs(a) > 1 and abs(b) > 1:
                return (a, b)
            # Formato [lng, lat]
            if -180 <= a <= 180 and -90 <= b <= 90 and abs(a) > 1 and abs(b) > 1:
                return (b, a)
        # Buscar en hijos
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
    """
    Scrapea ubicacion desde Google Maps via RPC + HTML + parseo profundo.
    Devuelve (lat, lng, bat_str_or_None, address, accuracy, charging).
    """
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
        # Stripear prefijo )]}'\n
        text = re.sub(r"^\)\]\}'\s*\n?", "", raw)
        # Detectar formato "sin sesion activa": [null,null,...]
        if re.match(r'^\[null,null,', text):
            logger.warning("Google Maps no reporta ubicacion activa. "
                          "Abrí Google Maps en el celular → Compartir ubicación "
                          "y asegurate de que esté activo (no expirado).")
            return None, None, None, "", 0, 0
        # Buscar coordenadas con varias estrategias
        found = None
        # Estrategia 1: [null,lng,lat]
        m = re.search(r'\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]', text)
        if m:
            lng, lat = float(m.group(1)), float(m.group(2))
            found = (lat, lng)
        # Estrategia 2: [null,[lng,lat]]
        if not found:
            m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', text)
            if m:
                lng, lat = float(m.group(1)), float(m.group(2))
                found = (lat, lng)
        # Estrategia 3: parseo JSON profundo
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
        raw_preview = raw[:500].replace("\n", " ").replace("\r", "") if raw else "(empty)"
        logger.info("Preview RPC: %s", raw_preview)
        return None, None, None, "", 0, 0

    # Buscar coordenadas en HTML
    m = re.search(r'\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]', html)
    if not m:
        m = re.search(r'\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]', html)
    if not m:
        m = re.search(r'(\[-?\d+\.\d+,-?\d+\.\d+\])', html)
        if m:
            parts = m.group(1).strip("[]").split(",")
            try:
                c1, c2 = float(parts[0]), float(parts[1])
                if -90 <= c1 <= 90 and -180 <= c2 <= 180:
                    lat, lng = c1, c2
                else:
                    lng, lat = c1, c2
                m = (lat, lng)
            except Exception:
                m = None

    if not m:
        # Intentar APP_INITIALIZATION_STATE
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
        raw_preview = raw[:500].replace("\n", " ").replace("\r", "") if raw else "(empty)"
        logger.info("Preview RPC: %s", raw_preview)
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
    # Bateria
    bat = None
    bm = BAT_API_RE.search(text)
    if bm:
        try:
            pct = int(bm.group(1))
            if 1 <= pct <= 100:
                bat = f"{pct}%"
        except Exception:
            pass
    # Direccion
    address = ""
    addr_m = re.search(r',\d+,"([^"]{10,})"', text)
    if addr_m:
        address = addr_m.group(1).strip()
        if address:
            address = address.split(',')[0].strip()
            if address:
                address = f"{address}, Santa Fe"
    # Precision
    acc_m = ACCURACY_RE.search(text)
    accuracy = int(acc_m.group(1)) if acc_m else 0
    # Carga
    ch_m = CHARGE_RE.search(text)
    charging = int(ch_m.group(1)) if ch_m else 0
    return bat, address, accuracy, charging


def _detect_spoofing(bat, lat, lng, accuracy=0, charging=0):
    """
    Detecta simulacion GPS solo con evidencia INDUBITABLE.
    Prioriza CERO falsos positivos aunque perdamos algunos casos reales.
    
    Returns:
        "✅" = real (o insuficientes datos)
        "🤔" = sospechoso (solo si hay +1 indicio, pero seguimos)
        "💀" = simulado (evidencia clara)
    
    Heuristicas (muy conservadoras):
      - Velocidad imposible (>800 km/h ≈ 2200m en 10s) → +3 directo a 💀
      - Bateria sube sin estar cargando → +2 (imposible)
      - Bateria cae >25% en un solo poll → +2 (imposible)
      - Precisión GPS congelada en 0 por 30+ polls -> +1
      - Salto grande desde detenido (>2km sin movimiento intermedio) -> +1
    """
    global _SPOOF_BATTERIES, _SPOOF_POSITIONS, _SPOOF_STATUS, _SPOOF_ACCURACIES
    score = 0

    # ---- Bateria ----
    if bat:
        bat_pct = int(bat.replace('%',''))
        _SPOOF_BATTERIES.append(bat_pct)
        if len(_SPOOF_BATTERIES) > _MAX_SPOOF_BATTERIES:
            _SPOOF_BATTERIES.pop(0)
        if len(_SPOOF_BATTERIES) >= 2:
            last_bat = _SPOOF_BATTERIES[-2]
            delta = bat_pct - last_bat
            # Subio sin estar cargando → imposible
            if delta >= 3 and charging == 0:
                score += 2
            # Bajo mas de 25% en 10s → imposible
            if delta <= -25:
                score += 2

    # ---- Posicion ----
    if lat is not None and lng is not None:
        _SPOOF_POSITIONS.append((lat, lng))
        if len(_SPOOF_POSITIONS) > _MAX_SPOOF_POSITIONS:
            _SPOOF_POSITIONS.pop(0)
        if len(_SPOOF_POSITIONS) >= 2:
            prev_lat, prev_lng = _SPOOF_POSITIONS[-2]
            dist = haversine_m(prev_lat, prev_lng, lat, lng)
            # Velocidad imposible >800 km/h (≈2200m en 10s)
            if dist > 2200:
                score += 3
            # Salto grande (>2km) sin movimiento intermedio detectado
            elif dist > 2000 and len(_SPOOF_POSITIONS) >= 2:
                score += 1

    # ---- Precision GPS ----
    if accuracy is not None:
        _SPOOF_ACCURACIES.append(accuracy)
        if len(_SPOOF_ACCURACIES) > 30:
            _SPOOF_ACCURACIES.pop(0)
        # Precision congelada en 0 por 30+ polls (tipico de mock GPS)
        if len(_SPOOF_ACCURACIES) >= 30 and all(a == 0 for a in _SPOOF_ACCURACIES[-30:]):
            score += 1

    # ---- Decision final ----
    if len(_SPOOF_POSITIONS) < _SPOOF_MIN_POLLS:
        _SPOOF_STATUS = 0
        return "✅"

    if score >= 3:
        _SPOOF_STATUS = 2
        return "💀"
    if score >= 2:
        _SPOOF_STATUS = 1
        return "🤔"

    _SPOOF_STATUS = 0
    return "✅"


def _update_battery_estimate(bat):
    global _BATTERY_HISTORY, _BATTERY_LIFE_ESTIMATE
    if not bat:
        return
    pct = int(bat.replace('%',''))
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
    drain_pct_h = (first[1] - last[1]) / elapsed_h  # % per hour
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


def _check_quantum_jump(lat, lng, speed=None):
    global _JUMP_DISTANCE_M, _JUMP_NOTIFICATION
    if _LAST_POLL_LAT is None or _LAST_POLL_LNG is None:
        _JUMP_DISTANCE_M = 0
        _JUMP_NOTIFICATION = ""
        return
    dist = haversine_m(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
    if dist >= _JUMP_THRESHOLD_M:
        km = dist / 1000
        if speed is not None and speed < 3:
            _JUMP_DISTANCE_M = dist
            _JUMP_NOTIFICATION = f"🚀 SALTO ANÓMALO (estaba fija): {km:.1f} km"
            logger.warning("⚠️ SALTO ANÓMALO (fija): %.1f km", km)
        else:
            _JUMP_DISTANCE_M = dist
            _JUMP_NOTIFICATION = f"🚀 SALTO CUÁNTICO: {km:.1f} km"
            logger.warning("⚠️ SALTO CUÁNTICO detectado: %.1f km", km)
    else:
        _JUMP_DISTANCE_M = 0
        _JUMP_NOTIFICATION = ""


def tracking_loop(stop_event):
    """Loop principal usando API directa (sin Playwright)."""
    global _CURRENT_BATTERY, _CURRENT_ADDRESS, _LAST_POLL_TIME, _LAST_POLL_LAT, _LAST_POLL_LNG, _IS_WORKING, _IS_AT_HOME, _SPOOF_STATUS, _BATTERY_LIFE_ESTIMATE, _JUMP_NOTIFICATION, _CURRENT_CONNECTION, _CURRENT_CHARGING, _VEHICLE_TYPE, _VEHICLE_CONFIDENCE, _ANOMALY_FLAG, _ANOMALY_MSG, _TRIP_PURPOSE, _STATIONARY_PLACE, _LAST_UPDATE
    init_csv()
    battery_info = None
    logger.info("Inicio de captura via API. Presiona Ctrl+C para detener.")
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

            _CURRENT_CONNECTION, _CURRENT_CHARGING = infer_connection(accuracy, charging)

            if lat is not None and lng is not None:
                _no_coords_count = 0
                logger.info("COORDENADAS EXTRAIDAS: lat=%.6f, lng=%.6f", lat, lng)
                _IS_WORKING = is_in_work_zone(lat, lng)
                _IS_AT_HOME = is_in_home_zone(lat, lng)
                if not is_duplicate(lat, lng):
                    now = datetime.now(timezone.utc)
                    speed, hdg, state = compute_telemetry(lat, lng, now)

                    # Velocidad real entre polls consecutivas
                    if _LAST_POLL_TIME is not None and _LAST_POLL_LAT is not None and speed == 0:
                        delta_s = (now - _LAST_POLL_TIME).total_seconds()
                        if delta_s > 0:
                            dist_m = haversine_m(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            speed = dist_m * 3.6 / delta_s
                            hdg = bearing(_LAST_POLL_LAT, _LAST_POLL_LNG, lat, lng)
                            state = classify_speed(speed)

                    # Quantum jump detection antes de actualizar pos anterior
                    _check_quantum_jump(lat, lng, speed)

                    # Guardar para proximo poll
                    _LAST_POLL_TIME = now
                    _LAST_POLL_LAT = lat
                    _LAST_POLL_LNG = lng
                    _LAST_UPDATE = now

                    append_csv(now, lat, lng, speed, hdg, state)
                    points = read_all_points()
                    stats = compute_stats(points)
                    spoof_icon = _detect_spoofing(bat, lat, lng, accuracy, charging)
                    _run_forensic_analysis(points)
                    generate_html(points, stats, battery_info, _IS_WORKING, spoof_icon, _BATTERY_LIFE_ESTIMATE, _JUMP_NOTIFICATION, _IS_AT_HOME, address=_CURRENT_ADDRESS)
                    logger.info("Punto registrado")
                else:
                    _detect_spoofing(bat, lat, lng, accuracy, charging)
                    _update_battery_estimate(bat)
                    logger.info("Sin cambio (duplicado)")
            else:
                _no_coords_count += 1
                logger.warning("Sin coordenadas en esta poll (intento %d/3)", _no_coords_count)
                # Si llevamos 3 polls sin coords, intentar refrescar cookies
                if _no_coords_count >= 3:
                    _no_coords_count = 0
                    logger.info("--- 3 polls sin coordenadas, refrescando cookies ---")
                    if not SKIP_PLAYWRIGHT:
                        _refresh_cookies_via_playwright()
                    else:
                        logger.warning("Cookies expiradas. Cargá nuevas via /cookies.html")
                # No actualizar _LAST_POLL en polls sin coordenadas

        except Exception as e:
            logger.error("Error en loop: %s", e)

        stop_event.wait(POLL_INTERVAL)

    logger.info("Tracking detenido.")


# ------------------------------------------------------------
# ANALISIS FORENSE: vehiculo, rutas, anomalias
# ------------------------------------------------------------
_ANALYSIS_PATH = BASE_DIR / "analisis.json"
_VEHICLE_TYPE = "desconocido"
_VEHICLE_CONFIDENCE = 0.0
_ANOMALY_FLAG = False
_ANOMALY_MSG = ""
_TRIP_PURPOSE = ""
_FREQUENT_ROUTES = []  # lista de rutas frecuentes aprendidas
_KNOWN_STOPS = {}  # dict nombre -> {lat, lng, visits, type}

def _load_analysis():
    global _KNOWN_STOPS, _FREQUENT_ROUTES
    try:
        if _ANALYSIS_PATH.exists():
            d = json.loads(_ANALYSIS_PATH.read_text(encoding="utf-8"))
            _KNOWN_STOPS = d.get("stops", {})
            _FREQUENT_ROUTES = d.get("routes", [])
    except Exception:
        pass

def _save_analysis():
    try:
        _ANALYSIS_PATH.write_text(json.dumps({
            "stops": _KNOWN_STOPS,
            "routes": _FREQUENT_ROUTES,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

def _learn_stop(lat, lng, ts, address):
    """Agrupa puntos estacionarios en lugares conocidos."""
    global _KNOWN_STOPS
    # Buscar si ya existe un stop conocido cerca (<100m)
    for name, s in _KNOWN_STOPS.items():
        if haversine_m(s["lat"], s["lng"], lat, lng) < 100:
            s["lat"] = (s["lat"] + lat) / 2
            s["lng"] = (s["lng"] + lng) / 2
            s["visits"] = s.get("visits", 0) + 1
            s["last_seen"] = ts
            return name
    # No encontrado crear nuevo
    name = f"stop_{len(_KNOWN_STOPS)}"
    label = address.split(",")[0] if address else name
    _KNOWN_STOPS[name] = {"lat": lat, "lng": lng, "visits": 1, "type": "desconocido", "label": label, "first_seen": ts, "last_seen": ts}
    _save_analysis()
    return name

def _classify_vehicle(speed_kmh, prev_speeds=None):
    """
    Clasifica vehiculo por perfil de velocidad.
    - Colectivo: max <55, acelera lento, para frecuente
    - Auto: max 30-120, acelera normal
    - Moto: max >60, acelera rapido
    """
    global _VEHICLE_TYPE, _VEHICLE_CONFIDENCE
    if prev_speeds is None or len(prev_speeds) < 3:
        if speed_kmh < 1:
            return _VEHICLE_TYPE
        return _VEHICLE_TYPE if _VEHICLE_TYPE != "desconocido" else "auto"
    
    avg = sum(prev_speeds) / len(prev_speeds)
    mx = max(prev_speeds)
    accel = prev_speeds[-1] - prev_speeds[0] if len(prev_speeds) > 1 else 0
    stops = sum(1 for s in prev_speeds if s < 1)
    
    # Colectivo: max bajo, muchas paradas
    if mx < 55 and stops >= 2 and avg < 25:
        _VEHICLE_TYPE = "colectivo"
        _VEHICLE_CONFIDENCE = min(0.9, 0.5 + stops * 0.1)
    # Moto: aceleracion rapida, alta velocidad
    elif mx > 60 and accel > 15:
        _VEHICLE_TYPE = "moto"
        _VEHICLE_CONFIDENCE = min(0.9, 0.5 + (mx / 200))
    # Auto: default
    elif avg > 15:
        _VEHICLE_TYPE = "auto"
        _VEHICLE_CONFIDENCE = 0.6
    else:
        _VEHICLE_TYPE = "desconocido"
        _VEHICLE_CONFIDENCE = 0
    
    return _VEHICLE_TYPE

_LAST_TEN_SPEEDS = []

def _run_forensic_analysis(points):
    """Rama todo el analisis forense."""
    global _VEHICLE_TYPE, _VEHICLE_CONFIDENCE, _ANOMALY_FLAG, _ANOMALY_MSG, _TRIP_PURPOSE, _LAST_TEN_SPEEDS
    if not points:
        return
    
    last = points[-1]
    spd = last.get("speed_kmh", 0)
    lat = last["lat"]
    lng = last["lng"]
    ts = last.get("timestamp", "")
    addr = last.get("address", "")
    
    # 1. Colectar ultimas velocidades
    _LAST_TEN_SPEEDS.append(spd)
    if len(_LAST_TEN_SPEEDS) > 10:
        _LAST_TEN_SPEEDS.pop(0)
    
    # 2. Clasificar vehiculo
    _classify_vehicle(spd, _LAST_TEN_SPEEDS)
    
    # 3. Aprender stops (si esta detenido >= 2 min)
    if spd < 1 and len(points) >= 3:
        _learn_stop(lat, lng, ts, addr)
    
    # 4. Inferir proposito del viaje
    _TRIP_PURPOSE = _infer_trip_purpose(lat, lng, ts)
    
    # 5. Detectar anomalias
    _detect_anomalies(lat, lng, addr)

    # 6. Estadía prolongada → nombre del lugar
    _detect_stationary_place(lat, lng, spd, ts)

def _infer_trip_purpose(lat, lng, ts):
    """Infere si va al trabajo, casa, super, etc."""
    # Trabajo
    if haversine_m(WORK_ZONE_CENTER[0], WORK_ZONE_CENTER[1], lat, lng) < 300:
        try:
            h = datetime.fromisoformat(ts).hour if ts else 0
        except Exception:
            h = 0
        if 6 <= h <= 10:
            return "🚶 yendo al trabajo"
        return "📍 en el trabajo"
    # Casa de Sofi
    if haversine_m(HOME_ZONE_CENTER[0], HOME_ZONE_CENTER[1], lat, lng) < 300:
        return "🏠 en sucursal"
    # Casa del user
    if haversine_m(USER_HOME_CENTER[0], USER_HOME_CENTER[1], lat, lng) < 300:
        return "🏡 en casa de user"
    return ""  # en transito

def _detect_anomalies(lat, lng, addr):
    """Detecta comportamientos extremadamente raros."""
    global _ANOMALY_FLAG, _ANOMALY_MSG
    _ANOMALY_FLAG = False
    _ANOMALY_MSG = ""
    
    # Rango esperado: Santa Fe capital y alrededores
    if not (-31.75 <= lat <= -31.5) or not (-60.85 <= lng <= -60.55):
        _ANOMALY_FLAG = True
        _ANOMALY_MSG = "📍 FUERA DE SANTA FE"
        return
    
    # Ciudad completamente desconocida vs zonas habituales
    known_zones = [
        (WORK_ZONE_CENTER, 2000),
        (HOME_ZONE_CENTER, 2000),
        (USER_HOME_CENTER, 2000),
    ]
    far_from_all = all(
        haversine_m(z[0], z[1], lat, lng) > r for z, r in known_zones
    )
    if far_from_all and len(_KNOWN_STOPS) > 3:
        # Ver si esta en algun stop conocido
        in_known = any(
            haversine_m(s["lat"], s["lng"], lat, lng) < 200
            for s in _KNOWN_STOPS.values()
        )
        if not in_known:
            _ANOMALY_FLAG = True
            _ANOMALY_MSG = "⚠️ ZONA NO HABITUAL"
    
    if _ANOMALY_FLAG:
        logger.warning("⚠️ ANOMALIA: %s (%.5f, %.5f)", _ANOMALY_MSG, lat, lng)


# ------------------------------------------------------------
# ESTADIA PROLONGADA / DETECCION DE LUGAR
# ------------------------------------------------------------
_NOMINATIM_CACHE = {}  # lat,lng -> nombre_lugar

def _reverse_geocode_place(lat, lng):
    """Consulta Nominatim (OSM) para obtener el nombre del lugar/comercio."""
    key = (round(lat, 5), round(lng, 5))
    if key in _NOMINATIM_CACHE:
        return _NOMINATIM_CACHE[key]
    try:
        url = (
            f"https://nominatim.openstreetmap.org/reverse?"
            f"format=jsonv2&lat={lat}&lon={lng}&zoom=18"
            f"&accept-language=es&addressdetails=1"
        )
        req = urllib.request.Request(url, headers={
            "User-Agent": "SofiTracker/1.0 (tracker@local)",
        })
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        # Buscar el nombre mas descriptivo: amenity, shop, tourism, building, etc.
        tags = data.get("tags", {})
        name = (
            tags.get("name")
            or data.get("address", {}).get("amenity", "")
            or data.get("address", {}).get("shop", "")
            or data.get("address", {}).get("building", "")
            or data.get("address", {}).get("commercial", "")
        )
        if not name:
            # Fallback: display_name acotado (sin pais, provincia)
            dn = data.get("display_name", "")
            parts = dn.split(", ")
            # Quitar pais y provincia (ultimos 2-3)
            name = ", ".join(parts[:-2]) if len(parts) > 3 else parts[0]
        if name:
            _NOMINATIM_CACHE[key] = name
        return name
    except Exception:
        return ""


def _detect_stationary_place(lat, lng, speed, ts):
    """
    Detecta si el dispositivo esta >15 min en el mismo lugar y obtiene nombre via OSM.
    Actualiza _STATIONARY_PLACE con el nombre del lugar (ej. SHOPPING RIBERA).
    """
    global _STATIONARY_START, _STATIONARY_LAT, _STATIONARY_LNG, _STATIONARY_PLACE

    # Si se esta moviendo (>3 km/h) o cambio de zona >200m, reset
    if speed > 3 or (_STATIONARY_LAT is not None and
                     haversine_m(_STATIONARY_LAT, _STATIONARY_LNG, lat, lng) > 200):
        _STATIONARY_START = None
        _STATIONARY_LAT = None
        _STATIONARY_LNG = None
        _STATIONARY_PLACE = ""
        return

    # Primera vez que se detiene
    if _STATIONARY_START is None:
        _STATIONARY_START = ts
        _STATIONARY_LAT = lat
        _STATIONARY_LNG = lng
        return

    # Ya venia detenida: check si pasaron los minutos minimos
    if _STATIONARY_PLACE:
        return  # ya tenemos el nombre

    try:
        if isinstance(ts, str):
            t = datetime.fromisoformat(ts)
        else:
            t = ts
        if isinstance(_STATIONARY_START, str):
            start = datetime.fromisoformat(_STATIONARY_START)
        else:
            start = _STATIONARY_START
        elapsed = (t - start).total_seconds()
    except Exception:
        return

    if elapsed >= _STATIONARY_MIN_S:
        name = _reverse_geocode_place(lat, lng)
        if name:
            _STATIONARY_PLACE = name.upper()
            logger.info("Estadia prolongada detectada: %s", _STATIONARY_PLACE)


# ------------------------------------------------------------
# GENERACION HTML LEAFLET DASHBOARD
# ------------------------------------------------------------
def _fmt_seconds(secs):
    h = secs // 3600
    m = (secs % 3600) // 60
    s = secs % 60
    if h > 0:
        return f"{h}h {m}m"
    return f"{m}m {s}s"


def generate_html(points, stats, battery=None, is_working=False, spoofing_icon="✅", battery_estimate="N/A", jump_notification="", is_home=False, address=""):
    logger.info("Generando dashboard con %d puntos", len(points))
    geojson = json.dumps(points)
    stats_json = json.dumps(stats)
    battery_json = json.dumps(battery) if battery else "null"

    last_ts = ""
    last_coord = ""
    if points:
        try:
            dt = datetime.fromisoformat(points[-1]["timestamp"])
            last_ts = dt.strftime("%H:%M:%S")
        except Exception:
            last_ts = points[-1]["timestamp"]
        last_coord = f"{points[-1]['lat']:.5f}, {points[-1]['lng']:.5f}"

    status_class = "online"
    status_text = "ONLINE"
    if stats["current_state"] == "sin_datos":
        status_class = "nodata"
        status_text = "SIN DATOS"

    html = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sofi tracker 🐞</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Helvetica,Arial,system-ui,-apple-system,sans-serif;background:#0d0d1a;color:#ccc;overflow:hidden}
#map{height:100vh;width:100%}
.leaflet-container{background:#0d0d1a}

/* ---- Pin marker ---- */
.pin-marker{white-space:nowrap}
.pin-icon{display:inline-flex;align-items:center;gap:6px;font-size:clamp(26px,4vw,36px);
text-shadow:0 0 8px rgba(0,0,0,0.6)}
.pin-speed{font-size:clamp(18px,2.8vw,26px);font-weight:700;color:#fff;letter-spacing:0.5px;
text-shadow:0 0 8px rgba(0,0,0,0.6);font-family:'Helvetica Neue',Helvetica,Arial,sans-serif}
@keyframes pulseRing{0%{transform:scale(0.6);opacity:0.6}100%{transform:scale(2.2);opacity:0}}
@keyframes pulseDot{0%{opacity:1;transform:scale(1)}50%{opacity:0.7;transform:scale(1.1)}100%{opacity:1;transform:scale(1)}}
.leaflet-popup-content-wrapper{background:rgba(10,10,22,0.95);backdrop-filter:blur(8px);color:#bbb;
border:1px solid rgba(255,255,255,0.04);border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.5)}
.leaflet-popup-tip{background:rgba(10,10,22,0.95)}
.leaflet-popup-content{font-size:12px;line-height:1.6;margin:10px 14px}
.leaflet-control-zoom a{background:rgba(10,10,22,0.85);color:#777;border-color:rgba(255,255,255,0.04);width:34px;height:34px;line-height:34px;font-size:18px}
.leaflet-control-zoom a:hover{background:rgba(20,20,40,0.9);color:#bbb}

/* ---- Clustering overrides ---- */
.marker-cluster-small{background-color:rgba(136,136,136,0.3)!important}
.marker-cluster-small div{background-color:rgba(136,136,136,0.6)!important;color:#fff!important}
.marker-cluster-medium{background-color:rgba(136,136,136,0.3)!important}
.marker-cluster-medium div{background-color:rgba(136,136,136,0.6)!important;color:#fff!important}
.marker-cluster-large{background-color:rgba(136,136,136,0.3)!important}
.marker-cluster-large div{background-color:rgba(136,136,136,0.6)!important;color:#fff!important}

/* ---- Jump Toast ---- */
.jump-toast{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2000;background:#e94560;color:#fff;padding:12px 28px;border-radius:8px;font-size:clamp(16px,2.5vw,24px);font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.4);text-align:center;max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s}
.jump-toast:hover{opacity:.8}

/* ---- Signal-loss alert overlay ---- */
#signalOverlay{position:fixed;inset:0;z-index:999;pointer-events:none;opacity:0;transition:opacity .5s}
#signalOverlay.active{opacity:1;animation:redAlert 2s ease-in-out infinite}
@keyframes redAlert{0%{box-shadow:inset 0 0 80px 20px rgba(255,0,0,0.15)}50%{box-shadow:inset 0 0 200px 50px rgba(255,0,0,0.35)}100%{box-shadow:inset 0 0 80px 20px rgba(255,0,0,0.15)}}

/* ---- Responsive panel (all screen sizes) ---- */
.mb-panel{position:fixed;z-index:1001;overflow-y:auto;
background:rgba(10,10,22,0.92);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
box-shadow:0 -8px 40px rgba(0,0,0,0.5)}
.mb-panel::-webkit-scrollbar{width:3px}
.mb-panel::-webkit-scrollbar-thumb{background:#333;border-radius:2px}

/* Small screens: bottom panel */
@media (max-width: 899px){
    .mb-panel{bottom:0;left:0;right:0;max-height:75vh;border-top:1px solid rgba(255,255,255,0.06)}
    .leaflet-control-zoom a{width:36px;height:36px;line-height:36px;font-size:20px}
}
/* Large screens: floating right sidebar */
@media (min-width: 900px){
    .mb-panel{top:10px;right:10px;width:clamp(280px,30vw,420px);max-height:calc(100vh - 20px);border-radius:14px;border:1px solid rgba(255,255,255,0.06)}
    .leaflet-control-zoom{margin-top:60px!important}
}

/* Panel header */
.mb-header{text-align:center;padding:12px 14px 4px;font-size:clamp(13px,2vw,20px);font-weight:700;color:#999;letter-spacing:3px;text-transform:uppercase}

/* Primary row */
.mb-primary{display:flex;align-items:center;justify-content:center;gap:0;padding:clamp(10px,1.5vw,18px) 12px clamp(6px,1vw,12px);text-align:center}
.mb-pitem{flex:1;min-width:0;position:relative}
.mb-pitem:not(:last-child)::after{content:'';position:absolute;right:0;top:20%;height:60%;width:1px;background:rgba(255,255,255,0.05)}
.mb-pval{font-weight:600;color:#fff;line-height:1.1;white-space:nowrap}
.mb-pval.spd{font-size:clamp(36px,7vw,60px);font-weight:700;letter-spacing:-2px}
.mb-pval.prim{font-size:clamp(20px,3.8vw,34px);font-weight:700}
.mb-punit{display:block;font-size:clamp(10px,1.6vw,15px);color:#aaa;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-top:2px}

/* Secondary row */
.mb-secondary{display:flex;align-items:center;justify-content:center;gap:0;padding:clamp(6px,0.8vw,10px) 12px;text-align:center;border-top:1px solid rgba(255,255,255,0.04)}
.mb-sitem{flex:1;min-width:0}
.mb-sval{font-size:clamp(15px,2.2vw,22px);font-weight:700;color:#fff;line-height:1.3}
.mb-slabel{font-size:clamp(9px,1.2vw,14px);font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px}

/* Info strip */
.mb-info{display:flex;align-items:center;justify-content:center;gap:clamp(6px,1vw,14px);padding:clamp(5px,0.6vw,9px) 12px;border-top:1px solid rgba(255,255,255,0.04);flex-wrap:wrap}
.mb-info-item{font-size:clamp(13px,1.8vw,20px);font-weight:600;color:#ccc}
.mb-info-item .mb-info-label{color:#888;font-size:clamp(10px,1.3vw,15px);font-weight:600;text-transform:uppercase;letter-spacing:0.5px}

/* Detail */
.mb-detail{padding:clamp(4px,0.5vw,8px) 14px;text-align:center;border-top:1px solid rgba(255,255,255,0.04)}
.mb-detail .mb-det-label{font-size:clamp(10px,1.2vw,15px);font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.6px}
.mb-detail .mb-det-val{font-size:clamp(14px,1.8vw,22px);font-weight:600;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Timeline */
.mb-tl-wrap{padding:clamp(4px,0.5vw,8px) 14px}
.mb-tl-wrap input[type=range]{width:100%;accent-color:#e94560;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;-webkit-appearance:none;appearance:none;cursor:pointer}
.mb-tl-labels{display:flex;justify-content:space-between;font-size:clamp(9px,1.1vw,14px);font-weight:600;color:#555;margin-top:2px}

/* Controls */
.mb-ctrl-row{display:flex;gap:5px;padding:clamp(4px,0.5vw,8px) 14px clamp(10px,1.2vw,16px)}
.mb-ctrl-row button{flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.04);color:#999;padding:clamp(8px,1vw,14px) 0;border-radius:8px;font-size:clamp(12px,1.6vw,18px);font-weight:600;cursor:pointer;font-family:inherit;text-transform:uppercase;letter-spacing:0.8px;transition:all .2s}
.mb-ctrl-row button:active{background:rgba(255,255,255,0.08);color:#ddd}
</style>
</head>
<body>
<div id="map"></div>
<div id="signalOverlay"></div>

<!-- Panel -->
<div class="mb-panel" id="mbPanel">
    <div class="mb-header">👩 Sofi Tracker 🐞</div>
    <!-- Primary row: speed inline with other key metrics -->
    <div class="mb-primary">
      <div class="mb-pitem"><div class="mb-pval spd" id="sfSpeed">""" + str(stats["current_speed_kmh"]) + """</div><div class="mb-punit">km/h</div></div>
      <div class="mb-pitem"><div class="mb-pval prim" id="msMax">""" + str(stats["max_speed_kmh"]) + """</div><div class="mb-punit">v.max</div></div>
      <div class="mb-pitem"><div class="mb-pval prim" id="msDist">""" + f"{stats['total_distance_km']:.1f}" + """</div><div class="mb-punit">dist km</div></div>
      <div class="mb-pitem"><div class="mb-pval prim" id="msAct">""" + _fmt_seconds(stats["moving_time_s"]) + """</div><div class="mb-punit">activo</div></div>
    </div>
    <!-- Secondary row: parado, puntos, batería, vida restante, heading -->
    <div class="mb-secondary">
      <div class="mb-sitem"><div class="mb-slabel">parado</div><div class="mb-sval" id="msStop">""" + _fmt_seconds(stats["stopped_time_s"]) + """</div></div>
      <div class="mb-sitem"><div class="mb-slabel">puntos</div><div class="mb-sval" id="mbPoints">""" + str(len(points)) + """</div></div>
      <div class="mb-sitem"><div class="mb-slabel">batería</div><div class="mb-sval" id="mbBattery">""" + (battery if battery else "N/A") + """</div></div>
      <div class="mb-sitem"><div class="mb-slabel">vida</div><div class="mb-sval" id="mbBatteryLife">""" + battery_estimate + """</div></div>
      <div class="mb-sitem"><div class="mb-slabel">rumbo</div><div class="mb-sval" id="mbHeading">""" + stats["current_heading_name"] + """</div></div>
    </div>
    <!-- Forensics: vehiculo inferido + proposito -->
    <div class="mb-secondary" style="border-top:none;padding:2px 10px">
      <div class="mb-sitem"><div class="mb-slabel">vehículo</div><div class="mb-sval" id="mbVehicle" style="font-size:clamp(13px,1.8vw,20px)">---</div></div>
      <div class="mb-sitem"><div class="mb-slabel">trayecto</div><div class="mb-sval" id="mbTripPurpose" style="font-size:clamp(13px,1.8vw,20px)">---</div></div>
    </div>
    <!-- Estadía prolongada (nombre del lugar) -->
    <div id="mbPlaceRow" class="mb-info" style="display:none;border-top:1px solid rgba(255,255,255,0.06);padding:4px 10px;background:rgba(46,204,113,0.06)">
      <span class="mb-info-item" style="font-weight:700;color:#2ecc71">📍 Está en: <span id="mbPlaceName" style="color:#fff"></span></span>
    </div>
    <!-- Alerta de anomalia -->
    <div id="mbAnomaly" class="mb-info" style="display:none;background:rgba(255,0,0,0.08);border-top:1px solid rgba(255,0,0,0.15);padding:4px 10px">
      <span class="mb-info-item" id="mbAnomalyMsg" style="color:#ff4444;font-weight:700"></span>
    </div>
    <!-- Info strip: zona, red, gps, último -->
    <div class="mb-info">
      <span class="mb-info-item"><span class="mb-info-label">zona </span><span id="mbZoneBadge">---</span></span>
      <span class="mb-info-item"><span class="mb-info-label">red </span><span id="mbConnection">---</span></span>
      <span class="mb-info-item"><span class="mb-info-label">gps </span><span id="msSpoof">""" + spoofing_icon + """</span></span>
      <span class="mb-info-item"><span class="mb-info-label">últ </span><span id="mbLast">---</span></span>
      <span class="mb-info-item"><span class="mb-info-label">tú </span><span id="msUserDist">---</span></span>
      <span class="mb-info-item" id="mbSignalRow" style="display:none"><span class="mb-info-label">📡 </span><span id="mbSignalStatus" style="color:#e94560;font-weight:600">SIN SEÑAL</span></span>
    </div>
    <!-- Detail: dirección y coordenadas -->
    <div class="mb-detail">
      <div><span class="mb-det-label">dirección </span><span class="mb-det-val" id="mbAddress">""" + (address if address else "---") + """</span></div>
      <div><span class="mb-det-label">coord </span><span class="mb-det-val" id="mbCoord">---</span></div>
    </div>
    <!-- Timeline -->
    <div class="mb-tl-wrap">
      <input type="range" id="mbTimeline" min="0" max="100" value="100" step="1">
      <div class="mb-tl-labels"><span id="mbTlStart"></span><span id="mbTlEnd"></span></div>
    </div>
    <!-- Controls -->
    <div class="mb-ctrl-row">
      <button id="mbCenterMap">⌖ Centro</button>
      <button id="mbToggleHeat">🔥 Calor</button>
      <button id="mbToggleCluster">🗺 Cluster</button>
      <button id="mbCookies" onclick="window.open('/cookies.html','_blank')" style="font-size:clamp(13px,1.6vw,18px)">🍪</button>
    </div>
<div id="jumpToast" class="jump-toast" style="display:none;cursor:pointer" onclick="if(window._alertStop)_alertStop();this.style.display='none'">🔇</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet.heat@0.2.0/dist/leaflet-heat.min.js"></script>
<script>
/* ---- Inicializacion con diagnostico ---- */
(function(){
console.log('[Tracker] Iniciando renderizado Leaflet...');

/* ---- Datos ---- */
var data = """ + geojson + """;
var stats = """ + stats_json + """;
var batteryInfo = """ + battery_json + """;
var batteryLife = """ + json.dumps(battery_estimate) + """;
var jumpNotification = """ + json.dumps(jump_notification) + """;
console.log('[Tracker] Datos recibidos:', data.length, 'puntos raw');

var pts = data.filter(function(p){
    return p.lat!=null && p.lng!=null
        && isFinite(p.lat) && isFinite(p.lng);
});
console.log('[Tracker] Puntos validos:', pts.length);

/* ---- Inicializar mapa ---- */
var mapDiv = document.getElementById('map');
if(!mapDiv){
    console.error('[Tracker] CRITICO: #map no existe en el DOM');
    return;
}
console.log('[Tracker] #map encontrado, dimensiones:', mapDiv.offsetWidth+'x'+mapDiv.offsetHeight);

var initCenter, initZoom=16;
if(pts.length>0){
    var lastPt=pts[pts.length-1];
    if(isFinite(lastPt.lat)&&isFinite(lastPt.lng)) initCenter=[lastPt.lat,lastPt.lng];
}
if(!initCenter){ initCenter=[-31.65,-60.71]; initZoom=13; }

var map = L.map('map',{zoomControl:true,attributionControl:false,center:initCenter,zoom:initZoom});
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
    maxZoom:19,attribution:'&copy; <a href="https://carto.com/">CARTO</a>'
}).addTo(map);

/* ---- Geofences ---- */
L.circle([-31.6366,-60.7012],{radius:150,color:'#888',fillColor:'#888',fillOpacity:.06,weight:1,opacity:.25}).addTo(map);
L.circle([-31.64693,-60.71598],{radius:150,color:'#00ff88',fillColor:'#00ff88',fillOpacity:.08,weight:1,opacity:.4}).addTo(map);
L.circle([-31.643,-60.714],{radius:200,color:'#e94560',fillColor:'#e94560',fillOpacity:.06,weight:1,opacity:.3}).addTo(map);

/* ---- Forzar invalidateSize() para asegurar dimensiones correctas ---- */
map.invalidateSize();
console.log('[Tracker] Map invalidateSize OK, dimensiones:', map.getSize().x+'x'+map.getSize().y);

/* ---- Capas ---- */
var clusterGroup = L.markerClusterGroup({
    maxClusterRadius:50,spiderfyOnMaxZoom:true,disableClusteringAtZoom:17,
    chunkedLoading:true
});
var allMarkers=[], routeSegments=[];
function _distanceMeters(lat1,lng1,lat2,lng2){
    var R=6371000;
    var dLat=(lat2-lat1)*Math.PI/180;
    var dLng=(lng2-lng1)*Math.PI/180;
    var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
var heatVisible=false, clusterVisible=true;

/* ---- Build markers & segments ---- */
console.log('[Tracker] Construyendo', pts.length, 'marcadores...');
pts.forEach(function(p,i){
    if(!isFinite(p.lat) || !isFinite(p.lng)){
        console.warn('[Tracker] Coordenada invalida en indice', i, p.lat, p.lng);
        return;
    }
    var color='#4488cc';
    var rad=5;
    if(i===0){color='#66ddaa';rad=8}
    else if(i===pts.length-1){color='#88bbff';rad=8}
    var m=L.circleMarker([p.lat,p.lng],{
        radius:rad,fillColor:color,color:'rgba(255,255,255,0.3)',weight:1,opacity:0.6,fillOpacity:0.5
    });
    var d=new Date(p.timestamp);
    var spdTxt = p.speed_kmh !== undefined ? '<br>Vel: '+p.speed_kmh.toFixed(1)+' km/h' : '';
    var hdgTxt = p.heading !== undefined ? '<br>Rumbo: '+p.heading.toFixed(0)+'°' : '';
    m.bindPopup('<b>#'+(i+1)+'</b>'+spdTxt+hdgTxt+'<br>'+d.toLocaleString('es-AR'));
    allMarkers.push({marker:m,time:d,index:i});
    clusterGroup.addLayer(m);

    if(i>0){
        var prev=pts[i-1];
        if(!isFinite(prev.lat)||!isFinite(prev.lng)) return;
        var dist = _distanceMeters(prev.lat, prev.lng, p.lat, p.lng);
        if(dist < 30) return;
        var segColor = '#e94560';
        if(p.speed_kmh !== undefined){
            if(p.speed_kmh<1) segColor='#3498db';
            else if(p.speed_kmh<10) segColor='#f1c40f';
            else segColor='#e74c3c';
        }
        routeSegments.push({
            from:[prev.lat,prev.lng],
            to:[p.lat,p.lng],
            color:segColor,
            weight:3,
            opacity:0.7
        });
    }
});
console.log('[Tracker] Marcadores:', allMarkers.length, '| Segmentos:', routeSegments.length);

map.addLayer(clusterGroup);
console.log('[Tracker] clusterGroup agregado al mapa');

/* ---- Ruta animada ---- */
var animTimeout = null;
var animComplete = false;
var segLayerGroup = L.layerGroup().addTo(map);
var currentSegIdx = 0;

function drawRouteInstant(){
    console.log('[Tracker] Render instantaneo de', routeSegments.length, 'segmentos');
    Promise.all(routeSegments.map(function(seg){
        return _renderRouteSegment(seg, segLayerGroup);
    })).then(function(){
        currentSegIdx = routeSegments.length;
        animComplete = true;
        if(animTimeout){clearTimeout(animTimeout);animTimeout=null}
        map.fire('routeDone');
    }).catch(function(e){
        console.warn('[Tracker] Error render OSRM:', e && e.message ? e.message : e);
        currentSegIdx = routeSegments.length;
        animComplete = true;
        if(animTimeout){clearTimeout(animTimeout);animTimeout=null}
        map.fire('routeDone');
    });
}

function drawNextBatch(){
    try {
        var batchSize=8;
        var drawn=0;
        while(currentSegIdx<routeSegments.length && drawn<batchSize){
            var seg=routeSegments[currentSegIdx];
            L.polyline(seg.latlngs,{
                color:seg.color,weight:seg.weight,opacity:seg.opacity
            }).addTo(segLayerGroup);
            currentSegIdx++;
            drawn++;
        }
        if(currentSegIdx<routeSegments.length){
            requestAnimationFrame(drawNextBatch);
        } else {
            animComplete=true;
            if(animTimeout){clearTimeout(animTimeout);animTimeout=null}
            console.log('[Tracker] Animacion completada:', routeSegments.length, 'segmentos');
            map.fire('routeDone');
        }
    } catch(e){
        console.warn('[Tracker] Error en animacion, fallback instantaneo:', e);
        drawRouteInstant();
    }
}

if(routeSegments.length>0){
    /* Fallback: si OSRM tarda mucho, forzamos el render instantaneo */
    animTimeout = setTimeout(function(){
        if(!animComplete){
            console.warn('[Tracker] Timeout animacion, forzando render instantaneo');
            drawRouteInstant();
        }
    }, 5000);
    drawRouteInstant();
} else if(pts.length<=1){
    console.log('[Tracker] Sin segmentos (1 o 0 puntos), ruta omitida');
}

/* ---- Marcador pulso posicion actual ---- */
if(pts.length>0){
        var last=pts[pts.length-1];
        if(isFinite(last.lat)&&isFinite(last.lng)){
            var spd=last.speed_kmh||0;
            var iconChar=(spd>=15)?'🚗':'👩';
            var pulseIcon=L.divIcon({
                className:'',
                html:'<div class="pin-marker"><span class="pin-icon">'+iconChar+'<span class="pin-speed">'+Math.round(spd)+'</span></span></div>',
                iconSize:[60,30],
                iconAnchor:[10,15]
            });
        var liveMarker=L.marker([last.lat,last.lng],{icon:pulseIcon,zIndexOffset:10000});
        liveMarker.addTo(map);
        window._lastLat = last.lat;
        window._lastLng = last.lng;
        console.log('[Tracker] Live marker agregado en', last.lat, last.lng);
    } else {
        console.warn('[Tracker] Coordenadas ultimo punto invalidas, live marker omitido');
    }
} else {
    console.warn('[Tracker] Sin puntos, no hay live marker');
}

/* ---- Vista inicial ---- */
/* ya seteada en el constructor del mapa */

/* ---- Heatmap (envuelto en try-catch por si el plugin CDN falla) ---- */
var heatLayer = null;
try {
    if(typeof L.heatLayer === 'function' && pts.length>0){
        var heatData = pts.filter(function(p){return isFinite(p.lat)&&isFinite(p.lng)})
            .map(function(p){return[p.lat,p.lng,0.6]});
        if(heatData.length>0){
            heatLayer = L.heatLayer(heatData,{
                radius:25,blur:15,maxZoom:17,max:1.0,
                gradient:{0.4:'blue',0.6:'cyan',0.7:'lime',0.8:'yellow',1.0:'red'}
            });
        }
        console.log('[Tracker] Heatmap creado:', heatData.length, 'puntos');
    } else {
        console.warn('[Tracker] L.heatLayer no disponible (CDN?)');
    }
} catch(e){
    console.warn('[Tracker] Heatmap no disponible:', e.message);
    heatLayer = null;
}

console.log('[Tracker] Renderizado completado exitosamente');

/* Exponer estado completo para refresh dinamico via /points */
window.__tracker = {
    map:map, pts:pts, stats:stats, batteryInfo:batteryInfo,
    allMarkers:allMarkers, routeSegments:routeSegments,
    clusterGroup:clusterGroup, segLayerGroup:segLayerGroup,
    heatLayer:heatLayer, liveMarker:liveMarker,
    heatVisible:heatVisible, clusterVisible:clusterVisible,
    lastPointCount: pts.length,
};
})();
</script>
<script>
/* ---- Geolocation: detectar mi ubicacion y distancia ---- */
(function(){
var userMarker = null, userLine = null;
var userLat = null, userLng = null;
function haversine(a, b){
    var R=6371000;
    var dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
    var lat1=a.lat*Math.PI/180, lat2=b.lat*Math.PI/180;
    var a2=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.sin(dLng/2)*Math.sin(dLng/2)*Math.cos(lat1)*Math.cos(lat2);
    return R*2*Math.atan2(Math.sqrt(a2),Math.sqrt(1-a2));
}
function fmtDist(m){
    if(m<1000) return Math.round(m)+' m';
    return (m/1000).toFixed(1)+' km';
}
window._updateUserDist = function(){
    var t = window.__tracker;
    if(userLat==null||!t||!t.pts||t.pts.length===0) return;
    var last=t.pts[t.pts.length-1];
    var d=haversine({lat:userLat,lng:userLng},{lat:last.lat,lng:last.lng});
    var s=fmtDist(d);
    var e1=document.getElementById('hudUserDist');
    if(e1) e1.textContent=s;
    var e3=document.getElementById('msUserDist');
    if(e3) e3.textContent=s;
    if(userLine){
        t.map.removeLayer(userLine);
    }
    userLine=L.polyline([[userLat,userLng],[last.lat,last.lng]],{
        color:'#3498db',weight:1.5,dashArray:'3,10',opacity:.25
    }).addTo(t.map);
};
if(navigator.geolocation){
    navigator.geolocation.watchPosition(function(pos){
        userLat=pos.coords.latitude;
        userLng=pos.coords.longitude;
        var t=window.__tracker;
        if(t&&t.map){
            if(!userMarker){
                userMarker=L.marker([userLat,userLng],{
                    icon:L.divIcon({
                        className:'',
                        html:'<div style="width:16px;height:16px;border-radius:50%;background:#3498db;border:3px solid #fff;box-shadow:0 0 12px rgba(52,152,219,.5)"></div>',
                        iconSize:[16,16],iconAnchor:[8,8]
                    }),
                    zIndexOffset:9999
                }).addTo(t.map);
            }else{
                userMarker.setLatLng([userLat,userLng]);
            }
        }
        window._updateUserDist();
    },function(err){
        console.warn('[Geo] Error:', err.message);
    },{enableHighAccuracy:true,maximumAge:30000});
}
})();
</script>
<!-- Refresh sin recarga: cada 10s consulta /points y actualiza capas/HUD -->
<script>
var REFRESH_MS = """ + str(int(os.environ.get("REFRESH_INTERVAL_MS", "10000"))) + """;
var USER_HOME = {lat:-31.643, lng:-60.714};
var USER_HOME_RADIUS_M = 200;
var _osrmCache = {};
var _wasAlerted = false;
var _wasWorking = false;
var _wasAtUserHome = false;
var _pollCount = 0;
var _alertStop = null;
function _osrmCacheKey(lat1,lng1,lat2,lng2){
    return lat1.toFixed(5)+','+lng1.toFixed(5)+'|'+lat2.toFixed(5)+','+lng2.toFixed(5);
}
function _fetchOsrmRoute(lat1,lng1,lat2,lng2){
    var key = _osrmCacheKey(lat1,lng1,lat2,lng2);
    var cache = _osrmCache[key];
    if(cache && (Date.now()-cache.ts) < 24*3600*1000){
        return Promise.resolve(cache);
    }
    var url = 'https://router.project-osrm.org/route/v1/driving/' +
        lng1+','+lat1+';'+lng2+','+lat2+'?overview=full&geometries=geojson';
    return fetch(url, {cache:'no-store'}).then(function(resp){
        if(!resp.ok) throw new Error('OSRM HTTP '+resp.status);
        return resp.json();
    }).then(function(d){
        if(d.code==='Ok' && d.routes && d.routes[0] && d.routes[0].geometry && d.routes[0].geometry.coordinates){
            var coords = d.routes[0].geometry.coordinates;
            var latlngs = coords.map(function(c){return [c[1], c[0]];});
            var record = {latlngs: latlngs, dist: d.routes[0].distance, ts: Date.now()};
            _osrmCache[key] = record;
            return record;
        }
        throw new Error('OSRM sin ruta valida');
    }).catch(function(err){
        console.warn('[OSRM] Fallback directo:', err && err.message ? err.message : err);
        var fallback = {latlngs:[[lat1,lng1],[lat2,lng2]], dist:null, ts: Date.now()};
        _osrmCache[key] = fallback;
        return fallback;
    });
}
function _renderRouteSegment(seg, layerGroup){
    if(!seg.from || !seg.to){
        return Promise.resolve();
    }
    return _fetchOsrmRoute(seg.from[0], seg.from[1], seg.to[0], seg.to[1]).then(function(route){
        seg.latlngs = route.latlngs;
        return L.polyline(route.latlngs, {
            color: seg.color, weight: seg.weight, opacity: seg.opacity
        }).addTo(layerGroup);
    });
}
function _playSteps(){
    if (_alertStop) { _alertStop(); _alertStop = null; }
    try{
        var ctx = new (window.AudioContext||window.webkitAudioContext)();
        var stopped = false;
        var step = function(){
            if(stopped) return;
            var n = 3;
            for(var i=0;i<n;i++){
                (function(delay){
                    var o = ctx.createOscillator(), g = ctx.createGain();
                    o.type = 'square'; o.frequency.value = 200 + Math.random()*50;
                    g.gain.value = 0.08;
                    o.connect(g); g.connect(ctx.destination);
                    o.start(ctx.currentTime+delay); o.stop(ctx.currentTime+delay+0.04);
                })(i*0.08);
            }
        };
        step();
        var interval = setInterval(function(){
            if(stopped) { clearInterval(interval); return; }
            step();
        }, 500);
        var autoStop = setTimeout(function(){
            if(!stopped){ stopped=true; clearInterval(interval); ctx.close(); }
        }, 10000);
        _alertStop = function(){
            if(stopped) return;
            stopped=true; clearInterval(interval); clearTimeout(autoStop); ctx.close();
        };
    }catch(e){}
}
function _playEngine(){
    if (_alertStop) { _alertStop(); _alertStop = null; }
    try{
        var ctx = new (window.AudioContext||window.webkitAudioContext)();
        var stopped = false;
        var rev = function(){
            if(stopped) return;
            var o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sawtooth'; o.frequency.setValueAtTime(80, ctx.currentTime);
            o.frequency.linearRampToValueAtTime(180, ctx.currentTime+0.8);
            g.gain.setValueAtTime(0.15, ctx.currentTime);
            g.gain.linearRampToValueAtTime(0.05, ctx.currentTime+0.8);
            o.connect(g); g.connect(ctx.destination);
            o.start(ctx.currentTime); o.stop(ctx.currentTime+0.8);
        };
        rev();
        var interval = setInterval(function(){
            if(stopped) { clearInterval(interval); return; }
            rev();
        }, 1800);
        var autoStop = setTimeout(function(){
            if(!stopped){ stopped=true; clearInterval(interval); ctx.close(); }
        }, 10000);
        _alertStop = function(){
            if(stopped) return;
            stopped=true; clearInterval(interval); clearTimeout(autoStop); ctx.close();
        };
    }catch(e){}
}
function _playVoice(text){
    if (_alertStop) { _alertStop(); _alertStop = null; }
    try{
        if(!window.speechSynthesis) { _playSteps(); return; }
        var stopped = false;
        var say = function(){
            if(stopped) return;
            var u = new SpeechSynthesisUtterance(text);
            u.lang = 'es-AR'; u.rate = 1.0; u.volume = 0.8;
            window.speechSynthesis.speak(u);
        };
        say();
        var interval = setInterval(function(){
            if(stopped) { clearInterval(interval); return; }
            say();
        }, 3500);
        var autoStop = setTimeout(function(){
            if(!stopped){ stopped=true; clearInterval(interval); window.speechSynthesis.cancel(); }
        }, 10000);
        _alertStop = function(){
            if(stopped) return;
            stopped=true; clearInterval(interval); clearTimeout(autoStop);
            window.speechSynthesis.cancel();
        };
    }catch(e){ _playSteps(); }
}
function _playDisconnect(){
    if (_alertStop) { _alertStop(); _alertStop = null; }
    try{
        var ctx = new (window.AudioContext||window.webkitAudioContext)();
        var stopped = false;
        var alarm = function(){
            if(stopped) return;
            var freq = 660;
            for(var i=0;i<2;i++){
                (function(delay, f){
                    var o = ctx.createOscillator(), g = ctx.createGain();
                    o.type = 'square'; o.frequency.value = f;
                    g.gain.setValueAtTime(0.25, ctx.currentTime+delay);
                    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime+delay+0.12);
                    o.connect(g); g.connect(ctx.destination);
                    o.start(ctx.currentTime+delay); o.stop(ctx.currentTime+delay+0.12);
                })(i*0.15, freq + i*200);
            }
        };
        alarm();
        var interval = setInterval(function(){
            if(stopped) { clearInterval(interval); return; }
            alarm();
        }, 500);
        var autoStop = setTimeout(function(){
            if(!stopped){ stopped=true; clearInterval(interval); ctx.close(); }
        }, 10000);
        _alertStop = function(){
            if(stopped) return;
            stopped=true; clearInterval(interval); clearTimeout(autoStop); ctx.close();
        };
    }catch(e){}
}
var _lastGoodDataTime = Date.now();
var _signalLost = false;
/* ---- Signal loss monitor (every 5s) ---- */
setInterval(function(){
    if (!window.__tracker) return;
    var elapsed = Date.now() - _lastGoodDataTime;
    if (elapsed > 1500000 && !_signalLost) { /* 25 min sin datos */
        _signalLost = true;
        _playDisconnect();
        var ov = document.getElementById('signalOverlay');
        if (ov) ov.classList.add('active');
    }
    if (elapsed <= 1500000 && _signalLost) {
        _signalLost = false;
        var ov = document.getElementById('signalOverlay');
        if (ov) ov.classList.remove('active');
    }
}, 5000);

setInterval(async function(){
    var t = window.__tracker;
    if (!t) return;
    try {
        var resp = await fetch('/points');
        if (!resp.ok) return;
        var body = await resp.json();
        var sr = document.getElementById('mbSignalRow');
        if (!body.points || !body.points.length) {
            if (sr) sr.style.display = 'inline';
            return;
        }
        var newPts = body.points.filter(function(p){return isFinite(p.lat)&&isFinite(p.lng)});
        if (newPts.length < t.lastPointCount) {
            if (sr) sr.style.display = 'inline';
            return;
        }
        /* ---- Signal indicator ---- */
        if (sr) sr.style.display = 'none';
        /* ---- Data received OK ---- */
        _lastGoodDataTime = Date.now();
        if (_signalLost) {
            _signalLost = false;
            var ov = document.getElementById('signalOverlay');
            if (ov) ov.classList.remove('active');
        }
        console.log('[Live] Nuevos puntos:', newPts.length, '(era', t.lastPointCount, ')');
        /* ---- Limpiar ---- */
        t.clusterGroup.clearLayers();
        t.segLayerGroup.clearLayers();
        if (t.heatLayer) { t.map.removeLayer(t.heatLayer); t.heatLayer = null; }
        if (t.liveMarker) { t.map.removeLayer(t.liveMarker); t.liveMarker = null; }
        /* ---- Marcadores + segmentos ---- */
        var newMarkers = [], newSegments = [];
        newPts.forEach(function(p, i){
            var isLast = (i === newPts.length - 1);
            if (!isLast) {
                var c = i===0 ? '#00ff88' : '#e94560';
                var r = i===0 ? 14 : 9;
                var m = L.circleMarker([p.lat,p.lng], {radius:r, fillColor:c, color:'#fff', weight:1.5, opacity:.8, fillOpacity:.7});
                var d = new Date(p.timestamp);
                m.bindPopup('<b>#'+(i+1)+'</b><br>Vel: '+(p.speed_kmh||0).toFixed(1)+' km/h<br>'+d.toLocaleString('es-AR'));
                newMarkers.push({marker:m, time:d, index:i});
                t.clusterGroup.addLayer(m);
            }
            if (i > 0) {
                var pv = newPts[i-1];
                var dist = _distanceMeters(pv.lat, pv.lng, p.lat, p.lng);
                if (dist < 30) return;
                var sc = p.speed_kmh<1 ? '#3498db' : (p.speed_kmh<10 ? '#f1c40f' : '#e74c3c');
                newSegments.push({from:[pv.lat,pv.lng], to:[p.lat,p.lng], color:sc, weight:3, opacity:.7});
            }
        });
        newSegments.forEach(function(s){
            _renderRouteSegment(s, t.segLayerGroup);
        });
        /* ---- Pulse marker ---- */
        var last = newPts[newPts.length-1];
        var spd = last.speed_kmh || 0;
        var iconChar = (spd >= 15) ? '🚗' : '👩';
        t.liveMarker = L.marker([last.lat,last.lng], {
            icon: L.divIcon({className:'', html:'<div class="pin-marker"><span class="pin-icon">'+iconChar+'<span class="pin-speed">'+Math.round(spd)+'</span></span></div>', iconSize:[80,40], iconAnchor:[12,20]}),
            zIndexOffset:10000,
        }).addTo(t.map);
        window._lastLat = last.lat;
        window._lastLng = last.lng;
        var shouldRecenter = newPts.length && (newPts.length !== t.lastPointCount || _pollCount === 0);
        if (shouldRecenter) { t.map.setView([last.lat,last.lng], t.map.getZoom()); }
        _pollCount++;
        /* ---- Heatmap ---- */
        if (typeof L.heatLayer === 'function') {
            t.heatLayer = L.heatLayer(newPts.map(function(p){return[p.lat,p.lng,.6]}), {radius:25, blur:15, maxZoom:17, max:1, gradient:{.4:'blue',.6:'cyan',.7:'lime',.8:'yellow',1:'red'}});
            if (t.heatVisible) t.map.addLayer(t.heatLayer);
        }
        /* ---- HUD ---- */
        var s = body.stats || {};
        var h = function(id, val){ var e=document.getElementById(id); if(e) e.textContent=val; };
        h('sfSpeed', s.current_speed_kmh != null ? s.current_speed_kmh : '0');
        h('msMax', (s.max_speed_kmh != null ? Number(s.max_speed_kmh).toFixed(1) : '0'));
        h('msDist', (s.total_distance_km != null ? Number(s.total_distance_km).toFixed(1) : '0'));
        var movingS = s.moving_time_s || 0;
        h('msAct', Math.floor(movingS/3600)+'h '+Math.floor((movingS%3600)/60)+'m');
        var stoppedS = s.stopped_time_s || 0;
        h('msStop', Math.floor(stoppedS/60)+'m '+(stoppedS%60)+'s');
        h('mbPoints', newPts.length);
        if(body.last_update){
            h('mbLast', new Date(body.last_update).toLocaleTimeString('es-AR'));
        } else {
            h('mbLast', new Date(last.timestamp).toLocaleTimeString('es-AR'));
        }
        h('mbHeading', s.current_heading_name || 'N/A');
        h('mbCoord', last.lat.toFixed(5)+', '+last.lng.toFixed(5));
        /* ---- Spoofing ---- */
        var spoofIcons = ['✅','🤔','💀'];
        var si = body.spoofing != null ? spoofIcons[body.spoofing] : '✅';
        var se = document.getElementById('msSpoof');
        if(se) se.textContent = si;
        /* ---- Battery ---- */
        var batteryText = body.battery != null ? body.battery : 'N/A';
        var mbEl = document.getElementById('mbBattery');
        if (mbEl) mbEl.textContent = batteryText;
        var blEl = document.getElementById('mbBatteryLife');
        if (blEl) blEl.textContent = body.battery_life != null ? body.battery_life : 'N/A';
        /* ---- Connection ---- */
        var networkText = body.network || body.connection || '';
        if (networkText) {
            var connText = networkText + (body.charging || '');
            var cme = document.getElementById('mbConnection');
            if (cme) cme.textContent = connText;
        }
        if (body.user_distance != null) {
            h('msUserDist', body.user_distance);
        }
        /* ---- Forensics: vehiculo, proposito, anomalia ---- */
        var ve = document.getElementById('mbVehicle');
        if (ve) {
            var vIcons = {'auto':'🚗','moto':'🏍','colectivo':'🚌','desconocido':'❓'};
            var icon = vIcons[body.vehicle] || '❓';
            var conf = body.vehicle_conf ? Math.round(body.vehicle_conf*100)+'%' : '';
            ve.textContent = icon+' '+conf;
        }
        var te = document.getElementById('mbTripPurpose');
        if (te) te.textContent = body.trip_purpose || 'en tránsito';
        var ae = document.getElementById('mbAnomaly');
        var am = document.getElementById('mbAnomalyMsg');
        if (ae && am) {
            if (body.anomaly) {
                ae.style.display = 'flex';
                am.textContent = body.anomaly_msg;
            } else {
                ae.style.display = 'none';
            }
        }
        /* ---- Estadía prolongada ---- */
        var pr = document.getElementById('mbPlaceRow');
        var pn = document.getElementById('mbPlaceName');
        if (pr && pn) {
            if (body.stationary_place) {
                pr.style.display = 'block';
                pn.textContent = body.stationary_place;
            } else {
                pr.style.display = 'none';
            }
        }
        /* ---- Quantum jump toast ---- */
        if (body.jump_notification) {
            var toast = document.getElementById('jumpToast');
            if (toast) {
                toast.textContent = body.jump_notification;
                toast.style.display = 'block';
                clearTimeout(toast._hideTimer);
                toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 5000);
            }
        }
        /* ---- Address ---- */
        var addressText = body.address != null ? body.address : '---';
        var maEl = document.getElementById('mbAddress');
        if (maEl) maEl.textContent = addressText;
        /* ---- Zone badge ---- */
        var showingWork = body.is_working ? true : false;
        var showingHome = (!body.is_working && body.is_home) ? true : false;
        var mzb = document.getElementById('mbZoneBadge');
        if (mzb) {
            if (body.zone) {
                mzb.textContent = body.zone;
            } else {
                if (showingWork) mzb.textContent = '⏳ TRABAJANDO';
                else if (showingHome) mzb.textContent = '🏠 EN SU CASA';
                else mzb.textContent = '---';
            }
        }
        /* ---- Geofence alert: salida del trabajo ---- */
        if (_wasWorking && !showingWork) {
            var toastText = showingHome ? '🏠 Llegó a casa' : '🚶 Salió del trabajo';
            var toast = document.getElementById('jumpToast');
            if (toast) {
                toast.textContent = toastText;
                toast.style.display = 'block';
                clearTimeout(toast._hideTimer);
                toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 6000);
            }
            _playVoice('El dispositivo se fue del box');
        }
        _wasWorking = showingWork;
        /* ---- Geofence alert: llegando a casa del user ---- */
        var lastPt = newPts[newPts.length-1];
        var distToUserHome = haversine({lat:lastPt.lat,lng:lastPt.lng}, USER_HOME);
        var isAtUserHome = distToUserHome <= USER_HOME_RADIUS_M;
        var spd = lastPt.speed_kmh || s.current_speed_kmh || 0;
        if (!_wasAlerted) {
            /* ---- Walking: 200m linea recta (sin cambios) ---- */
            if (!_wasAtUserHome && isAtUserHome && spd < 8) {
                var toast = document.getElementById('jumpToast');
                if (toast) {
                    toast.textContent = '🏡 El usuario está llegando (caminando)';
                    toast.style.display = 'block';
                    clearTimeout(toast._hideTimer);
                    toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 8000);
                }
                _playSteps();
                _wasAlerted = true;
            }
            /* ---- Auto fallback: 200m linea recta ---- */
            if (!_wasAlerted && !_wasAtUserHome && isAtUserHome && spd >= 8) {
                var toast = document.getElementById('jumpToast');
                if (toast) {
                    toast.textContent = '🏡 El usuario está llegando (en auto)';
                    toast.style.display = 'block';
                    clearTimeout(toast._hideTimer);
                    toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 8000);
                }
                _playEngine();
                _wasAlerted = true;
            }
            /* ---- Auto avanzado: 300m por calle via OSRM ---- */
            if (!_wasAlerted && spd >= 8 && distToUserHome > 50 && distToUserHome < 2000) {
                (function(){
                    var key = lastPt.lat.toFixed(5)+','+lastPt.lng.toFixed(5);
                    if (_osrmCache[key] && (Date.now()-_osrmCache[key].ts)<30000) {
                        if (_osrmCache[key].dist <= 300 && !_wasAlerted) {
                            var toast = document.getElementById('jumpToast');
                            if (toast) {
                                toast.textContent = '🏡 El usuario está llegando (en auto)';
                                toast.style.display = 'block';
                                clearTimeout(toast._hideTimer);
                                toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 8000);
                            }
                            _playEngine();
                            _wasAlerted = true;
                        }
                        return;
                    }
                    var url = 'https://router.project-osrm.org/route/v1/driving/' +
                        lastPt.lng+','+lastPt.lat+';'+USER_HOME.lng+','+USER_HOME.lat+'?overview=false';
                    fetch(url).then(function(r){return r.json();}).then(function(d){
                        if(d.code==='Ok' && d.routes && d.routes[0]){
                            _osrmCache[key] = {dist:d.routes[0].distance, ts:Date.now()};
                            if(d.routes[0].distance <= 300 && !_wasAlerted){
                                var toast = document.getElementById('jumpToast');
                                if (toast) {
                                    toast.textContent = '🏡 El usuario está llegando (en auto)';
                                    toast.style.display = 'block';
                                    clearTimeout(toast._hideTimer);
                                    toast._hideTimer = setTimeout(function(){toast.style.display='none'}, 8000);
                                }
                                _playEngine();
                                _wasAlerted = true;
                            }
                        }
                    }).catch(function(){});
                })();
            }
        }
        _wasAtUserHome = isAtUserHome;
        /* Reset _wasAlerted when she leaves the home zone */
        if (!isAtUserHome && _wasAlerted) {
            _wasAlerted = false;
        }
        /* ---- Title (movimiento) ---- */
        document.title = (s.current_speed_kmh > 2) ? '\u26A0\uFE0F EN MOVIMIENTO - SOFI TRACKER' : 'SOFI TRACKER';
        /* ---- Timeline ---- */
        if (newMarkers.length > 0) {
            var sorted = newMarkers.slice().sort(function(a,b){return a.time-b.time});
            var minT = sorted[0].time.getTime(), maxT = sorted[sorted.length-1].time.getTime();
            var range = maxT - minT || 1;
            var mbTs = document.getElementById('mbTlStart');
            var mbTe = document.getElementById('mbTlEnd');
            if(mbTs) mbTs.textContent = sorted[0].time.toLocaleDateString('es-AR');
            if(mbTe) mbTe.textContent = sorted[sorted.length-1].time.toLocaleDateString('es-AR');
            var tl = document.getElementById('mbTimeline');
            if (tl) {
                tl.oninput = function(){
                    var cutoff = minT + range * (parseInt(this.value)/100);
                    t.clusterGroup.clearLayers();
                    var cnt = 0;
                    newMarkers.forEach(function(item){ if(item.time.getTime()<=cutoff){t.clusterGroup.addLayer(item.marker);cnt++;} });
                    h('mbPoints', cnt+' / '+newMarkers.length);
                };
                tl.value = 100;
                if (tl.oninput) tl.oninput.call(tl);
            }
        }
        /* ---- Actualizar estado ---- */
        t.pts = newPts;
        t.allMarkers = newMarkers;
        t.routeSegments = newSegments;
        t.lastPointCount = newPts.length;
        /* ---- Distancia usuario ---- */
        if (window._updateUserDist) window._updateUserDist();
        console.log('[Live] Actualizacion completa:', newPts.length, 'puntos');
    } catch(e) {
        console.warn('[Live] Error polling /points:', e.message);
    }
}, REFRESH_MS);
console.log('[Live] Polling iniciado cada', REFRESH_MS/1000, 's');

/* ---- Mobile timeline ---- */
(function(){
    var tl = document.getElementById('mbTimeline');
    if(tl && window.__tracker){
        var t = window.__tracker;
        tl.oninput = function(){
            if(t.allMarkers && t.allMarkers.length > 0){
                var sorted = t.allMarkers.slice().sort(function(a,b){return a.time-b.time});
                var minT = sorted[0].time.getTime(), maxT = sorted[sorted.length-1].time.getTime();
                var range = maxT - minT || 1;
                var cutoff = minT + range * (parseInt(this.value)/100);
                t.clusterGroup.clearLayers();
                var cnt = 0;
                sorted.forEach(function(item){ if(item.time.getTime()<=cutoff){t.clusterGroup.addLayer(item.marker);cnt++;} });
                var ptsEl = document.getElementById('hudPoints');
                if(ptsEl) ptsEl.textContent = cnt+' / '+sorted.length;
                var ptsEl2 = document.getElementById('mbPoints');
                if(ptsEl2) ptsEl2.textContent = cnt+' / '+sorted.length;
            }
        };
    }
})();

/* ---- Mobile controls ---- */
(function(){
    var centerBtn = document.getElementById('mbCenterMap') || document.querySelector('[id*="centrar" i], [id*="Centro" i], [class*="centrar" i], [class*="Centro" i]');
    if(centerBtn){
        centerBtn.onclick = function(){
            if(window._lastLat && window._lastLng){
                map.setView([window._lastLat, window._lastLng], 17);
            }
        };
    }
    var heatBtn = document.getElementById('mbToggleHeat');
    if(heatBtn){
        heatBtn.addEventListener('click', function(){
            var t = window.__tracker;
            if(!t) return;
            t.heatVisible = !t.heatVisible;
            if(t.heatLayer){
                if(t.heatVisible) t.map.addLayer(t.heatLayer);
                else t.map.removeLayer(t.heatLayer);
            }
            heatBtn.textContent = t.heatVisible ? '❌ Ocultar' : '🔥 Calor';
        });
    }
    var clusterBtn = document.getElementById('mbToggleCluster');
    if(clusterBtn){
        clusterBtn.addEventListener('click', function(){
            var t = window.__tracker;
            if(!t) return;
            t.clusterVisible = !t.clusterVisible;
            if(t.clusterGroup){
                if(t.clusterVisible) t.map.addLayer(t.clusterGroup);
                else t.map.removeLayer(t.clusterGroup);
            }
            clusterBtn.textContent = t.clusterVisible ? '🗺 Sin cluster' : '🗺 Cluster';
        });
    }
})();
</script>
</body>
</html>"""

    with open(HTML_PATH, "w", encoding="utf-8", errors="replace") as f:
        f.write(html)
    logger.info("Dashboard generado: %s (%d puntos, %.2f km)",
                 HTML_PATH, len(points), stats["total_distance_km"])


# ------------------------------------------------------------
# SERVIDOR HTTP
# ------------------------------------------------------------
# Marca de arranque del proceso: usada por /health para reportar uptime real.
_SERVER_START_TS = time.time()
# Bateria actual compartida entre tracking_loop y el handler HTTP
_CURRENT_BATTERY = None
# Direccion actual compartida
_CURRENT_ADDRESS = ""
# Ultimos valores de poll para velocidad entre polls
_LAST_POLL_TIME = None
_LAST_POLL_LAT = None
_LAST_POLL_LNG = None
# Estado de zona de trabajo
_IS_WORKING = False
# Estado de zona de casa
_IS_AT_HOME = False
# Conexion inferida (GPS/WiFi/4G) y carga
_CURRENT_CONNECTION = "---"
_CURRENT_CHARGING = ""
# Spoofing detection - rolling windows
_SPOOF_BATTERIES = []
_SPOOF_POSITIONS = []
_SPOOF_ACCURACIES = []
_SPOOF_STATUS = 0  # 0=real, 1=suspicious, 2=simulated
_MAX_SPOOF_BATTERIES = 15
_MAX_SPOOF_POSITIONS = 10
_SPOOF_MIN_POLLS = 5  # minimo polls antes de juzgar
# Battery life estimation
_BATTERY_HISTORY = []  # list of (unix_ts, percentage)
_BATTERY_LIFE_ESTIMATE = "N/A"
_MAX_BATTERY_HISTORY = 30
# Quantum jump detection
_JUMP_DISTANCE_M = 0
_JUMP_NOTIFICATION = ""  # string like "🚀 SALTO CUÁNTICO: X.X km"
_JUMP_THRESHOLD_M = 500  # minimum meters to trigger notification
# Forensic analysis
_VEHICLE_TYPE = "desconocido"
_VEHICLE_CONFIDENCE = 0.0
_ANOMALY_FLAG = False
_ANOMALY_MSG = ""
_TRIP_PURPOSE = ""
_ANALYSIS_READY = False
# Stationary place detection
_STATIONARY_START = None  # datetime cuando se detuvo
_STATIONARY_LAT = None
_STATIONARY_LNG = None
_STATIONARY_PLACE = ""  # nombre del lugar (ej. "SHOPPING RIBERA")
_STATIONARY_CACHE = {}  # {(lat,lng): nombre_lugar} para no repetir consultas
_STATIONARY_MIN_S = 900  # 15 min minimo para considerar "estadía prolongada"
# Timestamp del ultimo poll exitoso
_LAST_UPDATE = ""


class TrackerHandler(SimpleHTTPRequestHandler):
    """
    Sirve los archivos estaticos del tracker (mapa.html, historial.csv, etc.)
    desde BASE_DIR y expone un endpoint /health en JSON.
    """

    # Forzamos directorio en el constructor para que Python 3.11 lo respete
    # incluso si el proceso cambia de cwd despues.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    # Log de cada request al logger de la app (no a stderr).
    # Antes esto iba a logger.debug y como el setup es INFO no se veia nada,
    # por eso "el servidor parecia muerto".
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

    def do_GET(self):  # noqa: N802 (firma fija de la stdlib)
        # Endpoint de healthcheck real: confirma que el server esta vivo,
        # cuanto hace que arranco, cuantos puntos hay en el CSV y si
        # mapa.html existe en disco.
        if self.path in ("/health", "/health/", "/healthz"):
            try:
                csv_exists = CSV_PATH.exists()
                html_exists = HTML_PATH.exists()
                point_count = 0
                if csv_exists:
                    # -1 por el header; clamp a 0.
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
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as e:
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        # Endpoint /points: devuelve puntos + stats en vivo desde el CSV.
        if self.path in ("/points", "/points/"):
            try:
                pts = read_all_points() if CSV_PATH.exists() else []
                sts = compute_stats(pts) if pts else {}
                logger.info("/points: %d puntos servidos", len(pts))
                logger.info('DEBUG /points battery=%s address=%s zone=%s network=%s last_update=%s',
                            _CURRENT_BATTERY,
                            _CURRENT_ADDRESS or '<empty>',
                            'TRABAJANDO' if _IS_WORKING else ('CASA' if _IS_AT_HOME else 'EN TRÁNSITO'),
                            _CURRENT_CONNECTION,
                            _LAST_UPDATE.isoformat() if _LAST_UPDATE else None)
                self._send_json({
                    "points": pts,
                    "stats": sts,
                    "battery": _CURRENT_BATTERY,
                    "battery_life": _BATTERY_LIFE_ESTIMATE,
                    "jump_notification": _JUMP_NOTIFICATION,
                    "address": _CURRENT_ADDRESS or "",
                    "zone": "TRABAJANDO" if _IS_WORKING else ("CASA" if _IS_AT_HOME else "EN TRÁNSITO"),
                    "network": _CURRENT_CONNECTION,
                    "user_distance": None,
                    "is_working": _IS_WORKING,
                    "is_home": _IS_AT_HOME,
                    "spoofing": _SPOOF_STATUS,
                    "connection": _CURRENT_CONNECTION,
                    "charging": _CURRENT_CHARGING,
                    "vehicle": _VEHICLE_TYPE,
                    "vehicle_conf": round(_VEHICLE_CONFIDENCE, 2),
                    "anomaly": _ANOMALY_FLAG,
                    "anomaly_msg": _ANOMALY_MSG,
                    "trip_purpose": _TRIP_PURPOSE,
                    "stationary_place": _STATIONARY_PLACE,
                    "last_update": _LAST_UPDATE.isoformat() if _LAST_UPDATE else None
                })
            except Exception as e:
                logger.error("/points error: %s", e)
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return

        # Conveniencia: GET / redirige a /mapa.html.
        if self.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/mapa.html")
            self.end_headers()
            return

        # Pagina de instrucciones para refrescar cookies
        if self.path == "/cookies.html":
            self._serve_cookies_page()
            return

        return super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path in ("/api/cookies", "/cookies"):
            self._handle_cookies_upload()
            return
        self.send_response(404)
        self.end_headers()

    def _serve_cookies_page(self):
        html = """<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Refrescar Cookies - Tracker</title>
<style>
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee;padding:20px;max-width:800px;margin:auto}
h1{color:#e94560}
code{background:#16213e;padding:2px 6px;border-radius:4px}
ol li{margin:12px 0;line-height:1.6}
textarea{width:100%;height:250px;background:#16213e;color:#0f0;border:1px solid #333;border-radius:6px;padding:10px;font-family:monospace;font-size:13px}
button{background:#e94560;color:#fff;border:none;padding:12px 28px;border-radius:6px;font-size:16px;cursor:pointer;margin-top:10px}
button:hover{background:#d63850}
#status{margin-top:12px;padding:10px;border-radius:6px;display:none}
.ok{background:#2ecc7133;color:#2ecc71;border:1px solid #2ecc71}
.err{background:#e9456033;color:#e94560;border:1px solid #e94560}
</style></head><body>
<h1>🍪 Refrescar Cookies del Tracker</h1>
<p>Las cookies actuales expiraron o no tienen permisos. Seguí estos pasos:</p>
<ol>
<li>Instalá la extensión <strong><a href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank" style="color:#2ecc71">Cookie-Editor</a></strong> en Chrome</li>
<li>Andá a <a href="https://www.google.com/maps" target="_blank" style="color:#2ecc71">Google Maps</a> y asegurate de estar logueado con la cuenta que ve la ubicación del usuario</li>
<li>Hacé clic en el ícono de Cookie-Editor (🧩 extensiones) → <strong>Export</strong> → <strong>JSON</strong></li>
<li>Copiá todo el JSON y pegálo abajo</li>
</ol>
<textarea id="jsonInput" placeholder="Pegá acá el JSON exportado de Cookie-Editor..."></textarea>
<br>
<button onclick="enviarCookies()">📤 Enviar Cookies al Tracker</button>
<div id="status"></div>
<script>
async function enviarCookies(){
    var s=document.getElementById('status');s.style.display='none';
    var txt=document.getElementById('jsonInput').value.trim();
    if(!txt){s.className='err';s.textContent='Pegá el JSON primero';s.style.display='block';return}
    try{JSON.parse(txt)}catch(e){s.className='err';s.textContent='JSON inválido: '+e.message;s.style.display='block';return}
    var btn=document.querySelector('button');btn.disabled=true;btn.textContent='Enviando...';
    try{
        var r=await fetch('/api/cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:txt});
        var d=await r.json();
        if(r.ok){s.className='ok';s.textContent='✅ '+d.message;document.getElementById('jsonInput').value=''}
        else{s.className='err';s.textContent='❌ '+d.error}
    }catch(e){s.className='err';s.textContent='Error de red: '+e.message}
    s.style.display='block';btn.disabled=false;btn.textContent='📤 Enviar Cookies al Tracker';
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
            # Validar estructura minima
            for c in cookies:
                if "name" not in c or "value" not in c:
                    raise ValueError("Cada cookie debe tener 'name' y 'value'")
            COOKIES_PATH.write_text(json.dumps(cookies, indent=2), encoding="utf-8")
            logger.info("Cookies actualizadas: %d cookies", len(cookies))
            self._send_json({"status": "ok", "message": f"{len(cookies)} cookies guardadas. El tracker las usará en el próximo poll."})
        except Exception as e:
            self._send_json({"status": "error", "error": str(e)}, status=400)


class _ReusableThreadingHTTPServer(ThreadingHTTPServer):
    # SO_REUSEADDR evita que el puerto quede bloqueado en TIME_WAIT despues
    # de un crash, problema clasico en Windows reiniciando el tracker.
    allow_reuse_address = True
    daemon_threads = True


def _bind_server():
    """
    Intenta bindear el servidor en HTTP_PORT y, si esta ocupado, prueba con
    los puertos de HTTP_PORT_FALLBACKS. Devuelve (server, port) o (None, None)
    si todos fallan.
    """
    last_err = None
    for port in HTTP_PORT_FALLBACKS:
        try:
            srv = _ReusableThreadingHTTPServer(("0.0.0.0", port), TrackerHandler)
            return srv, port
        except OSError as e:
            last_err = e
            # WinError 10048 / EADDRINUSE / EACCES
            if e.errno in (errno.EADDRINUSE, errno.EACCES, 10048, 10013):
                logger.warning("Puerto %d ocupado (%s), probando siguiente...", port, e)
                continue
            logger.error("Error bindeando puerto %d: %s", port, e)
            continue
    if last_err is not None:
        logger.error("No se pudo bindear ningun puerto. Ultimo error: %s", last_err)
    return None, None


def start_http_server(stop_event):
    """
    Levanta el servidor HTTP en un thread no-daemon, hace serve_forever
    bloqueante, y lo cierra limpiamente cuando stop_event se setea.
    Devuelve (server, port, thread) para que main() pueda hacer shutdown.
    """
    server, port = _bind_server()
    if server is None:
        logger.error("FATAL: no hay puertos libres entre %s", HTTP_PORT_FALLBACKS)
        return None, None, None

    # Bind sanity check: confirmamos que el socket esta realmente escuchando.
    sock_name = server.socket.getsockname()
    logger.info(
        "Servidor escuchando en http://localhost:%d  (bind=%s, dir=%s)",
        port, sock_name, BASE_DIR,
    )
    logger.info("Endpoints: http://localhost:%d/mapa.html  |  http://localhost:%d/health  |  http://localhost:%d/points", port, port, port)

    def _serve():
        try:
            server.serve_forever(poll_interval=0.5)
        except Exception as e:
            logger.error("serve_forever() lanzo excepcion: %s\n%s", e, traceback.format_exc())
        finally:
            logger.info("serve_forever() salio")

    # daemon=False: el server NO debe morir con el thread principal.
    # El shutdown lo controla main() explicitamente via server.shutdown().
    t = threading.Thread(target=_serve, name="http-server", daemon=False)
    t.start()

    # Watcher: cuando stop_event se setea, hace shutdown limpio.
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
    """
    Devuelve la ruta a chrome.exe en Windows si la encuentra, sino None.
    Prueba ubicaciones tipicas en este orden: Program Files, Program Files (x86),
    LocalAppData, y como ultimo recurso busca en PATH.
    """
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
        # Linux/Mac fallback util para testing local.
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
    # Fallback: shutil.which (busca chrome.exe en PATH si el usuario lo agrego).
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
    """
    Intenta abrir Chrome explicitamente. Devuelve True si lo lanzo, False si
    Chrome no se encontro (el caller debe caer al webbrowser default).
    """
    if not FORCE_CHROME:
        return False
    chrome = _find_chrome_exe()
    if not chrome:
        logger.info("Chrome no encontrado en rutas tipicas; usare el navegador default.")
        return False
    try:
        import subprocess
        # Abre en pestana nueva de la ventana activa (sin --new-window).
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
    """
    Espera a que el servidor responda /health (max 10s) y recien ahi abre
    el navegador en /mapa.html. Asi evitamos el clasico race en Windows
    donde Chrome abre antes de que el server este listo y muestra ERR.

    Prioriza Chrome explicito (FORCE_CHROME=True); si no se encuentra usa
    el webbrowser default del sistema.
    """
    deadline = time.time() + 10
    url = f"http://localhost:{port}/mapa.html"
    health_url = f"http://localhost:{port}/health"
    while time.time() < deadline and not stop_event.is_set():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                logger.info("Healthcheck TCP ok en puerto %d", port)
                break
        except OSError:
            time.sleep(0.25)
    if not OPEN_BROWSER or stop_event.is_set():
        return
    logger.info("Abriendo navegador en %s (health: %s)", url, health_url)

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
    logger.info("Tracker Map v3 - Live Tracking Dashboard")
    logger.info("=" * 50)
    logger.info("BASE_DIR = %s", BASE_DIR)
    logger.info("Python   = %s", sys.version.split()[0])
    logger.info("PID      = %d", os.getpid())

    os.chdir(str(BASE_DIR))
    init_csv()  # Asegura que el CSV con header exista antes de cualquier read.
    clean_old_points()
    _load_analysis()  # Carga stops y rutas aprendidas

    stop_event = threading.Event()

    def signal_handler(sig, frame):
        logger.info("Senial recibida (%s), deteniendo...", sig)
        stop_event.set()

    # signal.signal solo funciona desde el main thread. Si main() corre
    # embebido en otro thread (tests), lo skipeamos sin matar el proceso.
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, signal_handler)
        except (AttributeError, ValueError):
            logger.warning("No se pudo instalar handler para %s (no main thread)", sig_name)

    # 1) Generamos mapa.html SIEMPRE al arrancar, aunque el CSV este vacio.
    #    Si no, /mapa.html devuelve 404 antes de que llegue el primer punto
    #    y el usuario cree que el servidor esta roto.
    pts = read_all_points()
    stats = compute_stats(pts)
    try:
        generate_html(pts, stats, None)
    except Exception as e:
        logger.error("Error generando mapa.html inicial: %s", e)

    # 2) Arrancamos el servidor HTTP. Si falla, abortamos: sin server no hay
    #    razon de seguir.
    server, port, http_thread = start_http_server(stop_event)
    if server is None:
        logger.error("FATAL: servidor HTTP no arranco. Saliendo.")
        return 2

    # 3) Abrimos el navegador en un thread aparte (no bloquea el main).
    threading.Thread(
        target=_open_browser_when_ready, args=(port, stop_event),
        name="open-browser", daemon=True,
    ).start()

    # 4) Tracking loop con guardia: aunque Playwright explote, el server
    #    sigue vivo y el usuario puede ver el mapa con los datos historicos.
    #    Reintentamos para siempre con backoff hasta que el usuario haga Ctrl+C.
    backoff = 5
    while not stop_event.is_set():
        try:
            tracking_loop(stop_event)
            if stop_event.is_set():
                break
            # Si tracking_loop retorno sin senial de stop, fue un fallo blando.
            logger.warning(
                "tracking_loop salio sin stop; reintentando en %ds (Ctrl+C cancela)",
                backoff,
            )
        except Exception as e:
            logger.error(
                "tracking_loop crasheo: %s\n%s", e, traceback.format_exc()
            )
            logger.warning("Reintentando tracking en %ds...", backoff)
        # Esperamos backoff o hasta stop_event. El server sigue arriba.
        stop_event.wait(backoff)
        backoff = min(backoff * 2, 60)

    # 5) Cleanup ordenado.
    logger.info("Esperando que el servidor HTTP termine...")
    if http_thread is not None:
        http_thread.join(timeout=5)
    logger.info("Tracker finalizado.")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
