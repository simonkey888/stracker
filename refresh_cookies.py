#!/usr/bin/env python3
"""Refresh cookies desde Cookie-Editor en Chrome a cookies.json.

Requisitos opcionales:
- pygetwindow
- pyautogui
- pyperclip

El script abre http://localhost:8765/cookies.html, espera unos segundos,
intenta traer la ventana del navegador al frente, pulsa en la UI de Cookie-Editor
para exportar y copia el portapapeles en cookies.json.
"""

import json
import os
import sys
import time
import webbrowser

try:
    import pygetwindow as gw
except ImportError:
    gw = None

try:
    import pyautogui
except ImportError:
    pyautogui = None

try:
    import pyperclip
except ImportError:
    pyperclip = None

URL = "http://localhost:8765/cookies.html"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "cookies.json")
WAIT_SECONDS = 5
CLICK_DELAY = 1.0
SHORT_WAIT = 0.5


def warn(msg):
    print(f"[WARN] {msg}")


def info(msg):
    print(f"[INFO] {msg}")


def find_browser_window():
    if gw is None:
        return None
    windows = gw.getAllWindows()
    for w in windows:
        title = (w.title or "").lower()
        if any(keyword in title for keyword in ("chrome", "google chrome", "edge", "firefox", "brave", "chrome")):
            return w
    return None


def focus_window(win):
    try:
        win.activate()
        time.sleep(0.5)
        return True
    except Exception as e:
        warn(f"No se pudo activar la ventana del navegador: {e}")
        return False


def click_export_button(win):
    if pyautogui is None:
        warn("pyautogui no está instalado, no puedo hacer click automáticamente.")
        return False

    if win is None:
        warn("No hay ventana del navegador disponible para clickear.")
        return False

    # Intento un click aproximado dentro de la ventana del navegador.
    # Si Cookie-Editor está abierto en una posición estándar, este click puede funcionar.
    x = win.left + int(win.width * 0.15)
    y = win.top + int(win.height * 0.15)
    info(f"Haciendo click aproximado en Export en ({x}, {y}).")
    pyautogui.moveTo(x, y, duration=0.3)
    pyautogui.click()
    time.sleep(CLICK_DELAY)

    # Intento copiar el contenido si aparece seleccionado.
    pyautogui.hotkey('ctrl', 'a')
    time.sleep(SHORT_WAIT)
    pyautogui.hotkey('ctrl', 'c')
    time.sleep(SHORT_WAIT)
    return True


def read_clipboard():
    if pyperclip is None:
        warn("pyperclip no está instalado, no puedo leer el portapapeles.")
        return None
    try:
        return pyperclip.paste()
    except Exception as e:
        warn(f"Error leyendo el portapapeles: {e}")
        return None


def save_cookies(content):
    try:
        parsed = json.loads(content)
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(parsed, f, indent=2, ensure_ascii=False)
        info(f"Cookies guardadas en {OUTPUT_FILE}")
        return True
    except Exception as e:
        warn(f"No se pudo guardar cookies.json: {e}")
        return False


def main():
    info(f"Abriendo {URL} en el navegador predeterminado...")
    webbrowser.open(URL, new=2)
    info(f"Esperando {WAIT_SECONDS} segundos para que la página y el navegador carguen...")
    time.sleep(WAIT_SECONDS)

    browser_win = find_browser_window()
    if browser_win is None:
        warn("No encontré una ventana del navegador. Asegúrate de tener Chrome abierto.")
    else:
        info(f"Ventana encontrada: {browser_win.title}")
        focus_window(browser_win)

    if click_export_button(browser_win):
        content = read_clipboard()
        if content:
            if save_cookies(content):
                info("Proceso completado correctamente.")
                return 0
            return 1

    warn("No se pudo automatizar completamente la exportación.")
    warn("Por favor abre Cookie-Editor, haz Export y copia el JSON manualmente al portapapeles.")
    clipboard = read_clipboard()
    if clipboard:
        info("Intentando guardar el contenido actual del portapapeles...")
        if save_cookies(clipboard):
            return 0
    warn("No se guardaron cookies. Instala pygetwindow, pyautogui y pyperclip para automatizar mejor.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
