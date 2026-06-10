#!/usr/bin/env python3
"""
Watchdog para reiniciar tracker_map.py si se cae.
Ejecutar: python watchdog.py
"""
import subprocess
import time
import logging
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [Watchdog] %(message)s',
    handlers=[
        logging.FileHandler('watchdog.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)

TRACKER_CMD = ["python", "tracker_map.py"]
RESTART_DELAY = 5
MAX_RESTARTS = 10
restart_count = 0

while True:
    try:
        logging.info("Iniciando tracker...")
        process = subprocess.Popen(TRACKER_CMD)
        process.wait()

        exit_code = process.returncode
        logging.warning("Tracker termino con codigo %d", exit_code)

        if exit_code == 0:
            logging.info("Salida limpia. Reiniciando...")
        else:
            restart_count += 1
            if restart_count >= MAX_RESTARTS:
                logging.error("Maximo de reinicios (%d) alcanzado. Deteniendo.", MAX_RESTARTS)
                break
            logging.warning("Reinicio %d/%d en %ds...", restart_count, MAX_RESTARTS, RESTART_DELAY)
            time.sleep(RESTART_DELAY)

    except KeyboardInterrupt:
        logging.info("Watchdog detenido por usuario")
        break
    except Exception as e:
        logging.error("Error: %s", e)
        time.sleep(RESTART_DELAY)
