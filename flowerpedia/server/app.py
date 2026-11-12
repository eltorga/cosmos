from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import unicodedata
import uuid
import webbrowser
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_UP
from functools import wraps
from pathlib import Path, PurePosixPath
from urllib.parse import quote
from urllib.request import Request, urlopen

from flask import (
    Flask, abort, flash, jsonify, redirect, render_template, request,
    send_file, send_from_directory, session, url_for
)
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.table import Table, TableColumn, TableStyleInfo
from openpyxl.utils.cell import range_boundaries
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.routing import BaseConverter
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DOCS_DIR = PROJECT_DIR / "docs"
DATA_DIR = Path(os.environ.get("FLOWERPEDIA_DATA_DIR", str(BASE_DIR / "data"))).expanduser()
BACKUP_DIR = DATA_DIR / "backups"
UPLOAD_DIR = Path(os.environ.get("FLOWERPEDIA_UPLOAD_DIR", str(DATA_DIR / "uploads"))).expanduser()
DB_PATH = Path(os.environ.get("FLOWERPEDIA_DB_PATH", str(DATA_DIR / "flowerpedia.sqlite3"))).expanduser()
WORKBOOK_PATH = Path(os.environ.get("FLOWERPEDIA_WORKBOOK_PATH", str(DATA_DIR / "current_week.xlsx"))).expanduser()
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}

for folder in (DOCS_DIR, DATA_DIR, BACKUP_DIR, UPLOAD_DIR):
    folder.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

class FiveDigitCodeConverter(BaseConverter):
    regex = r"\d{5}"

app.url_map.converters["five"] = FiveDigitCodeConverter
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
secret_path = DATA_DIR / ".secret_key"
configured_secret = os.environ.get("SECRET_KEY", "").strip()
if configured_secret:
    app.secret_key = configured_secret
elif secret_path.exists():
    app.secret_key = secret_path.read_text(encoding="utf-8").strip()
else:
    app.secret_key = secrets.token_hex(48)
    secret_path.write_text(app.secret_key, encoding="utf-8")

app.config.update(
    MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "1" if os.environ.get("RENDER") else "0").lower() in {"1", "true", "yes"},
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_REFRESH_EACH_REQUEST=True,
)

CANONICAL_COLUMNS = [
    "Finca", "ID", "Categoría", "Producto", "Composición", "Color 1",
    "Color 2", "Season", "Tamaño", "Tabla", "IMG", "Caja EC", "Op",
    "Caja Finca", "Total Tallos", "Compra", "Markup", "Venta", "Caja UK",
    "Op UK", "Compra UK", "Markup UK", "Venta UK", "Disponibilidad",
]
REQUIRED_COLUMNS = {"Finca", "Categoría", "Producto"}
STANDARD_US_BOXES = ["EB", "QB", "HB", "SB", "EB2", "QB2"]
STANDARD_UK_BOXES = [f"{x} UK" for x in STANDARD_US_BOXES]
BOX_COLUMNS = [
    "Nombre", "Largo", "Ancho", "Alto", "Peso", "Aprobado", "U2",
    "40cm", "50cm", "60cm", "70cm", "80cm", "90cm", "100cm",
]
FARM_COLUMNS = ["Llegada", "Nombre", "ID", "Agencia", "Notas"]
COMPOSITION_HEADERS = ["Clave Producto", "Categoría", "Producto", "Orden", "Variedad", "Tallos", "Precio", "Total"]
DEFAULT_SETTINGS = {
    "us_transport_volume_rate": 5.25,
    "us_transport_multiplier": 1.36,
    "us_duties_rate": 0.1586,
    "us_sale_factor": 0.96,
    "uk_transport_volume_rate": 3.2,
    "uk_transport_multiplier": 1.1,
    "uk_exchange_rate": 1.26,
    "uk_sale_factor": 0.97,
    "safety_margin_cm": 2.0,
}
SYNC_LOCK = threading.RLock()
_LAST_WORKBOOK_SIGNATURE = None
_WATCHER_STARTED = False
_WRITEBACK_PENDING = False
_CATALOG_CACHE_LOCK = threading.RLock()
_CATALOG_CACHE = {}
_PUBLIC_CODE_LOCK = threading.RLock()


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def norm(value):
    s = "" if value is None else str(value).strip()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s).casefold()


def slugify(value):
    s = unicodedata.normalize("NFKD", str(value or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s[:70] or "sin-nombre"


def make_product_key(category, product):
    raw = f"{norm(category)}::{norm(product)}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"{slugify(category)}--{slugify(product)}--{digest}"


def serialize_public_code_key(group_key):
    return json.dumps(list(group_key) if isinstance(group_key, tuple) else group_key,
                      ensure_ascii=False, separators=(",", ":"))


def public_codes_for_groups(group_keys):
    """Assign/read all five-digit product codes in one SQLite transaction."""
    serialized = list(dict.fromkeys(serialize_public_code_key(key) for key in group_keys))
    result = {}
    if not serialized:
        return result
    with _PUBLIC_CODE_LOCK:
        with db_conn() as conn:
            existing_rows = conn.execute("SELECT group_key,code FROM public_codes").fetchall()
            existing = {row["group_key"]: row["code"] for row in existing_rows}
            used_codes = set(existing.values())
            for key in serialized:
                if key in existing:
                    result[key] = existing[key]
                    continue
                seed = int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:12], 16) % 90000
                start = 10000 + seed
                assigned = None
                for offset in range(90000):
                    code = str(10000 + ((start - 10000 + offset) % 90000))
                    if code in used_codes:
                        continue
                    try:
                        conn.execute(
                            "INSERT INTO public_codes(group_key,code,created_at) VALUES(?,?,?)",
                            (key, code, now_iso())
                        )
                        assigned = code
                        used_codes.add(code)
                        existing[key] = code
                        break
                    except sqlite3.IntegrityError:
                        # A different worker may have inserted this group or claimed the code.
                        same_group = conn.execute(
                            "SELECT code FROM public_codes WHERE group_key=?", (key,)
                        ).fetchone()
                        if same_group:
                            assigned = same_group["code"]
                            existing[key] = assigned
                            used_codes.add(assigned)
                            break
                        used_codes.add(code)
                if assigned is None:
                    raise RuntimeError("No quedan códigos públicos de cinco dígitos disponibles.")
                result[key] = assigned
    return result


def public_code_for_group(group_key):
    """Return a stable, unique five-digit code for one category/product variant group."""
    key = serialize_public_code_key(group_key)
    return public_codes_for_groups([group_key])[key]


def invalidate_catalog_cache():
    with _CATALOG_CACHE_LOCK:
        _CATALOG_CACHE.clear()


def clean_value(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


def as_float(value):
    if value in (None, ""):
        return None
    if isinstance(value, str):
        value = value.strip().replace(",", ".")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def round_up_2(value):
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_UP))


def table_bounds(ws, table_name):
    wanted = norm(table_name)
    for table in ws.tables.values():
        if norm(getattr(table, "displayName", "")) == wanted or norm(getattr(table, "name", "")) == wanted:
            return range_boundaries(table.ref), table
    return None, None


def find_sheet(wb, name):
    wanted = norm(name)
    return next((ws for ws in wb.worksheets if norm(ws.title) == wanted), None)


def read_table(ws, table_name, required_headers=None):
    bounds, table = table_bounds(ws, table_name)
    if bounds:
        min_col, min_row, max_col, max_row = bounds
    else:
        required = {norm(x) for x in (required_headers or [])}
        found = None
        for r in range(1, min(ws.max_row, 25) + 1):
            values = {norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)}
            if required and required.issubset(values):
                found = (1, r, ws.max_column, ws.max_row)
                break
        if not found:
            raise ValueError(f"No se encontró la tabla o encabezado '{table_name}' en '{ws.title}'.")
        min_col, min_row, max_col, max_row = found

    headers = [str(ws.cell(min_row, c).value).strip() if ws.cell(min_row, c).value is not None else ""
               for c in range(min_col, max_col + 1)]
    records = []
    for r in range(min_row + 1, max_row + 1):
        row = {}
        for c, header in zip(range(min_col, max_col + 1), headers):
            if header:
                row[header] = clean_value(ws.cell(r, c).value)
        records.append(row)
    return headers, records, (min_col, min_row, max_col, max_row), table


def lookup_box(boxes, name):
    if not name:
        return None
    wanted = norm(name)
    for key, box in boxes.items():
        if norm(key) == wanted:
            return box
    return None


def is_standard_box(name):
    text = str(name or "").strip().upper()
    return text in STANDARD_US_BOXES or text in STANDARD_UK_BOXES


def is_standard_uk_box(name):
    return str(name or "").strip().upper() in STANDARD_UK_BOXES


def box_dimensions(box):
    return tuple(as_float(box.get(k)) for k in ("Largo", "Ancho", "Alto"))


def effective_box_u2(box, default_u2):
    if is_standard_box(box.get("Nombre")):
        return 0.0
    override = as_float(box.get("U2"))
    return float(default_u2 if override is None else override)


def calculate_box_weight(name, length, width, height, safety_margin, u2_override=None):
    if None in (length, width, height):
        return None
    if not is_standard_box(name):
        margin = as_float(u2_override)
        if margin is None:
            margin = as_float(safety_margin) or 0.0
        length += margin
        width += margin
        height += margin
    return length * width * height / 6000


def box_kind(name):
    text = str(name or "").strip().upper()
    if text in STANDARD_US_BOXES:
        return "Base USA"
    if text in STANDARD_UK_BOXES:
        return "Base UK"
    return "Caja de finca"


def base_code_from_name(name):
    text = str(name or "").upper()
    for code in ("QB2", "EB2", "QB", "EB", "HB", "SB"):
        if code in text:
            return code
    return ""


def calculate_approved(box, boxes):
    name = str(box.get("Nombre") or "")
    code = base_code_from_name(name)
    if not code:
        return "-"
    if name.strip().upper() in STANDARD_UK_BOXES:
        code = f"{code} UK"
    base = lookup_box(boxes, code)
    weight = as_float(box.get("Peso"))
    base_weight = as_float(base.get("Peso")) if base else None
    if weight is None or base_weight is None:
        return "-"
    return "y" if weight <= base_weight else "n"


def calculate_op_us(row, boxes):
    base = lookup_box(boxes, row.get("Caja EC"))
    farm = lookup_box(boxes, row.get("Caja Finca"))
    if not row.get("Caja EC") or not row.get("Caja Finca"):
        return "", None
    if not base or not farm:
        return "NO ENCONTRADO", None
    base_weight = as_float(base.get("Peso"))
    farm_weight = as_float(farm.get("Peso"))
    if base_weight is None or farm_weight is None:
        return "NO ENCONTRADO", None
    return ("y" if farm_weight <= base_weight else "n"), round(farm_weight - base_weight, 4)


def calculate_op_uk(row, boxes):
    base = lookup_box(boxes, row.get("Caja UK"))
    farm = lookup_box(boxes, row.get("Caja Finca"))
    if not row.get("Caja UK") or not row.get("Caja Finca"):
        return "", None
    if not base or not farm:
        return "NO ENCONTRADO", None
    length, width, height = box_dimensions(base)
    farm_weight = as_float(farm.get("Peso"))
    if None in (length, width, height) or farm_weight is None:
        return "NO ENCONTRADO", None
    capacity = length * width * height / 6000
    return ("y" if farm_weight <= capacity else "n"), round(farm_weight - capacity, 4)


def us_cost_components(row, boxes, settings):
    box = lookup_box(boxes, row.get("Caja EC") or row.get("Caja Finca"))
    stems = as_float(row.get("Total Tallos"))
    cost = as_float(row.get("Compra"))
    if not box or not stems or stems <= 0 or cost is None:
        return None
    length, width, height = box_dimensions(box)
    if None in (length, width, height):
        return None
    if not is_standard_box(row.get("Caja EC")):
        margin = effective_box_u2(box, settings["safety_margin_cm"])
        length += margin
        width += margin
        height += margin
    volume = length * width * height / 6000
    transport_total = round_up_2(volume * float(settings["us_transport_volume_rate"]) * float(settings["us_transport_multiplier"]))
    transport = round_up_2(transport_total / stems)
    duties = round_up_2(cost * float(settings["us_duties_rate"]))
    return {"volume": volume, "transport_total": transport_total, "transport": transport,
            "duties": duties, "total_cost": cost + duties + transport}


def uk_cost_components(row, boxes, settings):
    box = lookup_box(boxes, row.get("Caja UK"))
    stems = as_float(row.get("Total Tallos"))
    purchase = as_float(row.get("Compra UK"))
    if purchase is None:
        purchase = as_float(row.get("Compra"))
    if not box or not stems or stems <= 0 or purchase is None:
        return None
    length, width, height = box_dimensions(box)
    if None in (length, width, height):
        return None
    if not is_standard_box(row.get("Caja UK")):
        margin = effective_box_u2(box, settings["safety_margin_cm"])
        length += margin
        width += margin
        height += margin
    volume = length * width * height / 6000
    transport_total = round_up_2(volume * float(settings["uk_transport_volume_rate"]) * float(settings["uk_transport_multiplier"]))
    transport = round_up_2(transport_total / stems)
    cost_gbp = purchase / float(settings["uk_exchange_rate"])
    total_cost = round_up_2(cost_gbp + transport)
    return {"volume": volume, "transport_total": transport_total, "transport": transport,
            "cost_gbp": cost_gbp, "total_cost": total_cost, "purchase_source": purchase}


def markup_result(total_cost, sale_price, sale_factor):
    price = as_float(sale_price)
    if price is None or price <= 0 or total_cost is None:
        return None
    result = 1 - total_cost / (price * float(sale_factor))
    if result < 0:
        return "BAJO"
    if result > 1:
        return "ALTO"
    return result


def calculate_us_markup(row, boxes, settings):
    comp = us_cost_components(row, boxes, settings)
    return markup_result(comp["total_cost"], row.get("Venta"), settings["us_sale_factor"]) if comp else None


def calculate_uk_markup(row, boxes, settings):
    comp = uk_cost_components(row, boxes, settings)
    return markup_result(comp["total_cost"], row.get("Venta UK"), settings["uk_sale_factor"]) if comp else None


def us_price_from_markup(row, target, boxes, settings):
    comp = us_cost_components(row, boxes, settings)
    if not comp or target < 0 or target >= 1:
        return None
    return round_up_2(comp["total_cost"] / (float(settings["us_sale_factor"]) * (1 - target)))


def uk_price_from_markup(row, target, boxes, settings):
    comp = uk_cost_components(row, boxes, settings)
    if not comp or target < 0 or target >= 1:
        return None
    return round_up_2(comp["total_cost"] / (float(settings["uk_sale_factor"]) * (1 - target)))


def recalculate_box_records(boxes, safety_margin):
    box_map = {str(b["Nombre"]): b for b in boxes if b.get("Nombre")}
    for box in box_map.values():
        length, width, height = box_dimensions(box)
        applied_u2 = effective_box_u2(box, safety_margin)
        box["U2_aplicado"] = applied_u2
        box["Peso"] = calculate_box_weight(
            box["Nombre"], length, width, height, safety_margin, applied_u2
        )
        # Retire legacy inch-conversion fields from the live model.
        for legacy in ("Largo2", "Ancho2", "Alto2", "Peso Pulgadas"):
            box.pop(legacy, None)
    for box in box_map.values():
        box["Aprobado"] = calculate_approved(box, box_map)
    return box_map


def recalculate_row(row, boxes, farms, settings):
    out = dict(row)
    farm_map = {norm(f.get("Nombre")): f for f in farms if f.get("Nombre")}
    farm = farm_map.get(norm(out.get("Finca")))
    if farm:
        out["ID"] = farm.get("ID")
    out["Op"], out["_Op_diferencia"] = calculate_op_us(out, boxes)
    out["Op UK"], out["_Op_UK_diferencia"] = calculate_op_uk(out, boxes)
    out["Markup"] = calculate_us_markup(out, boxes, settings)
    out["Markup UK"] = calculate_uk_markup(out, boxes, settings)
    return out


def read_compositions_from_workbook(wb):
    ws = find_sheet(wb, "Composiciones")
    result = {}
    if ws is not None:
        try:
            _, records, _, _ = read_table(ws, "Composiciones", required_headers=set(COMPOSITION_HEADERS))
            for row in records:
                key = str(row.get("Clave Producto") or "")
                if not key:
                    continue
                result.setdefault(key, []).append({
                    "variety": str(row.get("Variedad") or ""),
                    "stems": as_float(row.get("Tallos")) or 0,
                    "price": as_float(row.get("Precio")) or 0,
                })
        except Exception:
            pass
    return result


def load_workbook_data(path):
    if not path.exists():
        raise FileNotFoundError(f"No existe el archivo Excel: {path}")
    wb = load_workbook(path, data_only=True, read_only=False)
    catalog_ws = find_sheet(wb, "Catalogo")
    if catalog_ws is None:
        raise ValueError("El Excel no contiene una pestaña 'Catalogo'.")
    headers, raw_products, _, _ = read_table(catalog_ws, "Catalogo", required_headers=REQUIRED_COLUMNS)
    normalized = {norm(h) for h in headers if h}
    missing = [x for x in REQUIRED_COLUMNS if norm(x) not in normalized]
    if missing:
        raise ValueError("Faltan columnas obligatorias en Catalogo: " + ", ".join(missing))
    products = []
    for raw in raw_products:
        lookup = {norm(k): v for k, v in raw.items() if k}
        row = {col: clean_value(lookup.get(norm(col))) for col in CANONICAL_COLUMNS}
        row["Disponibilidad"] = "Erradicado" if norm(row.get("Disponibilidad")) in {"erradicado", "eradicated"} else "Disponible"
        if not any(row.get(k) not in (None, "") for k in ("Finca", "Categoría", "Producto")):
            continue
        if not row.get("Producto") and not row.get("Categoría"):
            continue
        products.append(row)

    box_ws = find_sheet(wb, "Sheet1")
    if box_ws is None:
        raise ValueError("No existe la hoja 'Sheet1' con la tabla Cajas.")
    _, raw_boxes, _, _ = read_table(box_ws, "Cajas", required_headers={"Nombre", "Largo", "Ancho", "Alto"})
    boxes = []
    for raw in raw_boxes:
        lookup = {norm(k): v for k, v in raw.items() if k}
        name = lookup.get(norm("Nombre"))
        if not name:
            continue
        box = {col: clean_value(lookup.get(norm(col))) for col in BOX_COLUMNS}
        box["Nombre"] = str(name).strip()
        boxes.append(box)

    safety_margin = as_float(box_ws["U2"].value) if box_ws["U2"].value not in (None, "") else 2.0
    safety_margin = safety_margin if safety_margin is not None else 2.0
    box_map = recalculate_box_records(boxes, safety_margin)

    farms = []
    farm_ws = find_sheet(wb, "Fincas")
    if farm_ws is not None:
        _, raw_farms, _, _ = read_table(farm_ws, "Fincas", required_headers={"Nombre"})
        for raw in raw_farms:
            lookup = {norm(k): v for k, v in raw.items() if k}
            name = lookup.get(norm("Nombre"))
            if not name:
                continue
            farms.append({col: clean_value(lookup.get(norm(col))) for col in FARM_COLUMNS})

    options = {"Categoría": [], "Season": [], "Color": [], "Tamaño": []}
    guides_ws = find_sheet(wb, "Guias")
    if guides_ws is not None:
        for table_name, key in (("Category", "Categoría"), ("Season", "Season"), ("Colors", "Color"), ("Size", "Tamaño")):
            try:
                _, records, _, _ = read_table(guides_ws, table_name)
                vals = []
                for rec in records:
                    for value in rec.values():
                        if value not in (None, ""):
                            vals.append(str(value).strip())
                            break
                options[key] = list(dict.fromkeys(vals))
            except Exception:
                pass

    compositions = read_compositions_from_workbook(wb)
    # Legacy Tabla values can contain JSON; import them once if no Composiciones sheet exists.
    if not compositions:
        for row in products:
            raw_table = row.get("Tabla")
            if not raw_table or not isinstance(raw_table, str) or not raw_table.lstrip().startswith("["):
                continue
            try:
                compositions[make_product_key(row.get("Categoría"), row.get("Producto"))] = json.loads(raw_table)
            except Exception:
                pass

    return {
        "products": products, "boxes": list(box_map.values()), "farms": farms,
        "options": options, "compositions": compositions,
        "safety_margin_cm": safety_margin, "source_filename": path.name,
    }


@contextmanager
def db_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db_conn() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','staff')),
            is_active INTEGER NOT NULL DEFAULT 1,
            avatar_path TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY, row_json TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS boxes (name TEXT PRIMARY KEY, box_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS farms (name TEXT PRIMARY KEY, farm_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS options (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,value));
        CREATE TABLE IF NOT EXISTS product_media (product_key TEXT PRIMARY KEY, images_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS compositions (product_key TEXT PRIMARY KEY, rows_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS public_codes (
            group_key TEXT PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_public_codes_code ON public_codes(code);
        CREATE TABLE IF NOT EXISTS login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            succeeded INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_address, attempted_at);
        """)
        conn.execute("DROP TABLE IF EXISTS favorites")
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "avatar_path" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN avatar_path TEXT")
        product_cols = {r["name"] for r in conn.execute("PRAGMA table_info(products)").fetchall()}
        if "position" not in product_cols:
            conn.execute("ALTER TABLE products ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (key, json.dumps(value)))
        # Migración v0.3.2: se elimina la antigua contraseña global del catálogo.
        conn.execute("DELETE FROM settings WHERE key='site_password_hash'")


def get_setting(key, default=None):
    with db_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except Exception:
        return row["value"]


def set_setting(key, value):
    with db_conn() as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (key, json.dumps(value)))


def get_settings():
    out = dict(DEFAULT_SETTINGS)
    with db_conn() as conn:
        rows = conn.execute("SELECT key,value FROM settings").fetchall()
    for row in rows:
        if row["key"] in out:
            try:
                out[row["key"]] = json.loads(row["value"])
            except Exception:
                pass
    return out


def get_rows():
    with db_conn() as conn:
        records = conn.execute("SELECT id,row_json FROM products ORDER BY position,created_at,id").fetchall()
    return [(r["id"], json.loads(r["row_json"])) for r in records]


def get_boxes():
    with db_conn() as conn:
        records = conn.execute("SELECT name,box_json FROM boxes ORDER BY name").fetchall()
    return {r["name"]: json.loads(r["box_json"]) for r in records}


def get_farms():
    with db_conn() as conn:
        records = conn.execute("SELECT name,farm_json FROM farms ORDER BY name").fetchall()
    return [json.loads(r["farm_json"]) for r in records]


def get_options():
    out = {}
    with db_conn() as conn:
        records = conn.execute("SELECT kind,value FROM options ORDER BY value").fetchall()
    for r in records:
        out.setdefault(r["kind"], []).append(r["value"])
    return out


def get_compositions():
    with db_conn() as conn:
        records = conn.execute("SELECT product_key,rows_json FROM compositions").fetchall()
    return {r["product_key"]: json.loads(r["rows_json"]) for r in records}


def get_media():
    with db_conn() as conn:
        records = conn.execute("SELECT product_key,images_json FROM product_media").fetchall()
    return {r["product_key"]: json.loads(r["images_json"]) for r in records}


def workbook_signature():
    if not WORKBOOK_PATH.exists():
        return None
    stat = WORKBOOK_PATH.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def save_workbook_signature():
    sig = workbook_signature()
    if sig:
        set_setting("workbook_signature", sig)
    global _LAST_WORKBOOK_SIGNATURE
    _LAST_WORKBOOK_SIGNATURE = sig


def import_data_into_db(data):
    settings = get_settings()
    settings["safety_margin_cm"] = data["safety_margin_cm"]
    boxes = {str(b["Nombre"]): b for b in data["boxes"] if b.get("Nombre")}
    with db_conn() as conn:
        conn.execute("DELETE FROM products")
        conn.execute("DELETE FROM boxes")
        conn.execute("DELETE FROM farms")
        conn.execute("DELETE FROM options")
        for box in data["boxes"]:
            if box.get("Nombre"):
                conn.execute("INSERT OR REPLACE INTO boxes(name,box_json) VALUES(?,?)",
                             (box["Nombre"], json.dumps(box, ensure_ascii=False)))
        for farm in data["farms"]:
            if farm.get("Nombre"):
                conn.execute("INSERT OR REPLACE INTO farms(name,farm_json) VALUES(?,?)",
                             (farm["Nombre"], json.dumps(farm, ensure_ascii=False)))
        for kind, values in data["options"].items():
            for value in values:
                conn.execute("INSERT OR IGNORE INTO options(kind,value) VALUES(?,?)", (kind, str(value)))
        for key, value in settings.items():
            conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value)))
        conn.execute("INSERT INTO settings(key,value) VALUES('source_filename',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (json.dumps(data.get("source_filename", "current_week.xlsx")),))
        for position, row in enumerate(data["products"]):
            row = recalculate_row(row, boxes, data["farms"], settings)
            conn.execute("INSERT INTO products(id,row_json,position,created_at,updated_at) VALUES(?,?,?,?,?)",
                         (uuid.uuid4().hex, json.dumps(row, ensure_ascii=False), position, now_iso(), now_iso()))
        conn.execute("DELETE FROM compositions")
        for key, rows in data.get("compositions", {}).items():
            normalized_rows = normalize_composition_rows(rows)
            conn.execute("INSERT OR REPLACE INTO compositions(product_key,rows_json) VALUES(?,?)",
                         (key, json.dumps(normalized_rows, ensure_ascii=False)))
    save_workbook_signature()
    invalidate_catalog_cache()


def normalize_composition_rows(rows):
    out = []
    for item in rows or []:
        variety = str(item.get("variety", item.get("Variedad", "")) or "").strip()
        if not variety:
            continue
        stems = as_float(item.get("stems", item.get("Tallos"))) or 0
        price = as_float(item.get("price", item.get("Precio"))) or 0
        out.append({"variety": variety, "stems": stems, "price": price, "total": round_up_2(stems * price)})
    return out


def recalculate_all():
    boxes = get_boxes()
    farms = get_farms()
    settings = get_settings()
    with db_conn() as conn:
        records = conn.execute("SELECT id,row_json FROM products").fetchall()
        for record in records:
            row = recalculate_row(json.loads(record["row_json"]), boxes, farms, settings)
            conn.execute("UPDATE products SET row_json=?,updated_at=? WHERE id=?",
                         (json.dumps(row, ensure_ascii=False), now_iso(), record["id"]))


def product_images(product_key, local=True):
    paths = get_media().get(product_key, [])
    out = []
    for item in paths:
        rel = item.get("path") if isinstance(item, dict) else str(item)
        if not rel:
            continue
        encoded = quote(rel.replace("\\", "/"), safe="/")
        out.append({
            "path": rel,
            "src": f"/media/{encoded}" if local else f"assets/images/{encoded}",
        })
    return out


def group_catalog(rows=None, local_images=True):
    rows = rows if rows is not None else [row for _, row in get_rows()]
    boxes = get_boxes()
    farms = get_farms()
    farm_status = {norm(f.get("Nombre")): (f.get("Llegada") or "-") for f in farms}
    compositions = get_compositions()
    media = get_media()
    settings = get_settings()
    groups = {}
    for raw in rows:
        row = recalculate_row(raw, boxes, farms, settings)
        cat, name = row.get("Categoría"), row.get("Producto")
        pkey = make_product_key(cat, name)
        group_key = tuple(norm(row.get(k)) for k in ("Categoría", "Producto", "Composición", "Color 1", "Color 2", "Season"))
        if group_key not in groups:
            image_items = []
            for item in media.get(pkey, []):
                rel = item.get("path") if isinstance(item, dict) else str(item)
                if rel:
                    encoded = quote(rel.replace("\\", "/"), safe="/")
                    image_items.append({"path": rel, "src": f"/media/{encoded}" if local_images else f"assets/images/{encoded}"})
            groups[group_key] = {
                "id": hashlib.sha1("::".join(group_key).encode("utf-8")).hexdigest()[:16],
                "productKey": pkey,
                "Categoría": cat, "Producto": name, "Composición": row.get("Composición"),
                "Color 1": row.get("Color 1"), "Color 2": row.get("Color 2"),
                "Season": row.get("Season"), "Disponibilidad": "Disponible", "Fincas": [], "Tamaños": [],
                "farmStatus": {}, "images": image_items,
                "Tabla": compositions.get(pkey, []), "variants": [],
            }
        group = groups[group_key]
        if norm(row.get("Disponibilidad")) in {"erradicado", "eradicated"}:
            group["Disponibilidad"] = "Erradicado"
        farm = row.get("Finca")
        if farm and farm not in group["Fincas"]:
            group["Fincas"].append(farm)
            group["farmStatus"][farm] = farm_status.get(norm(farm), "-")
        size = row.get("Tamaño")
        if size and size not in group["Tamaños"]:
            group["Tamaños"].append(size)
        row["_FarmArrival"] = farm_status.get(norm(row.get("Finca")), "-")
        row["_boxECInfo"] = dict(lookup_box(boxes, row.get("Caja EC")) or {})
        row["_boxFincaInfo"] = dict(lookup_box(boxes, row.get("Caja Finca")) or {})
        row["_boxUKInfo"] = dict(lookup_box(boxes, row.get("Caja UK")) or {})
        group["variants"].append(row)
    identity_counts = {}
    code_keys = {}
    for group_key in groups:
        stable_identity = (group_key[0], group_key[1], group_key[3], group_key[4], group_key[5])
        identity_counts[stable_identity] = identity_counts.get(stable_identity, 0) + 1
    for group_key in groups:
        stable_identity = (group_key[0], group_key[1], group_key[3], group_key[4], group_key[5])
        # Description edits do not change a product URL unless identical visible variants coexist.
        code_keys[group_key] = ("product",) + stable_identity if identity_counts[stable_identity] == 1 else ("variant",) + group_key
    code_map = public_codes_for_groups(code_keys.values())
    for group_key, group in groups.items():
        group["Tamaños"].sort(key=size_sort_key)
        group["Fincas"].sort(key=lambda x: norm(x))
        group["variants"].sort(key=variant_sort_key)
        group["publicCode"] = code_map[serialize_public_code_key(code_keys[group_key])]
    result = list(groups.values())
    result.sort(key=lambda g: (norm(g.get("Categoría")), norm(g.get("Producto")), g.get("publicCode", "")))
    return result


def get_catalog_groups(local_images=True):
    """Build the joined catalogue once and reuse it until source data changes."""
    cache_key = bool(local_images)
    with _CATALOG_CACHE_LOCK:
        cached = _CATALOG_CACHE.get(cache_key)
        if cached is not None:
            return cached
        groups = group_catalog(local_images=local_images)
        _CATALOG_CACHE[cache_key] = groups
        return groups


def size_sort_key(value):
    match = re.search(r"\d+(?:[.,]\d+)?", str(value or ""))
    return (float(match.group(0).replace(",", ".")) if match else 9999, norm(value))


def box_sort_key(value):
    base = str(value or "").upper().replace(" UK", "").strip()
    order = {"SB": 0, "EB": 1, "QB": 2, "HB": 3, "EB2": 4, "QB2": 5}
    return (order.get(base, 99), norm(value))


def variant_sort_key(row):
    return (
        norm(row.get("Finca")),
        size_sort_key(row.get("Tamaño")),
        box_sort_key(row.get("Caja EC") or row.get("Caja UK")),
        as_float(row.get("Total Tallos")) if as_float(row.get("Total Tallos")) is not None else 999999,
    )


def public_group(group, include_admin_composition=False):
    # Public pages never receive USA/UK commercial rows or composition prices/totals.
    item = {k: v for k, v in group.items() if k != "variants"}
    if not include_admin_composition and isinstance(item.get("Tabla"), list):
        item["Tabla"] = [
            {"variety": line.get("variety", ""), "stems": line.get("stems", 0)}
            for line in item["Tabla"]
        ]
    return item


def publish_public_site():
    """The live catalog is served from Flask APIs; no public static data copy is generated."""
    return {
        "ok": True,
        "message": "Catálogo actualizado en el servidor. Usuarios, imágenes y datos comerciales permanecen en almacenamiento privado.",
    }


def ensure_table(ws, name, ref, style="TableStyleMedium2"):
    existing = None
    for key, table in list(ws.tables.items()):
        if norm(getattr(table, "displayName", "")) == norm(name):
            existing = table
            break
    if existing:
        existing.ref = ref
        if getattr(existing, "autoFilter", None):
            existing.autoFilter.ref = ref
        return existing
    table = Table(displayName=name, ref=ref)
    table.tableStyleInfo = TableStyleInfo(name=style, showFirstColumn=False, showLastColumn=False,
                                          showRowStripes=True, showColumnStripes=False)
    ws.add_table(table)
    return table


def write_table_rows(ws, table_name, rows, headers_override=None):
    bounds, table = table_bounds(ws, table_name)
    if not bounds:
        raise ValueError(f"No se encontró la tabla '{table_name}' en la hoja '{ws.title}'.")
    min_col, header_row, max_col, old_last = bounds
    headers = headers_override or [ws.cell(header_row, c).value for c in range(min_col, max_col + 1)]
    for r in range(header_row + 1, old_last + 1):
        for c in range(min_col, max_col + 1):
            ws.cell(r, c).value = None
    from copy import copy
    for i, row in enumerate(rows):
        rr = header_row + 1 + i
        if rr > old_last and old_last > header_row:
            for cc in range(min_col, max_col + 1):
                src, dst = ws.cell(old_last, cc), ws.cell(rr, cc)
                if src.has_style:
                    dst._style = copy(src._style)
                    dst.number_format = src.number_format
        lookup = {norm(k): v for k, v in row.items() if k}
        for cc, header in zip(range(min_col, max_col + 1), headers):
            if header:
                ws.cell(rr, cc).value = lookup.get(norm(str(header)))
    new_last = header_row + max(len(rows), 1)
    ref = f"{ws.cell(header_row,min_col).coordinate}:{ws.cell(new_last,max_col).coordinate}"
    table.ref = ref
    if getattr(table, "autoFilter", None):
        table.autoFilter.ref = ref


def restore_worksheet_extensions(source_path, target_path):
    """Restore Excel extension XML (notably newer x14 dropdown validations) that openpyxl cannot preserve."""
    patched_path = Path(target_path).with_name(f"{Path(target_path).stem}_extensions.xlsx")
    try:
        with zipfile.ZipFile(source_path, "r") as source_zip, zipfile.ZipFile(target_path, "r") as target_zip:
            source_names = set(source_zip.namelist())
            with zipfile.ZipFile(patched_path, "w", compression=zipfile.ZIP_DEFLATED) as output_zip:
                for item in target_zip.infolist():
                    content = target_zip.read(item.filename)
                    if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", item.filename) and item.filename in source_names:
                        original_xml = source_zip.read(item.filename)
                        extensions = re.findall(rb"<extLst\b.*?</extLst>", original_xml, flags=re.DOTALL)
                        if extensions and not re.search(rb"<extLst\b", content):
                            # The extension blocks can use prefixes (for example xr:) declared only
                            # on the original worksheet root. Restore those namespace declarations too.
                            original_root = re.search(rb"<worksheet\b[^>]*>", original_xml)
                            target_root = re.search(rb"<worksheet\b[^>]*>", content)
                            if original_root and target_root:
                                original_attrs = original_root.group(0)
                                target_attrs = target_root.group(0)
                                additions = []
                                for declaration in re.findall(rb'xmlns:[A-Za-z0-9_]+="[^"]+"', original_attrs):
                                    prefix = declaration.split(b"=", 1)[0]
                                    if not re.search(rb"\b" + re.escape(prefix) + rb"=", target_attrs):
                                        additions.append(declaration)
                                ignorable = re.search(rb'mc:Ignorable="[^"]+"', original_attrs)
                                if ignorable and b"mc:Ignorable=" not in target_attrs:
                                    additions.append(ignorable.group(0))
                                if additions:
                                    replacement = target_attrs[:-1] + b" " + b" ".join(additions) + b">"
                                    content = content.replace(target_attrs, replacement, 1)
                            closing = b"</worksheet>"
                            if closing in content:
                                content = content.replace(closing, b"".join(extensions) + closing, 1)
                    output_zip.writestr(item, content)
        os.replace(patched_path, target_path)
    finally:
        try:
            patched_path.unlink(missing_ok=True)
        except OSError:
            pass


def sync_db_to_excel():
    global _LAST_WORKBOOK_SIGNATURE
    if not WORKBOOK_PATH.exists():
        raise FileNotFoundError("No existe data/current_week.xlsx.")
    with SYNC_LOCK:
        wb = load_workbook(WORKBOOK_PATH, data_only=False)
        settings = get_settings()
        boxes = get_boxes()
        farms = get_farms()
        rows = [recalculate_row(row, boxes, farms, settings) for _, row in get_rows()]
        compositions = get_compositions()

        catalog_ws = find_sheet(wb, "Catalogo")
        if catalog_ws is None:
            raise ValueError("No se encontró la hoja Catalogo.")
        bounds, table = table_bounds(catalog_ws, "Catalogo")
        if not bounds:
            raise ValueError("No se encontró la tabla Catalogo.")
        min_col, header_row, max_col, old_last = bounds
        catalog_headers = [norm(catalog_ws.cell(header_row, c).value) for c in range(min_col, max_col + 1)]
        if norm("Disponibilidad") not in catalog_headers:
            from copy import copy
            new_col = max_col + 1
            source_header = catalog_ws.cell(header_row, max_col)
            target_header = catalog_ws.cell(header_row, new_col)
            if source_header.has_style:
                target_header._style = copy(source_header._style)
            target_header.value = "Disponibilidad"
            for rr in range(header_row + 1, old_last + 1):
                source_cell = catalog_ws.cell(rr, max_col)
                target_cell = catalog_ws.cell(rr, new_col)
                if source_cell.has_style:
                    target_cell._style = copy(source_cell._style)
                if target_cell.value in (None, ""):
                    target_cell.value = "Disponible"
            existing_columns = list(table.tableColumns or [])
            existing_ids = [int(col.id) for col in existing_columns if getattr(col, "id", None) is not None]
            table.tableColumns = existing_columns + [TableColumn(id=max(existing_ids, default=0) + 1, name="Disponibilidad")]
            table.ref = f"{catalog_ws.cell(header_row,min_col).coordinate}:{catalog_ws.cell(old_last,new_col).coordinate}"
            if getattr(table, "autoFilter", None):
                table.autoFilter.ref = table.ref
            max_col = new_col
        headers = [catalog_ws.cell(header_row, c).value for c in range(min_col, max_col + 1)]
        export_rows = []
        for row in rows:
            clean = {k: v for k, v in row.items() if not k.startswith("_")}
            key = make_product_key(clean.get("Categoría"), clean.get("Producto"))
            clean["Tabla"] = key if compositions.get(key) else None
            clean["IMG"] = None
            export_rows.append(clean)
        write_table_rows(catalog_ws, "Catalogo", export_rows, headers)

        box_ws = find_sheet(wb, "Sheet1")
        if box_ws is not None and table_bounds(box_ws, "Cajas")[0]:
            bounds, box_table = table_bounds(box_ws, "Cajas")
            min_col, header_row, max_col, old_last = bounds
            box_headers = [norm(box_ws.cell(header_row, c).value) for c in range(min_col, max_col + 1)]
            if norm("U2") not in box_headers:
                from copy import copy
                new_col = max_col + 1
                source_header = box_ws.cell(header_row, max_col)
                target_header = box_ws.cell(header_row, new_col)
                if source_header.has_style:
                    target_header._style = copy(source_header._style)
                target_header.value = "U2"
                for rr in range(header_row + 1, old_last + 1):
                    source_cell = box_ws.cell(rr, max_col)
                    target_cell = box_ws.cell(rr, new_col)
                    if source_cell.has_style:
                        target_cell._style = copy(source_cell._style)
                existing_ids = [int(col.id) for col in (box_table.tableColumns or []) if getattr(col, "id", None) is not None]
                box_table.tableColumns.append(TableColumn(id=max(existing_ids, default=0) + 1, name="U2"))
                box_table.ref = f"{box_ws.cell(header_row,min_col).coordinate}:{box_ws.cell(old_last,new_col).coordinate}"
                if getattr(box_table, "autoFilter", None):
                    box_table.autoFilter.ref = box_table.ref
            export_boxes = []
            for box in boxes.values():
                clean = dict(box)
                length, width, height = box_dimensions(clean)
                clean["U2"] = clean.get("U2") if not is_standard_box(clean.get("Nombre")) else 0
                clean["U2_aplicado"] = effective_box_u2(clean, settings["safety_margin_cm"])
                clean["Peso"] = calculate_box_weight(
                    clean["Nombre"], length, width, height, settings["safety_margin_cm"], clean["U2_aplicado"]
                )
                clean["Aprobado"] = calculate_approved(clean, boxes)
                for legacy in ("Largo2", "Ancho2", "Alto2", "Peso Pulgadas"):
                    clean.pop(legacy, None)
                export_boxes.append(clean)
            write_table_rows(box_ws, "Cajas", export_boxes)
            box_ws["U2"] = settings["safety_margin_cm"]

        comp_ws = find_sheet(wb, "Composiciones")
        if comp_ws is None:
            comp_ws = wb.create_sheet("Composiciones")
        comp_rows = []
        for key, lines in compositions.items():
            group = next((r for r in rows if make_product_key(r.get("Categoría"), r.get("Producto")) == key), {})
            sum_stems = sum(float(line.get("stems") or 0) for line in lines)
            sum_total = sum(float(line.get("stems") or 0) * float(line.get("price") or 0) for line in lines)
            for index, line in enumerate(lines, 1):
                comp_rows.append({
                    "Clave Producto": key, "Categoría": group.get("Categoría"),
                    "Producto": group.get("Producto"), "Orden": index,
                    "Variedad": line.get("variety"), "Tallos": line.get("stems"),
                    "Precio": line.get("price"), "Total": round_up_2((line.get("stems") or 0) * (line.get("price") or 0)),
                })
            # Summary row is part of the Excel table but has no product key,
            # so the importer won't treat it as another composition line.
            comp_rows.append({
                "Clave Producto": None, "Categoría": group.get("Categoría"),
                "Producto": group.get("Producto"), "Orden": None,
                "Variedad": "TOTAL", "Tallos": sum_stems,
                "Precio": round_up_2(sum_total / sum_stems) if sum_stems else 0,
                "Total": round_up_2(sum_total),
            })
        # Rebuild this dedicated table as a real Excel table, rather than Markdown or JSON text.
        for tname in list(comp_ws.tables.keys()):
            del comp_ws.tables[tname]
        comp_ws.delete_rows(1, comp_ws.max_row)
        for c, header in enumerate(COMPOSITION_HEADERS, 1):
            comp_ws.cell(1, c).value = header
            comp_ws.cell(1, c).font = Font(bold=True, color="FFFFFF")
            comp_ws.cell(1, c).fill = PatternFill("solid", fgColor="335C45")
            comp_ws.cell(1, c).alignment = Alignment(horizontal="center")
        for r, item in enumerate(comp_rows, 2):
            for c, header in enumerate(COMPOSITION_HEADERS, 1):
                comp_ws.cell(r, c).value = item.get(header)
        last = max(2, len(comp_rows) + 1)
        ensure_table(comp_ws, "Composiciones", f"A1:H{last}", "TableStyleMedium4")
        for col, width in {"A":34,"B":20,"C":24,"D":10,"E":34,"F":12,"G":12,"H":12}.items():
            comp_ws.column_dimensions[col].width = width

        try:
            wb.calculation.fullCalcOnLoad = True
            wb.calculation.forceFullCalc = True
            wb.calculation.calcMode = "auto"
        except Exception:
            pass

        temp = DATA_DIR / f"current_week_{uuid.uuid4().hex}.tmp.xlsx"
        wb.save(temp)
        # openpyxl warns that it cannot round-trip Excel's newer x14 data-validation extensions.
        # Restore those XML blocks from the original workbook so dropdowns on other sheets survive.
        restore_worksheet_extensions(WORKBOOK_PATH, temp)
        try:
            os.replace(temp, WORKBOOK_PATH)
        except PermissionError as exc:
            global _WRITEBACK_PENDING
            _WRITEBACK_PENDING = True
            temp.unlink(missing_ok=True)
            publish_public_site()
            raise RuntimeError("El cambio ya está guardado en Flowerpedia. Cierra current_week.xlsx en Excel; la sincronización al archivo se reintentará automáticamente.") from exc
        _LAST_WORKBOOK_SIGNATURE = workbook_signature()
        set_setting("workbook_signature", _LAST_WORKBOOK_SIGNATURE)
        publish_public_site()
        invalidate_catalog_cache()


def sync_excel_if_changed(force=False):
    global _LAST_WORKBOOK_SIGNATURE, _WRITEBACK_PENDING
    if not WORKBOOK_PATH.exists():
        return False
    current = workbook_signature()
    if not force and current == _LAST_WORKBOOK_SIGNATURE:
        return False
    with SYNC_LOCK:
        current = workbook_signature()
        if not force and current == _LAST_WORKBOOK_SIGNATURE:
            return False
        try:
            data = load_workbook_data(WORKBOOK_PATH)
            import_data_into_db(data)
            _LAST_WORKBOOK_SIGNATURE = workbook_signature()
            publish_public_site()
            # Recalculate formula-driven columns in the workbook itself after an external edit.
            _WRITEBACK_PENDING = True
            try:
                sync_db_to_excel()
                _WRITEBACK_PENDING = False
            except Exception as exc:
                print(f"[Flowerpedia] Datos importados; falta escribir los cálculos al Excel: {exc}")
            return True
        except Exception as exc:
            # Excel may be in the middle of saving; the watcher retries next pass.
            print(f"[Flowerpedia] Excel todavía no se pudo sincronizar: {exc}")
            return False


def workbook_watcher():
    global _WRITEBACK_PENDING
    while True:
        time.sleep(2.5)
        try:
            if _WRITEBACK_PENDING:
                try:
                    sync_db_to_excel()
                    _WRITEBACK_PENDING = False
                except Exception as exc:
                    print(f"[Flowerpedia] Esperando a que Excel se cierre para actualizar cálculos: {exc}")
            else:
                sync_excel_if_changed()
        except Exception as exc:
            print(f"[Flowerpedia] Error de sincronización: {exc}")


def migrate_product_availability():
    """Backfill legacy product rows and add the Disponibilidad column to older Excel files."""
    with db_conn() as conn:
        records = conn.execute("SELECT id,row_json FROM products").fetchall()
        for record in records:
            row = json.loads(record["row_json"])
            status = "Erradicado" if norm(row.get("Disponibilidad")) in {"erradicado", "eradicated"} else "Disponible"
            if row.get("Disponibilidad") != status:
                row["Disponibilidad"] = status
                conn.execute("UPDATE products SET row_json=?,updated_at=? WHERE id=?",
                             (json.dumps(row, ensure_ascii=False), now_iso(), record["id"]))
    if not WORKBOOK_PATH.exists():
        return
    wb = load_workbook(WORKBOOK_PATH, data_only=False)
    try:
        catalog_ws = find_sheet(wb, "Catalogo")
        bounds, _ = table_bounds(catalog_ws, "Catalogo") if catalog_ws is not None else (None, None)
        has_column = False
        if bounds:
            min_col, header_row, max_col, _ = bounds
            has_column = any(norm(catalog_ws.cell(header_row, c).value) == norm("Disponibilidad")
                             for c in range(min_col, max_col + 1))
    finally:
        wb.close()
    if not has_column:
        sync_db_to_excel()


def ensure_initial_admin():
    """Create the first administrator from deployment environment variables, once only."""
    if has_users():
        return False
    username = (os.environ.get("INITIAL_ADMIN_USERNAME") or "").strip().lower()
    password = os.environ.get("INITIAL_ADMIN_PASSWORD") or ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,29}", username) or len(password) < 4:
        return False
    with db_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?)",
            (username, generate_password_hash(password), "admin", 1, now_iso())
        )
    return has_users()


def initialize_app(start_watcher=None):
    global _LAST_WORKBOOK_SIGNATURE, _WATCHER_STARTED
    init_db()
    ensure_initial_admin()
    if os.environ.get("FLOWERPEDIA_REQUIRE_INITIAL_ADMIN") == "1" and not has_users():
        raise RuntimeError("No se creó el administrador inicial. Configura INITIAL_ADMIN_USERNAME y una INITIAL_ADMIN_PASSWORD de al menos 4 caracteres en Render.")
    if WORKBOOK_PATH.exists():
        with db_conn() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
            stored_sig = conn.execute("SELECT value FROM settings WHERE key='workbook_signature'").fetchone()
        current = workbook_signature()
        stored = None
        if stored_sig:
            try:
                stored = json.loads(stored_sig["value"])
            except Exception:
                stored = stored_sig["value"]
        if count == 0 or stored != current:
            data = load_workbook_data(WORKBOOK_PATH)
            import_data_into_db(data)
    else:
        print(f"[Flowerpedia] No hay Excel cargado todavía. El administrador podrá importar current_week.xlsx desde el panel.")
    migrate_product_availability()
    _LAST_WORKBOOK_SIGNATURE = workbook_signature()
    publish_public_site()
    if start_watcher is None:
        start_watcher = not bool(os.environ.get("RENDER") or os.environ.get("FLOWERPEDIA_DISABLE_EXCEL_WATCHER"))
    if start_watcher and WORKBOOK_PATH.exists() and not _WATCHER_STARTED:
        thread = threading.Thread(target=workbook_watcher, daemon=True, name="FlowerpediaExcelWatcher")
        thread.start()
        _WATCHER_STARTED = True


def has_users():
    with db_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] > 0


def csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(24)
    return session["csrf_token"]


@app.context_processor
def inject_globals():
    return {"csrf_token": csrf_token(), "app_name": "Flowerpedia"}


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.path.startswith("/api/") or request.path.startswith("/admin"):
        response.headers["Cache-Control"] = "no-store, private"
    return response


@app.before_request
def csrf_guard():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.path.startswith("/api/"):
        supplied = request.headers.get("X-CSRF-Token")
        expected = session.get("csrf_token")
        if not expected or not supplied or not secrets.compare_digest(str(supplied), str(expected)):
            return jsonify({"ok": False, "error": "Sesión de seguridad vencida. Recarga la página."}), 400


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    with db_conn() as conn:
        row = conn.execute("SELECT id,username,role,is_active,avatar_path FROM users WHERE id=?", (uid,)).fetchone()
    if not row or not row["is_active"]:
        session.clear()
        return None
    return dict(row)


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Tu sesión ha caducado. Inicia sesión de nuevo."}), 401
            return redirect(url_for("login_page"))
        if user["role"] != "admin":
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Esta función requiere permisos de administrador."}), 403
            abort(403)
        return fn(*args, **kwargs)
    return wrapper


def login_attempts_blocked(ip_address):
    cutoff = (datetime.now() - timedelta(minutes=15)).isoformat(timespec="seconds")
    with db_conn() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM login_attempts WHERE ip_address=? AND succeeded=0 AND attempted_at>=?",
            (ip_address, cutoff)
        ).fetchone()["n"]
    return count >= 8


def record_login_attempt(ip_address, succeeded):
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO login_attempts(ip_address,attempted_at,succeeded) VALUES(?,?,?)",
            (ip_address, now_iso(), 1 if succeeded else 0)
        )
        conn.execute("DELETE FROM login_attempts WHERE attempted_at < datetime('now','-2 days')")
        if succeeded:
            conn.execute("DELETE FROM login_attempts WHERE ip_address=? AND succeeded=0", (ip_address,))


def safe_image_ext(filename):
    ext = Path(filename).suffix.lower().lstrip(".")
    return ext if ext in ALLOWED_IMAGE_EXTENSIONS else None


def find_product_row_by_key(key):
    for _, row in get_rows():
        if make_product_key(row.get("Categoría"), row.get("Producto")) == key:
            return row
    return None


def media_folder_for(category, product):
    return UPLOAD_DIR / slugify(category) / slugify(product)


def copy_media_key(old_key, new_key, category, product):
    if old_key == new_key:
        return
    images = get_media().get(old_key, [])
    if not images:
        return
    old_folder = None
    for _, row in get_rows():
        if make_product_key(row.get("Categoría"), row.get("Producto")) == old_key:
            old_folder = media_folder_for(row.get("Categoría"), row.get("Producto"))
            break
    new_folder = media_folder_for(category, product)
    new_folder.mkdir(parents=True, exist_ok=True)
    new_images = []
    for index, item in enumerate(images, 1):
        rel = item.get("path") if isinstance(item, dict) else str(item)
        if not rel:
            continue
        source = UPLOAD_DIR / rel
        if source.exists():
            ext = source.suffix.lower()
            target_name = f"{index:02d}-{slugify(product)[:28]}-{uuid.uuid4().hex[:8]}{ext}"
            target = new_folder / target_name
            if source.resolve() != target.resolve():
                shutil.copy2(source, target)
            new_rel = target.relative_to(UPLOAD_DIR).as_posix()
            new_images.append({"path": new_rel})
    if new_images:
        with db_conn() as conn:
            conn.execute("INSERT OR REPLACE INTO product_media(product_key,images_json) VALUES(?,?)",
                         (new_key, json.dumps(new_images, ensure_ascii=False)))


@app.get("/setup")
def setup_page():
    if has_users():
        return redirect(url_for("login_page"))
    if os.environ.get("FLOWERPEDIA_REQUIRE_INITIAL_ADMIN") == "1":
        abort(503, description="La cuenta inicial no está configurada. Revisa INITIAL_ADMIN_USERNAME e INITIAL_ADMIN_PASSWORD en las variables privadas del servicio.")
    return render_template("setup.html")


@app.post("/setup")
def setup_submit():
    if has_users():
        return redirect(url_for("login_page"))
    if os.environ.get("FLOWERPEDIA_REQUIRE_INITIAL_ADMIN") == "1":
        abort(503, description="La creación inicial de administrador se configura desde las variables privadas del servicio.")
    username = (request.form.get("username") or "").strip().lower()
    password = request.form.get("password") or ""
    confirm = request.form.get("confirm_password") or ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,29}", username) or len(password) < 4 or password != confirm:
        flash("El usuario debe tener entre 3 y 30 caracteres (letras, números, punto, guion o guion bajo); la contraseña debe tener al menos 4 caracteres y ambas contraseñas deben coincidir.", "error")
        return redirect(url_for("setup_page"))
    with db_conn() as conn:
        cur = conn.execute("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?)",
                           (username, generate_password_hash(password), "admin", 1, now_iso()))
        uid = cur.lastrowid
    session["user_id"] = uid
    session.permanent = True
    return redirect(url_for("admin_page"))


@app.route("/access", methods=["GET", "POST"])
def access_page():
    # Compatibilidad con enlaces antiguos: ya no existe clave global del catálogo.
    return redirect(url_for("login_page"))


@app.route("/login", methods=["GET", "POST"])
def login_page():
    if not has_users():
        return redirect(url_for("setup_page"))
    if request.method == "POST":
        username = (request.form.get("username") or "").strip().lower()
        password = request.form.get("password") or ""
        ip_address = request.remote_addr or "unknown"
        if login_attempts_blocked(ip_address):
            flash("Demasiados intentos. Espera 15 minutos antes de volver a intentarlo.", "error")
            return redirect(url_for("login_page"))
        with db_conn() as conn:
            user = conn.execute("SELECT * FROM users WHERE lower(username)=? AND is_active=1", (username,)).fetchone()
        if user and check_password_hash(user["password_hash"], password):
            record_login_attempt(ip_address, True)
            session["user_id"] = user["id"]
            session.permanent = True
            return redirect(url_for("admin_page") if user["role"] == "admin" else url_for("index_page"))
        record_login_attempt(ip_address, False)
        flash("Usuario o contraseña incorrectos.", "error")
    return render_template("login.html")


@app.post("/api/login")
def api_login():
    payload = request.get_json(silent=True) or {}
    username, password = (payload.get("username") or "").strip().lower(), payload.get("password") or ""
    ip_address = request.remote_addr or "unknown"
    if login_attempts_blocked(ip_address):
        return jsonify({"ok": False, "error": "Demasiados intentos. Espera 15 minutos antes de volver a intentarlo."}), 429
    with db_conn() as conn:
        user = conn.execute("SELECT * FROM users WHERE lower(username)=? AND is_active=1", (username.casefold(),)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        record_login_attempt(ip_address, False)
        return jsonify({"ok": False, "error": "Usuario o contraseña incorrectos."}), 401
    record_login_attempt(ip_address, True)
    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True
    return jsonify({"ok": True, "user": {"id": user["id"], "username": user["username"], "role": user["role"],
                                          "avatar": f"/avatar/{quote(user['avatar_path'], safe='/')}" if user["avatar_path"] else None},
                    "csrfToken": csrf_token()})


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True, "csrfToken": csrf_token()})


@app.get("/")
def index_page():
    return send_from_directory(DOCS_DIR, "index.html")


@app.get("/<five:code>/<category_slug>/<product_slug>", endpoint="product_page_short")
def product_page_short(code, category_slug, product_slug):
    return send_from_directory(DOCS_DIR, "index.html")


@app.get("/producto/<category_slug>/<product_slug>", strict_slashes=False)
def product_page_legacy(category_slug, product_slug):
    # Old shared links remain usable; the frontend resolves the old ID and replaces the URL.
    return send_from_directory(DOCS_DIR, "index.html")


@app.get("/admin")
@admin_required
def admin_page():
    return render_template("admin.html", user=current_user())


@app.get("/assets/<path:filename>")
def public_asset(filename):
    return send_from_directory(DOCS_DIR / "assets", filename)


@app.get("/catalog.json")
def public_catalog_json():
    sync_excel_if_changed()
    groups = get_catalog_groups(local_images=True)
    return jsonify({
        "app": "Flowerpedia",
        "version": "0.3.4",
        "products": [public_group(group) for group in groups],
        "farms": [{"Nombre": farm.get("Nombre"), "Llegada": farm.get("Llegada") or "-"} for farm in get_farms()],
        "stats": {"products": len(groups), "rows": len(get_rows()), "farms": len(get_farms())},
    })


@app.get("/admin-static/<path:filename>", endpoint="admin_static")
def admin_static_file(filename):
    return send_from_directory(BASE_DIR / "static", filename)


@app.get("/logout")
def logout():
    session.pop("user_id", None)
    return redirect(url_for("login_page"))


@app.get("/logout-site")
def logout_site():
    # Compatibilidad con enlaces antiguos: cierra la sesión local de administración.
    session.clear()
    return redirect(url_for("index_page"))


@app.get("/api/catalog")
def api_catalog():
    sync_excel_if_changed()
    groups = get_catalog_groups(local_images=True)
    user = current_user()
    is_admin = bool(user and user["role"] == "admin")
    # Public visitors and staff never receive private prices or composition totals.
    result = [public_group(group, include_admin_composition=is_admin) for group in groups]
    if is_admin:
        # One authenticated catalogue response supplies all commercial rows.
        # Product navigation then stays in memory instead of requesting Excel-backed data per click.
        commercial_fields = (
            "Finca", "Tamaño", "Caja EC", "Op", "Caja Finca", "Total Tallos",
            "Compra", "Markup", "Venta", "Caja UK", "Op UK", "Compra UK",
            "Markup UK", "Venta UK", "_FarmArrival", "_boxECInfo",
            "_boxFincaInfo", "_boxUKInfo", "_Op_diferencia", "_Op_UK_diferencia",
        )
        for item, group in zip(result, groups):
            item["variants"] = [
                {key: row.get(key) for key in commercial_fields if key in row}
                for row in group.get("variants", [])
            ]
    safe_user = None
    if user:
        safe_user = {"id": user["id"], "username": user["username"], "role": user["role"],
                     "avatar": f"/avatar/{quote(user['avatar_path'], safe='/')}" if user.get("avatar_path") else None}
    return jsonify({"ok": True, "products": result, "farms": get_farms(),
                    "user": safe_user, "csrfToken": csrf_token(),
                    "stats": {"rows": len(get_rows()), "products": len(groups), "farms": len(get_farms())}})


@app.get("/api/session")
def api_session():
    user = current_user()
    safe_user = None if not user else {"id": user["id"], "username": user["username"], "role": user["role"],
                                       "avatar": f"/avatar/{quote(user['avatar_path'], safe='/')}" if user.get("avatar_path") else None}
    return jsonify({"ok": True, "user": safe_user, "csrfToken": csrf_token()})


@app.get("/api/commercial/<product_id>")
@admin_required
def api_commercial_data(product_id):
    sync_excel_if_changed()
    group = next((item for item in get_catalog_groups(local_images=True) if str(item.get("id")) == str(product_id)), None)
    if not group:
        return jsonify({"ok": False, "error": "Producto no encontrado."}), 404
    return jsonify({
        "ok": True,
        "variants": group.get("variants", []),
        "composition": group.get("Tabla", []),
    })


@app.get("/api/admin/data")
@admin_required
def api_admin_data():
    sync_excel_if_changed()
    rows = []
    boxes = get_boxes()
    farms = get_farms()
    settings = get_settings()
    media = get_media()
    for pid, raw in get_rows():
        row = recalculate_row(raw, boxes, farms, settings)
        key = make_product_key(row.get("Categoría"), row.get("Producto"))
        row["_id"] = pid
        row["_productKey"] = key
        row["_images"] = product_images(key, local=True)
        farm = next((f for f in farms if norm(f.get("Nombre")) == norm(row.get("Finca"))), None)
        row["_FarmArrival"] = farm.get("Llegada") if farm else "-"
        rows.append(row)
    return jsonify({
        "ok": True, "products": rows, "boxes": list(boxes.values()), "farms": farms,
        "options": get_options(), "settings": settings, "compositions": get_compositions(),
        "source_filename": get_setting("source_filename", WORKBOOK_PATH.name),
        "workbook_available": WORKBOOK_PATH.exists(),
        "stats": {"rows": len(rows), "products": len(get_catalog_groups(local_images=True)), "boxes": len(boxes), "farms": len(farms)},
    })


def parse_product_payload(payload):
    row = {col: payload.get(col) for col in CANONICAL_COLUMNS}
    row["IMG"] = None
    for key in ("Finca", "Categoría", "Producto"):
        if not str(row.get(key) or "").strip():
            raise ValueError(f"El campo '{key}' es obligatorio.")
    for key in ("Total Tallos", "Compra", "Venta", "Compra UK", "Venta UK"):
        row[key] = as_float(row.get(key))
    row["ID"] = as_float(row.get("ID"))
    row["Disponibilidad"] = "Erradicado" if norm(row.get("Disponibilidad")) in {"erradicado", "eradicated"} else "Disponible"
    return row


def persist_product_row(row, pid=None):
    boxes, farms, settings = get_boxes(), get_farms(), get_settings()
    row = recalculate_row(row, boxes, farms, settings)
    old_key = None
    if pid:
        with db_conn() as conn:
            existing = conn.execute("SELECT row_json FROM products WHERE id=?", (pid,)).fetchone()
        if existing:
            old = json.loads(existing["row_json"])
            old_key = make_product_key(old.get("Categoría"), old.get("Producto"))
    new_key = make_product_key(row.get("Categoría"), row.get("Producto"))
    if old_key and old_key != new_key:
        copy_media_key(old_key, new_key, row.get("Categoría"), row.get("Producto"))
        old_comp = get_compositions().get(old_key)
        if old_comp:
            with db_conn() as conn:
                conn.execute("INSERT OR REPLACE INTO compositions(product_key,rows_json) VALUES(?,?)",
                             (new_key, json.dumps(old_comp, ensure_ascii=False)))
    if pid:
        with db_conn() as conn:
            conn.execute("UPDATE products SET row_json=?,updated_at=? WHERE id=?",
                         (json.dumps(row, ensure_ascii=False), now_iso(), pid))
    else:
        pid = uuid.uuid4().hex
        with db_conn() as conn:
            position = conn.execute("SELECT COALESCE(MAX(position),-1)+1 AS n FROM products").fetchone()["n"]
            conn.execute("INSERT INTO products(id,row_json,position,created_at,updated_at) VALUES(?,?,?,?,?)",
                         (pid, json.dumps(row, ensure_ascii=False), position, now_iso(), now_iso()))
    # Disponibilidad pertenece a la variedad, no a una finca/empaque individual.
    with db_conn() as conn:
        siblings = conn.execute("SELECT id,row_json FROM products").fetchall()
        for sibling in siblings:
            sibling_row = json.loads(sibling["row_json"])
            same_variety = (
                norm(sibling_row.get("Categoría")) == norm(row.get("Categoría"))
                and norm(sibling_row.get("Producto")) == norm(row.get("Producto"))
            )
            if same_variety and sibling_row.get("Disponibilidad") != row["Disponibilidad"]:
                sibling_row["Disponibilidad"] = row["Disponibilidad"]
                conn.execute("UPDATE products SET row_json=?,updated_at=? WHERE id=?",
                             (json.dumps(sibling_row, ensure_ascii=False), now_iso(), sibling["id"]))
    sync_db_to_excel()
    return pid, row


@app.post("/api/admin/products")
@admin_required
def api_admin_create_product():
    try:
        payload = request.get_json(silent=True) or {}
        row = parse_product_payload(payload)
        pid, row = persist_product_row(row)
        key = make_product_key(row.get("Categoría"), row.get("Producto"))
        if "composition" in payload:
            with db_conn() as conn:
                comp = normalize_composition_rows(payload.get("composition"))
                conn.execute("INSERT OR REPLACE INTO compositions(product_key,rows_json) VALUES(?,?)",
                             (key, json.dumps(comp, ensure_ascii=False)))
            sync_db_to_excel()
        return jsonify({"ok": True, "id": pid, "productKey": key, "row": row})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.put("/api/admin/products/<pid>")
@admin_required
def api_admin_update_product(pid):
    try:
        payload = request.get_json(silent=True) or {}
        row = parse_product_payload(payload)
        pid, row = persist_product_row(row, pid)
        key = make_product_key(row.get("Categoría"), row.get("Producto"))
        if "composition" in payload:
            with db_conn() as conn:
                comp = normalize_composition_rows(payload.get("composition"))
                conn.execute("INSERT OR REPLACE INTO compositions(product_key,rows_json) VALUES(?,?)",
                             (key, json.dumps(comp, ensure_ascii=False)))
            sync_db_to_excel()
        return jsonify({"ok": True, "id": pid, "productKey": key, "row": row})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.delete("/api/admin/products/<pid>")
@admin_required
def api_admin_delete_product(pid):
    try:
        with db_conn() as conn:
            conn.execute("DELETE FROM products WHERE id=?", (pid,))
        sync_db_to_excel()
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/admin/compositions/<key>")
@admin_required
def api_admin_save_composition(key):
    payload = request.get_json(silent=True) or {}
    rows = normalize_composition_rows(payload.get("rows"))
    with db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO compositions(product_key,rows_json) VALUES(?,?)",
                     (key, json.dumps(rows, ensure_ascii=False)))
    sync_db_to_excel()
    return jsonify({"ok": True, "rows": rows})


@app.post("/api/admin/media/import-zip")
@admin_required
def api_admin_import_media_zip():
    uploaded = request.files.get("archive")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "error": "Selecciona un archivo ZIP con las carpetas de imágenes."}), 400
    if not uploaded.filename.lower().endswith(".zip"):
        return jsonify({"ok": False, "error": "El archivo debe tener extensión .zip."}), 400

    products_by_folder = {}
    for group in get_catalog_groups(local_images=True):
        category = slugify(group.get("Categoría"))
        product = slugify(group.get("Producto"))
        products_by_folder[(category, product)] = group.get("productKey")

    imported = {}
    image_count = 0
    total_uncompressed = 0
    try:
        with zipfile.ZipFile(uploaded.stream) as archive:
            files = [info for info in archive.infolist() if not info.is_dir()]
            if len(files) > 2000:
                return jsonify({"ok": False, "error": "El ZIP contiene más de 2.000 archivos."}), 400
            for info in files:
                total_uncompressed += int(info.file_size or 0)
                if total_uncompressed > 200 * 1024 * 1024:
                    return jsonify({"ok": False, "error": "El contenido descomprimido supera 200 MB."}), 400
                raw_name = str(info.filename or "").replace("\\", "/")
                relative = PurePosixPath(raw_name)
                parts = [part for part in relative.parts if part not in {"", "."}]
                if relative.is_absolute() or any(part == ".." for part in parts):
                    continue
                while parts and parts[0].casefold() in {"uploads", "images", "private"}:
                    parts = parts[1:]
                if len(parts) < 3 or (parts and parts[0].casefold() == "users"):
                    continue
                category_slug, product_slug = parts[0], parts[1]
                product_key = products_by_folder.get((category_slug.casefold(), product_slug.casefold()))
                extension = safe_image_ext(parts[-1])
                if not product_key or not extension:
                    continue
                if int(info.file_size or 0) > 25 * 1024 * 1024:
                    continue
                # Ignore symbolic links and extract files individually; never use ZipFile.extract().
                unix_mode = (info.external_attr >> 16) & 0o170000
                if unix_mode == 0o120000:
                    continue
                original_name = secure_filename(Path(parts[-1]).stem)[:50] or "imagen"
                folder = UPLOAD_DIR / category_slug / product_slug
                folder.mkdir(parents=True, exist_ok=True)
                filename = f"{uuid.uuid4().hex[:10]}-{original_name}.{extension}"
                destination = folder / filename
                with archive.open(info, "r") as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target)
                relative_path = destination.relative_to(UPLOAD_DIR).as_posix()
                imported.setdefault(product_key, []).append({"path": relative_path})
                image_count += 1
    except zipfile.BadZipFile:
        return jsonify({"ok": False, "error": "El archivo no es un ZIP válido."}), 400
    except Exception as exc:
        return jsonify({"ok": False, "error": f"No se pudo importar el ZIP: {exc}"}), 400

    if not image_count:
        return jsonify({"ok": False, "error": "No se encontraron imágenes que coincidan con carpetas de categoría/producto del catálogo actual."}), 400

    existing_media = get_media()
    with db_conn() as conn:
        for product_key, images in imported.items():
            combined = list(existing_media.get(product_key, [])) + images
            conn.execute("INSERT OR REPLACE INTO product_media(product_key,images_json) VALUES(?,?)",
                         (product_key, json.dumps(combined, ensure_ascii=False)))
    invalidate_catalog_cache()
    publish_public_site()
    return jsonify({
        "ok": True,
        "message": f"Se importaron {image_count} imágenes para {len(imported)} variedades.",
        "images": image_count,
        "products": len(imported),
    })


@app.post("/api/admin/media/<key>")
@admin_required
def api_admin_upload_media(key):
    category = request.form.get("category") or ""
    product = request.form.get("product") or ""
    if make_product_key(category, product) != key:
        return jsonify({"ok": False, "error": "La categoría o el producto no coincide con la clave."}), 400
    folder = media_folder_for(category, product)
    folder.mkdir(parents=True, exist_ok=True)
    images = get_media().get(key, [])
    files = request.files.getlist("images")
    if not files:
        return jsonify({"ok": False, "error": "Selecciona una o varias imágenes."}), 400
    for file in files:
        if not file.filename:
            continue
        ext = safe_image_ext(file.filename)
        if not ext:
            continue
        original = secure_filename(Path(file.filename).stem)[:40] or slugify(product)
        filename = f"{len(images)+1:02d}-{slugify(product)[:28]}-{uuid.uuid4().hex[:8]}-{original}.{ext}"
        target = folder / filename
        file.save(target)
        rel = target.relative_to(UPLOAD_DIR).as_posix()
        images.append({"path": rel})
    with db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO product_media(product_key,images_json) VALUES(?,?)",
                     (key, json.dumps(images, ensure_ascii=False)))
    invalidate_catalog_cache()
    publish_public_site()
    return jsonify({"ok": True, "images": product_images(key, local=True)})


@app.put("/api/admin/media/<key>")
@admin_required
def api_admin_reorder_media(key):
    payload = request.get_json(silent=True) or {}
    order = payload.get("paths") or []
    current = get_media().get(key, [])
    by_path = {x.get("path"): x for x in current}
    if set(order) != set(by_path):
        return jsonify({"ok": False, "error": "La lista de imágenes no coincide con la galería."}), 400
    reordered = [by_path[path] for path in order]
    with db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO product_media(product_key,images_json) VALUES(?,?)",
                     (key, json.dumps(reordered, ensure_ascii=False)))
    invalidate_catalog_cache()
    publish_public_site()
    return jsonify({"ok": True, "images": product_images(key, local=True)})


@app.delete("/api/admin/media/<key>")
@admin_required
def api_admin_delete_media(key):
    payload = request.get_json(silent=True) or {}
    path = payload.get("path")
    images = get_media().get(key, [])
    kept = []
    found = False
    for item in images:
        rel = item.get("path")
        if rel == path:
            found = True
            target = (UPLOAD_DIR / rel).resolve()
            if UPLOAD_DIR.resolve() in target.parents and target.exists():
                target.unlink()
        else:
            kept.append(item)
    if not found:
        return jsonify({"ok": False, "error": "No se encontró la imagen."}), 404
    with db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO product_media(product_key,images_json) VALUES(?,?)",
                     (key, json.dumps(kept, ensure_ascii=False)))
    invalidate_catalog_cache()
    publish_public_site()
    return jsonify({"ok": True, "images": product_images(key, local=True)})


@app.get("/media/<path:filename>")
def media_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.get("/avatar/<path:filename>")
def avatar_file(filename):
    return send_from_directory(UPLOAD_DIR / "users", filename)


@app.post("/api/admin/boxes")
@admin_required
def api_admin_create_box():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("Nombre") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Escribe el nombre de la caja."}), 400
    boxes = get_boxes()
    if lookup_box(boxes, name):
        return jsonify({"ok": False, "error": "Ya existe una caja con ese nombre."}), 400
    dims = [as_float(payload.get(k)) for k in ("Largo", "Ancho", "Alto")]
    if None in dims or any(x <= 0 for x in dims):
        return jsonify({"ok": False, "error": "Las tres dimensiones deben ser mayores que cero."}), 400
    settings = get_settings()
    box = {"Nombre": name, "Largo": dims[0], "Ancho": dims[1], "Alto": dims[2], "U2": as_float(payload.get("U2"))}
    box_map = dict(boxes)
    box_map[name] = box
    recalculate_box_records(list(box_map.values()), settings["safety_margin_cm"])
    box = next(b for b in box_map.values() if norm(b["Nombre"]) == norm(name))
    with db_conn() as conn:
        for box_name, box_value in box_map.items():
            conn.execute("INSERT OR REPLACE INTO boxes(name,box_json) VALUES(?,?)",
                         (box_name, json.dumps(box_value, ensure_ascii=False)))
    recalculate_all()
    sync_db_to_excel()
    return jsonify({"ok": True, "box": box})


@app.put("/api/admin/boxes/<path:name>")
@admin_required
def api_admin_update_box(name):
    boxes = get_boxes()
    box = lookup_box(boxes, name)
    if not box:
        return jsonify({"ok": False, "error": "No se encontró la caja."}), 404
    payload = request.get_json(silent=True) or {}
    updated = dict(box)
    for key in ("Largo", "Ancho", "Alto"):
        value = as_float(payload.get(key))
        if value is None or value <= 0:
            return jsonify({"ok": False, "error": f"{key} debe ser mayor que cero."}), 400
        updated[key] = value
    if "U2" in payload:
        value = as_float(payload.get("U2"))
        if value is not None and value < 0:
            return jsonify({"ok": False, "error": "U2 debe ser cero o mayor."}), 400
        updated["U2"] = value
    boxes[box["Nombre"]] = updated
    recalculated = recalculate_box_records(list(boxes.values()), get_settings()["safety_margin_cm"])
    with db_conn() as conn:
        for name_key, item in recalculated.items():
            conn.execute("UPDATE boxes SET box_json=? WHERE name=?",
                         (json.dumps(item, ensure_ascii=False), name_key))
    recalculate_all()
    sync_db_to_excel()
    return jsonify({"ok": True, "box": recalculated[box["Nombre"]]})


@app.get("/api/admin/users")
@admin_required
def api_admin_users():
    with db_conn() as conn:
        rows = conn.execute("SELECT id,username,role,is_active,avatar_path,created_at FROM users ORDER BY id").fetchall()
    signed_in = current_user()
    return jsonify({"ok": True, "current_user_id": signed_in["id"] if signed_in else None,
                    "users": [dict(r) for r in rows]})


@app.post("/api/admin/users")
@admin_required
def api_admin_create_user():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = payload.get("role") or "staff"
    if len(username) < 3 or len(password) < 4 or role not in {"admin", "staff"}:
        return jsonify({"ok": False, "error": "Usuario mínimo 3 caracteres; contraseña mínimo 4; rol no válido."}), 400
    try:
        with db_conn() as conn:
            cur = conn.execute("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?)",
                               (username, generate_password_hash(password), role, 1, now_iso()))
        return jsonify({"ok": True, "id": cur.lastrowid})
    except sqlite3.IntegrityError:
        return jsonify({"ok": False, "error": "Ese usuario ya existe."}), 400


@app.patch("/api/admin/users/<int:uid>")
@admin_required
def api_admin_update_user(uid):
    payload = request.get_json(silent=True) or {}
    with db_conn() as conn:
        target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return jsonify({"ok": False, "error": "Usuario no encontrado."}), 404
        role = payload.get("role", target["role"])
        active = int(bool(payload.get("is_active", target["is_active"])))
        password = payload.get("password")
        signed_in = current_user()
        if signed_in and signed_in["id"] == uid and (role != "admin" or not active):
            return jsonify({"ok": False, "error": "No puedes quitarte el rol de administrador ni desactivar tu propia cuenta."}), 400
        if role not in {"admin", "staff"}:
            return jsonify({"ok": False, "error": "Rol no válido."}), 400
        if password and len(password) < 4:
            return jsonify({"ok": False, "error": "La contraseña debe tener al menos 4 caracteres."}), 400
        if target["role"] == "admin" and (role != "admin" or not active):
            n = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").fetchone()["n"]
            if n <= 1:
                return jsonify({"ok": False, "error": "No puedes desactivar el último administrador."}), 400
        if password:
            conn.execute("UPDATE users SET role=?,is_active=?,password_hash=? WHERE id=?",
                         (role, active, generate_password_hash(password), uid))
        else:
            conn.execute("UPDATE users SET role=?,is_active=? WHERE id=?", (role, active, uid))
    return jsonify({"ok": True})


@app.delete("/api/admin/users/<int:uid>")
@admin_required
def api_admin_delete_user(uid):
    user = current_user()
    if user and user["id"] == uid:
        return jsonify({"ok": False, "error": "No puedes eliminar tu propia cuenta."}), 400
    with db_conn() as conn:
        target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return jsonify({"ok": False, "error": "Usuario no encontrado."}), 404
        if target["role"] == "admin":
            n = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").fetchone()["n"]
            if n <= 1:
                return jsonify({"ok": False, "error": "No puedes eliminar el último administrador."}), 400
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
    return jsonify({"ok": True})


@app.post("/api/admin/users/<int:uid>/avatar")
@admin_required
def api_admin_user_avatar(uid):
    file = request.files.get("avatar")
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "Selecciona una imagen."}), 400
    ext = safe_image_ext(file.filename)
    if not ext:
        return jsonify({"ok": False, "error": "Formato permitido: JPG, PNG, WEBP o GIF."}), 400
    folder = UPLOAD_DIR / "users" / str(uid)
    folder.mkdir(parents=True, exist_ok=True)
    filename = f"avatar-{uuid.uuid4().hex[:8]}.{ext}"
    file.save(folder / filename)
    rel = f"{uid}/{filename}"
    with db_conn() as conn:
        conn.execute("UPDATE users SET avatar_path=? WHERE id=?", (rel, uid))
    return jsonify({"ok": True, "avatar": f"/avatar/{quote(rel, safe='/')}"})


@app.post("/api/admin/settings")
@admin_required
def api_admin_settings():
    payload = request.get_json(silent=True) or {}
    for key in DEFAULT_SETTINGS:
        if key in payload:
            value = as_float(payload[key])
            if value is None or value < 0 or (key in {"uk_exchange_rate", "us_sale_factor", "uk_sale_factor"} and value == 0):
                return jsonify({"ok": False, "error": f"Parámetro no válido: {key}."}), 400
            set_setting(key, value)
    boxes = recalculate_box_records(list(get_boxes().values()), get_settings()["safety_margin_cm"])
    with db_conn() as conn:
        for name, box in boxes.items():
            conn.execute("UPDATE boxes SET box_json=? WHERE name=?", (json.dumps(box, ensure_ascii=False), name))
    recalculate_all()
    sync_db_to_excel()
    return jsonify({"ok": True, "settings": get_settings()})


@app.post("/api/admin/import")
@admin_required
def api_admin_import():
    uploaded = request.files.get("workbook")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "error": "Selecciona un Excel .xlsx."}), 400
    filename = secure_filename(uploaded.filename)
    if not filename.lower().endswith(".xlsx"):
        return jsonify({"ok": False, "error": "Solo se aceptan archivos .xlsx."}), 400
    temp = DATA_DIR / f"upload_{uuid.uuid4().hex}.xlsx"
    uploaded.save(temp)
    try:
        data = load_workbook_data(temp)
        if WORKBOOK_PATH.exists():
            shutil.copy2(WORKBOOK_PATH, BACKUP_DIR / "previous.xlsx")
        os.replace(temp, WORKBOOK_PATH)
        data["source_filename"] = filename
        import_data_into_db(data)
        set_setting("source_filename", filename)
        migrate_product_availability()
        publish_public_site()
        return jsonify({"ok": True, "message": f"Excel actualizado: {len(data['products'])} filas, {len(data['boxes'])} cajas y {len(data['farms'])} fincas."})
    except Exception as exc:
        return jsonify({"ok": False, "error": f"No se pudo importar el Excel: {exc}"}), 400
    finally:
        temp.unlink(missing_ok=True)


@app.post("/api/admin/publish")
@admin_required
def api_admin_publish():
    try:
        sync_result = publish_public_site() or {"ok": False, "message": "No se pudo actualizar el catálogo."}
        message = "Flowerpedia ha actualizado el catálogo del servidor. " + sync_result.get("message", "")
        return jsonify({"ok": True, "message": message, "database": {"type": "SQLite", "persistent": True}})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/admin/export.xlsx")
@admin_required
def admin_export_excel():
    if not WORKBOOK_PATH.exists():
        abort(404)
    return send_file(WORKBOOK_PATH, as_attachment=True, download_name="Flowerpedia_current_week.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/health")
def health():
    return jsonify({"ok": True, "app": "Flowerpedia", "version": "0.3.4"})


def open_admin_when_ready():
    """Open the admin page only after the local server is responding."""
    health_url = "http://127.0.0.1:5000/health"
    admin_url = "http://127.0.0.1:5000/admin"
    for _ in range(90):
        try:
            with urlopen(health_url, timeout=1) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if (
                    response.status == 200
                    and payload.get("app") == "Flowerpedia"
                    and payload.get("version") == "0.3.4"
                ):
                    webbrowser.open_new_tab(admin_url)
                    return
        except Exception:
            pass
        time.sleep(1)
    print("[Flowerpedia] El servidor no respondió a tiempo; abre manualmente http://127.0.0.1:5000/admin")


def start_server():
    initialize_app()
    print("\nFlowerpedia v0.3.4")
    print(f"Excel activo: {WORKBOOK_PATH}")
    print("Sincronización Excel ↔ Flowerpedia: activa (revisión cada 2,5 segundos)")
    print("Catálogo local: http://127.0.0.1:5000")
    print("Administración: http://127.0.0.1:5000/admin")
    print("El navegador se abrirá cuando el servidor esté listo.")
    print("Mantén esta ventana abierta mientras uses Flowerpedia. Pulsa Ctrl+C para detenerlo.")
    threading.Thread(target=open_admin_when_ready, daemon=True).start()
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False, use_reloader=False)


if __name__ == "__main__":
    start_server()
elif os.environ.get("FLOWERPEDIA_AUTOINIT", "1").lower() not in {"0", "false", "no"}:
    initialize_app(start_watcher=not bool(os.environ.get("RENDER") or os.environ.get("FLOWERPEDIA_DISABLE_EXCEL_WATCHER")))
