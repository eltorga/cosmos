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
import unicodedata
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal, ROUND_UP
from functools import wraps
from pathlib import Path
from typing import Any

from flask import (
    Flask, abort, flash, jsonify, redirect, render_template, request,
    send_file, session, url_for
)
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "bloomdesk.sqlite3"
WORKBOOK_PATH = DATA_DIR / "current_week.xlsx"

DATA_DIR.mkdir(exist_ok=True)
BACKUP_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
secret_path = DATA_DIR / ".secret_key"
if secret_path.exists():
    app.secret_key = secret_path.read_text(encoding="utf-8").strip()
else:
    app.secret_key = secrets.token_hex(32)
    secret_path.write_text(app.secret_key, encoding="utf-8")

app.config.update(
    MAX_CONTENT_LENGTH=30 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Localhost HTTP; enable HTTPS before public deployment.
    PERMANENT_SESSION_LIFETIME=60 * 60 * 10,
)

CANONICAL_COLUMNS = [
    "Finca", "ID", "Categoría", "Producto", "Composición", "Color 1",
    "Color 2", "Season", "Tamaño", "Tabla", "IMG", "Caja EC", "Op",
    "Caja Finca", "Total Tallos", "Compra", "Markup", "Venta", "Caja UK",
    "Op UK", "Compra UK", "Markup UK", "Venta UK",
]
REQUIRED_COLUMNS = {"Finca", "Categoría", "Producto"}
STANDARD_US_BOXES = {"SB", "EB", "QB", "HB", "EB2", "QB2"}
BOX_COLUMNS = [
    "Nombre", "Largo", "Ancho", "Alto", "Peso", "Aprobado",
    "Largo2", "Ancho2", "Alto2", "Peso Pulgadas",
    "40cm", "50cm", "60cm", "70cm", "80cm", "90cm", "100cm",
]
FARM_COLUMNS = ["Llegada", "Nombre", "ID", "Agencia", "Notas"]
DEFAULT_FORMULA_SETTINGS = {
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

def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")

def norm(value: Any) -> str:
    s = "" if value is None else str(value).strip()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s).casefold()

def clean_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (int, float, str, bool)):
        return value
    try:
        return str(value)
    except Exception:
        return None

def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, str):
        value = value.strip().replace(",", ".")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def round_up_2(value: float) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_UP))

def table_bounds(ws, table_name: str):
    wanted = norm(table_name)
    for table in ws.tables.values():
        if norm(getattr(table, "displayName", "")) == wanted or norm(getattr(table, "name", "")) == wanted:
            return range_boundaries(table.ref), table
    return None, None

def find_sheet(wb, wanted_name: str):
    wanted = norm(wanted_name)
    for ws in wb.worksheets:
        if norm(ws.title) == wanted:
            return ws
    return None

def read_table(ws, table_name: str, required_headers=None):
    bounds, table = table_bounds(ws, table_name)
    if bounds:
        min_col, min_row, max_col, max_row = bounds
    else:
        min_col = min_row = max_col = max_row = None
        required = {norm(x) for x in (required_headers or [])}
        for r in range(1, min(ws.max_row, 20) + 1):
            values = {norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)}
            if required and required.issubset(values):
                min_col, min_row, max_col, max_row = 1, r, ws.max_column, ws.max_row
                break
        if min_row is None:
            raise ValueError(f"No se encontró la tabla/encabezado '{table_name}' en la hoja '{ws.title}'.")
    headers = []
    for c in range(min_col, max_col + 1):
        h = ws.cell(min_row, c).value
        headers.append(str(h).strip() if h is not None else "")
    header_map = {norm(h): h for h in headers if h}
    records = []
    for r in range(min_row + 1, max_row + 1):
        row = {}
        for c, header in zip(range(min_col, max_col + 1), headers):
            if header:
                row[header] = clean_value(ws.cell(r, c).value)
        records.append(row)
    return headers, records, (min_col, min_row, max_col, max_row), table

def canonicalize_product_row(raw: dict) -> dict:
    lookup = {norm(k): v for k, v in raw.items() if k}
    out = {}
    for col in CANONICAL_COLUMNS:
        out[col] = clean_value(lookup.get(norm(col)))
    # Keep only the expected catalog fields, but do not rely on their worksheet positions.
    return out

def load_workbook_data(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"No existe el archivo Excel: {path}")
    wb = load_workbook(path, data_only=True, read_only=False)

    catalog_ws = find_sheet(wb, "Catalogo")
    if catalog_ws is None:
        raise ValueError("El Excel no contiene una pestaña llamada 'Catalogo'.")

    headers, raw_products, catalog_bounds, catalog_table = read_table(
        catalog_ws, "Catalogo", required_headers=REQUIRED_COLUMNS
    )
    normalized_headers = {norm(h) for h in headers if h}
    missing = [c for c in REQUIRED_COLUMNS if norm(c) not in normalized_headers]
    if missing:
        raise ValueError("Faltan columnas obligatorias en Catalogo: " + ", ".join(missing))

    products = []
    for raw in raw_products:
        row = canonicalize_product_row(raw)
        if not row.get("Producto") and not row.get("Categoría"):
            continue
        # Skip formula-only blank rows and empty template rows.
        if not any(row.get(k) not in (None, "") for k in ("Finca", "Categoría", "Producto")):
            continue
        products.append(row)

    # Box dimensions are read from the table named Cajas in Sheet1.
    boxes = []
    box_ws = find_sheet(wb, "Sheet1")
    if box_ws is None:
        raise ValueError("El Excel no contiene la pestaña 'Sheet1' con las dimensiones de cajas.")
    _, raw_boxes, _, _ = read_table(box_ws, "Cajas", required_headers={"Nombre", "Largo", "Ancho", "Alto"})
    for raw in raw_boxes:
        lookup = {norm(k): v for k, v in raw.items() if k}
        name = lookup.get(norm("Nombre"))
        if not name:
            continue
        box = {col: clean_value(lookup.get(norm(col))) for col in BOX_COLUMNS}
        box["Nombre"] = str(name).strip()
        length, width, height = (as_float(box.get(k)) for k in ("Largo", "Ancho", "Alto"))
        if box.get("Peso") in (None, "") and None not in (length, width, height):
            box["Peso"] = length * width * height / 6000
        if box.get("Largo2") in (None, "") and length is not None:
            box["Largo2"] = round_up_2(length / 2.54)
        if box.get("Ancho2") in (None, "") and width is not None:
            box["Ancho2"] = round_up_2(width / 2.54)
        if box.get("Alto2") in (None, "") and height is not None:
            box["Alto2"] = round_up_2(height / 2.54)
        boxes.append(box)

    # Rebuild formula-driven box flags when Excel has no cached formula values.
    initial_box_map = {str(b["Nombre"]): b for b in boxes if b.get("Nombre")}
    for box in boxes:
        if box.get("Aprobado") in (None, ""):
            box["Aprobado"] = calculate_approved(box, initial_box_map)

    farms = []
    farms_ws = find_sheet(wb, "Fincas")
    if farms_ws is not None:
        _, raw_farms, _, _ = read_table(farms_ws, "Fincas", required_headers={"Nombre"})
        for raw in raw_farms:
            lookup = {norm(k): v for k, v in raw.items() if k}
            name = lookup.get(norm("Nombre"))
            if not name:
                continue
            farms.append({col: clean_value(lookup.get(norm(col))) for col in FARM_COLUMNS})

    options = {"Categoría": [], "Season": [], "Color": [], "Tamaño": []}
    guides_ws = find_sheet(wb, "Guias")
    if guides_ws is not None:
        for table_name, option_key in [
            ("Category", "Categoría"), ("Season", "Season"),
            ("Colors", "Color"), ("Size", "Tamaño")
        ]:
            try:
                _, records, _, _ = read_table(guides_ws, table_name)
                vals = []
                for rec in records:
                    for value in rec.values():
                        if value not in (None, ""):
                            vals.append(str(value).strip())
                            break
                options[option_key] = list(dict.fromkeys(vals))
            except Exception:
                pass

    safety_margin = 2.0
    if box_ws["U2"].value not in (None, ""):
        safety_margin = as_float(box_ws["U2"].value) or 2.0

    if not products:
        raise ValueError("La tabla Catalogo se encontró, pero no contiene registros de productos.")
    if not boxes:
        raise ValueError("La tabla Cajas de Sheet1 no contiene dimensiones.")
    return {
        "products": products,
        "boxes": boxes,
        "farms": farms,
        "options": options,
        "safety_margin_cm": safety_margin,
        "catalog_headers": headers,
        "source_filename": path.name,
    }

@contextmanager
def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def init_db():
    with db_conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','staff')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            row_json TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'excel',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS boxes (
            name TEXT PRIMARY KEY,
            box_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS farms (
            name TEXT PRIMARY KEY,
            farm_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS options (
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(kind, value)
        );
        """)
        for key, value in DEFAULT_FORMULA_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
                (key, json.dumps(value))
            )

def get_setting(key: str, default=None):
    with db_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except Exception:
        return row["value"]

def set_setting(key: str, value):
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value))
        )

def get_formula_settings():
    settings = dict(DEFAULT_FORMULA_SETTINGS)
    with db_conn() as conn:
        rows = conn.execute("SELECT key,value FROM settings").fetchall()
    for row in rows:
        if row["key"] in settings:
            try:
                settings[row["key"]] = json.loads(row["value"])
            except Exception:
                pass
    return settings

def get_boxes() -> dict[str, dict]:
    with db_conn() as conn:
        rows = conn.execute("SELECT name,box_json FROM boxes").fetchall()
    return {r["name"]: json.loads(r["box_json"]) for r in rows}

def get_farms() -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute("SELECT name,farm_json FROM farms ORDER BY name").fetchall()
    return [json.loads(r["farm_json"]) for r in rows]

def get_options() -> dict:
    out = {}
    with db_conn() as conn:
        rows = conn.execute("SELECT kind,value FROM options ORDER BY value").fetchall()
    for row in rows:
        out.setdefault(row["kind"], []).append(row["value"])
    return out

def get_products_raw() -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute("SELECT id,row_json,source FROM products ORDER BY created_at,id").fetchall()
    out = []
    for r in rows:
        item = json.loads(r["row_json"])
        item["_id"] = r["id"]
        item["_source"] = r["source"]
        out.append(item)
    return out

def product_id() -> str:
    return uuid.uuid4().hex

def lookup_box(boxes: dict, name: Any):
    if not name:
        return None
    wanted = str(name).strip()
    if wanted in boxes:
        return boxes[wanted]
    target = norm(wanted)
    for key, value in boxes.items():
        if norm(key) == target:
            return value
    return None

def calculate_approved(box: dict, boxes: dict):
    name = str(box.get("Nombre") or "")
    candidates = ["QB2", "EB2", "QB", "EB", "HB", "SB"]
    code = next((c for c in candidates if c in name.upper()), "")
    if not code:
        return ""
    base = lookup_box(boxes, code)
    weight = as_float(box.get("Peso"))
    base_weight = as_float(base.get("Peso")) if base else None
    if weight is None:
        length, width, height = (as_float(box.get(k)) for k in ("Largo", "Ancho", "Alto"))
        if None not in (length, width, height):
            weight = length * width * height / 6000
    if weight is None or base_weight is None:
        return ""
    return "y" if weight <= base_weight else "n"

def calculate_op_us(row: dict, boxes: dict):
    box_type = str(row.get("Caja EC") or "").strip()
    farm_box_name = str(row.get("Caja Finca") or "").strip()
    if not box_type or not farm_box_name:
        return ""
    if box_type.casefold() not in farm_box_name.casefold():
        return ""
    farm_box = lookup_box(boxes, farm_box_name)
    if not farm_box:
        return "NO ENCONTRADO"
    approved = farm_box.get("Aprobado")
    if approved in (None, ""):
        approved = calculate_approved(farm_box, boxes)
    return str(approved or "")

def calculate_op_uk(row: dict, boxes: dict):
    uk_box_name = str(row.get("Caja UK") or "").strip()
    farm_box_name = str(row.get("Caja Finca") or "").strip()
    if not uk_box_name or not farm_box_name:
        return ""
    uk_type = uk_box_name.replace(" UK", "").strip()
    if uk_type.casefold() not in farm_box_name.casefold():
        return ""
    farm_box = lookup_box(boxes, farm_box_name)
    uk_box = lookup_box(boxes, uk_box_name)
    if not farm_box or not uk_box:
        return "NO ENCONTRADO"
    weight = as_float(farm_box.get("Peso"))
    length, width, height = (as_float(uk_box.get(k)) for k in ("Largo", "Ancho", "Alto"))
    if weight is None or None in (length, width, height):
        return "NO ENCONTRADO"
    capacity = length * width * height / 6000
    return "y" if weight <= capacity else "n"

def us_cost_components(row: dict, boxes: dict, settings=None):
    settings = settings or get_formula_settings()
    box_type = str(row.get("Caja EC") or "").strip()
    stems = as_float(row.get("Total Tallos"))
    cost = as_float(row.get("Compra"))
    box = lookup_box(boxes, box_type)
    if not box or not box_type or not stems or stems <= 0 or cost is None:
        return None
    length, width, height = (as_float(box.get(k)) for k in ("Largo", "Ancho", "Alto"))
    if None in (length, width, height):
        return None
    if box_type not in STANDARD_US_BOXES:
        margin = float(settings["safety_margin_cm"])
        length, width, height = length + margin, width + margin, height + margin
    volume = length * width * height / 6000
    transport_total = round_up_2(volume * float(settings["us_transport_volume_rate"]) * float(settings["us_transport_multiplier"]))
    transport_per_stem = round_up_2(transport_total / stems)
    duties = round_up_2(cost * float(settings["us_duties_rate"]))
    return {
        "volume": volume,
        "transport_total": transport_total,
        "transport_per_stem": transport_per_stem,
        "duties": duties,
        "cost": cost,
        "total_cost": cost + duties + transport_per_stem,
    }

def calculate_us_markup(row: dict, boxes: dict, settings=None):
    components = us_cost_components(row, boxes, settings)
    price = as_float(row.get("Venta"))
    if components is None or price is None or price <= 0:
        return None
    result = 1 - (components["total_cost"] / (price * float((settings or get_formula_settings())["us_sale_factor"])))
    if result < 0:
        return "BAJO"
    if result > 1:
        return "ALTO"
    return result

def us_price_from_markup(row: dict, target_markup: float, boxes: dict, settings=None):
    settings = settings or get_formula_settings()
    components = us_cost_components(row, boxes, settings)
    if components is None or target_markup < 0 or target_markup >= 1:
        return None
    raw = components["total_cost"] / (float(settings["us_sale_factor"]) * (1 - target_markup))
    return round_up_2(raw)

def uk_cost_components(row: dict, boxes: dict, settings=None):
    settings = settings or get_formula_settings()
    box_name = str(row.get("Caja UK") or "").strip()
    stems = as_float(row.get("Total Tallos"))
    purchase = as_float(row.get("Compra UK"))
    if purchase is None:
        purchase = as_float(row.get("Compra"))
    if not box_name or not stems or stems <= 0 or purchase is None:
        return None
    box = lookup_box(boxes, box_name)
    if not box:
        return None
    length, width, height = (as_float(box.get(k)) for k in ("Largo", "Ancho", "Alto"))
    if None in (length, width, height):
        return None
    volume = length * width * height / 6000
    transport_total = round_up_2(volume * float(settings["uk_transport_volume_rate"]) * float(settings["uk_transport_multiplier"]))
    transport_per_stem = round_up_2(transport_total / stems)
    cost_gbp = purchase / float(settings["uk_exchange_rate"])
    total_cost = round_up_2(cost_gbp + transport_per_stem)
    return {
        "volume": volume,
        "transport_total": transport_total,
        "transport_per_stem": transport_per_stem,
        "cost_gbp": cost_gbp,
        "total_cost": total_cost,
        "purchase_source": purchase,
    }

def calculate_uk_markup(row: dict, boxes: dict, settings=None):
    components = uk_cost_components(row, boxes, settings)
    price = as_float(row.get("Venta UK"))
    if components is None or price is None or price <= 0:
        return None
    settings = settings or get_formula_settings()
    result = 1 - (components["total_cost"] / (price * float(settings["uk_sale_factor"])))
    if result < 0:
        return "BAJO"
    if result > 1:
        return "ALTO"
    return result

def uk_price_from_markup(row: dict, target_markup: float, boxes: dict, settings=None):
    settings = settings or get_formula_settings()
    components = uk_cost_components(row, boxes, settings)
    if components is None or target_markup < 0 or target_markup >= 1:
        return None
    raw = components["total_cost"] / (float(settings["uk_sale_factor"]) * (1 - target_markup))
    return round_up_2(raw)

def recalculate_row(row: dict, boxes: dict, farms: list[dict] | None = None, settings=None):
    out = dict(row)
    if farms:
        farm_map = {norm(f.get("Nombre")): f.get("ID") for f in farms if f.get("Nombre")}
        if out.get("Finca") and farm_map.get(norm(out["Finca"])) is not None:
            out["ID"] = farm_map[norm(out["Finca"])]
    out["Op"] = calculate_op_us(out, boxes)
    out["Op UK"] = calculate_op_uk(out, boxes)
    us_markup = calculate_us_markup(out, boxes, settings)
    if us_markup is not None:
        out["Markup"] = us_markup
    uk_markup = calculate_uk_markup(out, boxes, settings)
    if uk_markup is not None:
        out["Markup UK"] = uk_markup
    return out

def import_data_into_db(data: dict, preserve_manual=True):
    manual = []
    if preserve_manual:
        manual = [p for p in get_products_raw() if p.get("_source") == "manual"]
    with db_conn() as conn:
        conn.execute("DELETE FROM products")
        conn.execute("DELETE FROM boxes")
        conn.execute("DELETE FROM farms")
        conn.execute("DELETE FROM options")
        for box in data["boxes"]:
            name = str(box.get("Nombre") or "").strip()
            if name:
                conn.execute(
                    "INSERT OR REPLACE INTO boxes(name,box_json) VALUES(?,?)",
                    (name, json.dumps(box, ensure_ascii=False))
                )
        for farm in data["farms"]:
            name = str(farm.get("Nombre") or "").strip()
            if name:
                conn.execute(
                    "INSERT OR REPLACE INTO farms(name,farm_json) VALUES(?,?)",
                    (name, json.dumps(farm, ensure_ascii=False))
                )
        for kind, values in data["options"].items():
            for value in values:
                if value:
                    conn.execute("INSERT OR IGNORE INTO options(kind,value) VALUES(?,?)", (kind, str(value)))
        settings = dict(DEFAULT_FORMULA_SETTINGS)
        settings["safety_margin_cm"] = data.get("safety_margin_cm", 2.0)
        for key, value in settings.items():
            if key == "safety_margin_cm":
                conn.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, json.dumps(value))
                )
            else:
                conn.execute(
                    "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
                    (key, json.dumps(value))
                )
        conn.execute(
            "INSERT INTO settings(key,value) VALUES('source_filename',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(data.get("source_filename", "current_week.xlsx")),)
        )
        boxes = {str(b["Nombre"]): b for b in data["boxes"] if b.get("Nombre")}
        for row in data["products"]:
            row = recalculate_row(row, boxes, data["farms"], settings)
            conn.execute(
                "INSERT INTO products(id,row_json,source,created_at,updated_at) VALUES(?,?,?,?,?)",
                (product_id(), json.dumps(row, ensure_ascii=False), "excel", now_iso(), now_iso())
            )
        for row in manual:
            clean = {k: v for k, v in row.items() if not k.startswith("_")}
            clean = recalculate_row(clean, boxes, data["farms"], settings)
            conn.execute(
                "INSERT INTO products(id,row_json,source,created_at,updated_at) VALUES(?,?,?,?,?)",
                (row.get("_id") or product_id(), json.dumps(clean, ensure_ascii=False), "manual", now_iso(), now_iso())
            )

def initialize_data():
    init_db()
    with db_conn() as conn:
        count = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    if count == 0 and WORKBOOK_PATH.exists():
        data = load_workbook_data(WORKBOOK_PATH)
        import_data_into_db(data, preserve_manual=False)
        set_setting("source_filename", "US_WEEK_45.xlsx")

def has_users() -> bool:
    with db_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] > 0

def csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(24)
    return session["csrf_token"]

@app.context_processor
def inject_globals():
    return {"csrf_token": csrf_token(), "app_name": "BloomDesk"}

@app.before_request
def protect_mutations():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.path.startswith("/api/") or request.path in {"/setup", "/access"}:
            supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
            expected = session.get("csrf_token")
            if not expected or not supplied or not secrets.compare_digest(str(supplied), str(expected)):
                return jsonify({"ok": False, "error": "Sesión de seguridad vencida. Recarga la página e inténtalo otra vez."}), 400

def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    with db_conn() as conn:
        row = conn.execute("SELECT id,username,role,is_active FROM users WHERE id=?", (uid,)).fetchone()
    if not row or not row["is_active"]:
        session.pop("user_id", None)
        session.pop("username", None)
        session.pop("role", None)
        return None
    return dict(row)

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login_page"))
        return fn(*args, **kwargs)
    return wrapper

def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return redirect(url_for("login_page"))
        if user["role"] != "admin":
            abort(403)
        return fn(*args, **kwargs)
    return wrapper

def site_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("site_access"):
            return redirect(url_for("access_page"))
        return fn(*args, **kwargs)
    return wrapper

def all_rows_with_calculations():
    boxes = get_boxes()
    farms = get_farms()
    settings = get_formula_settings()
    return [recalculate_row({k: v for k, v in p.items() if not k.startswith("_")}, boxes, farms, settings) | {
        "_id": p["_id"], "_source": p.get("_source", "excel")
    } for p in get_products_raw()]

def group_catalog(rows: list[dict]):
    grouped = {}
    for row in rows:
        key_parts = [
            norm(row.get("Categoría")), norm(row.get("Producto")),
            norm(row.get("Composición")), norm(row.get("Color 1")),
            norm(row.get("Color 2")), norm(row.get("Season")), norm(row.get("IMG")),
            norm(row.get("Tabla")),
        ]
        key = tuple(key_parts)
        if key not in grouped:
            stable = json.dumps(key_parts, ensure_ascii=False)
            gid = hashlib.sha1(stable.encode("utf-8")).hexdigest()[:16]
            grouped[key] = {
                "id": gid,
                "Categoría": row.get("Categoría"),
                "Producto": row.get("Producto"),
                "Composición": row.get("Composición"),
                "Color 1": row.get("Color 1"),
                "Color 2": row.get("Color 2"),
                "Season": row.get("Season"),
                "IMG": row.get("IMG"),
                "Tabla": row.get("Tabla"),
                "Fincas": [],
                "Tamaños": [],
                "variants": [],
            }
        g = grouped[key]
        if row.get("Finca") and row["Finca"] not in g["Fincas"]:
            g["Fincas"].append(row["Finca"])
        if row.get("Tamaño") and row["Tamaño"] not in g["Tamaños"]:
            g["Tamaños"].append(row["Tamaño"])
        g["variants"].append(row)
    result = list(grouped.values())
    result.sort(key=lambda x: (norm(x.get("Categoría")), norm(x.get("Producto"))))
    return result

def serialize_public_group(group: dict, include_prices: bool):
    out = {k: v for k, v in group.items() if k != "variants"}
    if include_prices:
        out["variants"] = group["variants"]
    return out

def get_farm_status_map():
    return {norm(f.get("Nombre")): f for f in get_farms() if f.get("Nombre")}

@app.get("/setup")
def setup_page():
    if has_users():
        return redirect(url_for("access_page"))
    return render_template("setup.html")

@app.post("/setup")
def setup_submit():
    if has_users():
        return redirect(url_for("access_page"))
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    confirm = request.form.get("confirm_password") or ""
    site_password = request.form.get("site_password") or ""
    if len(username) < 3:
        flash("El usuario debe tener al menos 3 caracteres.", "error")
        return redirect(url_for("setup_page"))
    if len(password) < 10:
        flash("La contraseña de administrador debe tener al menos 10 caracteres.", "error")
        return redirect(url_for("setup_page"))
    if password != confirm:
        flash("Las contraseñas de administrador no coinciden.", "error")
        return redirect(url_for("setup_page"))
    if len(site_password) < 8:
        flash("La contraseña de acceso al catálogo debe tener al menos 8 caracteres.", "error")
        return redirect(url_for("setup_page"))
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?)",
            (username, generate_password_hash(password), "admin", 1, now_iso())
        )
        admin_id = cur.lastrowid
    set_setting("site_password_hash", generate_password_hash(site_password))
    session["user_id"] = admin_id
    session["username"] = username
    session["role"] = "admin"
    session["site_access"] = True
    session.permanent = True
    return redirect(url_for("index_page"))

@app.route("/access", methods=["GET", "POST"])
def access_page():
    if not has_users():
        return redirect(url_for("setup_page"))
    if request.method == "POST":
        password = request.form.get("site_password") or ""
        stored_hash = get_setting("site_password_hash")
        if stored_hash and check_password_hash(stored_hash, password):
            session["site_access"] = True
            return redirect(url_for("index_page"))
        flash("Contraseña incorrecta.", "error")
    return render_template("access.html")

@app.get("/login")
def login_page():
    if not has_users():
        return redirect(url_for("setup_page"))
    return render_template("login.html")

@app.get("/")
@site_required
def index_page():
    return render_template("index.html", user=current_user())

@app.get("/admin")
@admin_required
def admin_page():
    return render_template("admin.html", user=current_user())

@app.get("/logout")
def logout():
    session.pop("user_id", None)
    session.pop("username", None)
    session.pop("role", None)
    return redirect(url_for("index_page") if session.get("site_access") else url_for("access_page"))

@app.get("/logout-site")
def logout_site():
    session.clear()
    return redirect(url_for("access_page"))

@app.get("/api/catalog")
@site_required
def api_catalog():
    rows = all_rows_with_calculations()
    groups = group_catalog(rows)
    user = current_user()
    include_prices = bool(user and user["role"] in {"staff", "admin"})
    farms = get_farms()
    options = get_options()
    return jsonify({
        "ok": True,
        "products": [serialize_public_group(g, include_prices) for g in groups],
        "farms": farms,
        "options": options,
        "user": user,
        "stats": {"rows": len(rows), "products": len(groups), "boxes": len(get_boxes()), "farms": len(farms)},
    })

@app.post("/api/login")
def api_login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    with db_conn() as conn:
        user = conn.execute("SELECT * FROM users WHERE username=? AND is_active=1", (username,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"ok": False, "error": "Usuario o contraseña incorrectos."}), 401
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"]
    session["site_access"] = True
    session.permanent = True
    return jsonify({"ok": True, "user": {"id": user["id"], "username": user["username"], "role": user["role"]}})

@app.post("/api/logout")
def api_logout():
    session.pop("user_id", None)
    session.pop("username", None)
    session.pop("role", None)
    return jsonify({"ok": True})

@app.get("/api/admin/data")
@admin_required
def api_admin_data():
    rows = all_rows_with_calculations()
    return jsonify({
        "ok": True,
        "products": rows,
        "boxes": list(get_boxes().values()),
        "farms": get_farms(),
        "options": get_options(),
        "settings": get_formula_settings(),
        "source_filename": get_setting("source_filename", "current_week.xlsx"),
        "stats": {"rows": len(rows), "products": len(group_catalog(rows)), "boxes": len(get_boxes()), "farms": len(get_farms())},
    })

def parse_admin_product(payload: dict):
    row = {col: payload.get(col) for col in CANONICAL_COLUMNS}
    for key in ("Finca", "Categoría", "Producto"):
        if not str(row.get(key) or "").strip():
            raise ValueError(f"El campo '{key}' es obligatorio.")
    for key in ("Total Tallos", "Compra", "Venta", "Compra UK", "Venta UK"):
        row[key] = as_float(row.get(key))
    for key in ("ID",):
        row[key] = as_float(row.get(key))
    return row

@app.post("/api/admin/products")
@admin_required
def api_admin_create_product():
    payload = request.get_json(silent=True) or {}
    try:
        row = parse_admin_product(payload)
        boxes = get_boxes()
        farms = get_farms()
        row = recalculate_row(row, boxes, farms, get_formula_settings())
        pid = product_id()
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO products(id,row_json,source,created_at,updated_at) VALUES(?,?,?,?,?)",
                (pid, json.dumps(row, ensure_ascii=False), "manual", now_iso(), now_iso())
            )
        return jsonify({"ok": True, "id": pid, "row": row})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

@app.put("/api/admin/products/<pid>")
@admin_required
def api_admin_update_product(pid):
    payload = request.get_json(silent=True) or {}
    try:
        row = parse_admin_product(payload)
        row = recalculate_row(row, get_boxes(), get_farms(), get_formula_settings())
        with db_conn() as conn:
            found = conn.execute("SELECT id FROM products WHERE id=?", (pid,)).fetchone()
            if not found:
                return jsonify({"ok": False, "error": "No se encontró el registro."}), 404
            conn.execute(
                "UPDATE products SET row_json=?,source='manual',updated_at=? WHERE id=?",
                (json.dumps(row, ensure_ascii=False), now_iso(), pid)
            )
        return jsonify({"ok": True, "id": pid, "row": row})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

@app.delete("/api/admin/products/<pid>")
@admin_required
def api_admin_delete_product(pid):
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM products WHERE id=?", (pid,))
        if cur.rowcount == 0:
            return jsonify({"ok": False, "error": "No se encontró el registro."}), 404
    return jsonify({"ok": True})

@app.put("/api/admin/boxes/<path:name>")
@admin_required
def api_admin_update_box(name):
    payload = request.get_json(silent=True) or {}
    boxes = get_boxes()
    box = lookup_box(boxes, name)
    if not box:
        return jsonify({"ok": False, "error": "No se encontró la caja."}), 404
    updated = dict(box)
    for key in ("Largo", "Ancho", "Alto"):
        val = as_float(payload.get(key))
        if val is None or val <= 0:
            return jsonify({"ok": False, "error": f"{key} debe ser un número mayor que cero."}), 400
        updated[key] = val
    length, width, height = (float(updated[k]) for k in ("Largo", "Ancho", "Alto"))
    updated["Peso"] = length * width * height / 6000
    updated["Largo2"] = round_up_2(length / 2.54)
    updated["Ancho2"] = round_up_2(width / 2.54)
    updated["Alto2"] = round_up_2(height / 2.54)
    boxes[box["Nombre"]] = updated
    # Aprobado is a comparison against the standard box weight; recalculate all boxes.
    for current_box in boxes.values():
        current_box["Aprobado"] = calculate_approved(current_box, boxes)
    with db_conn() as conn:
        for current_box in boxes.values():
            conn.execute(
                "UPDATE boxes SET box_json=? WHERE name=?",
                (json.dumps(current_box, ensure_ascii=False), current_box["Nombre"])
            )
    return jsonify({"ok": True, "box": updated})

@app.get("/api/admin/users")
@admin_required
def api_admin_users():
    with db_conn() as conn:
        rows = conn.execute("SELECT id,username,role,is_active,created_at FROM users ORDER BY id").fetchall()
    return jsonify({"ok": True, "users": [dict(r) for r in rows]})

@app.post("/api/admin/users")
@admin_required
def api_admin_create_user():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = payload.get("role") or "staff"
    if len(username) < 3 or len(password) < 10 or role not in {"admin", "staff"}:
        return jsonify({"ok": False, "error": "Usuario: mínimo 3 caracteres; contraseña: mínimo 10; rol no válido."}), 400
    try:
        with db_conn() as conn:
            cur = conn.execute(
                "INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?)",
                (username, generate_password_hash(password), role, 1, now_iso())
            )
        return jsonify({"ok": True, "id": cur.lastrowid})
    except sqlite3.IntegrityError:
        return jsonify({"ok": False, "error": "Ese nombre de usuario ya existe."}), 400

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
        new_password = payload.get("password")
        if role not in {"admin", "staff"}:
            return jsonify({"ok": False, "error": "Rol no válido."}), 400
        if new_password is not None and len(new_password) < 10:
            return jsonify({"ok": False, "error": "La contraseña debe tener al menos 10 caracteres."}), 400
        if target["role"] == "admin" and (role != "admin" or active == 0):
            admins = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").fetchone()["n"]
            if admins <= 1:
                return jsonify({"ok": False, "error": "No puedes desactivar o quitar el último administrador."}), 400
        if new_password:
            conn.execute(
                "UPDATE users SET role=?,is_active=?,password_hash=? WHERE id=?",
                (role, active, generate_password_hash(new_password), uid)
            )
        else:
            conn.execute("UPDATE users SET role=?,is_active=? WHERE id=?", (role, active, uid))
    return jsonify({"ok": True})

@app.delete("/api/admin/users/<int:uid>")
@admin_required
def api_admin_delete_user(uid):
    user = current_user()
    if user and user["id"] == uid:
        return jsonify({"ok": False, "error": "No puedes eliminar tu propia cuenta mientras estás conectado."}), 400
    with db_conn() as conn:
        target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return jsonify({"ok": False, "error": "Usuario no encontrado."}), 404
        if target["role"] == "admin":
            admins = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").fetchone()["n"]
            if admins <= 1:
                return jsonify({"ok": False, "error": "No puedes eliminar el último administrador."}), 400
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
    return jsonify({"ok": True})

@app.post("/api/admin/settings")
@admin_required
def api_admin_settings():
    payload = request.get_json(silent=True) or {}
    site_password = payload.get("site_password")
    if site_password:
        if len(site_password) < 8:
            return jsonify({"ok": False, "error": "La contraseña del catálogo debe tener al menos 8 caracteres."}), 400
        set_setting("site_password_hash", generate_password_hash(site_password))
    # Keep the workbook's formula defaults, but allow the administrator to tune the same parameters.
    for key in DEFAULT_FORMULA_SETTINGS:
        if key in payload:
            value = as_float(payload[key])
            must_be_positive = key in {"uk_exchange_rate", "us_sale_factor", "uk_sale_factor"}
            if value is None or value < 0 or (must_be_positive and value == 0):
                return jsonify({"ok": False, "error": f"Parámetro no válido: {key}."}), 400
            set_setting(key, value)
    return jsonify({"ok": True, "settings": get_formula_settings()})

@app.post("/api/admin/import")
@admin_required
def api_admin_import():
    uploaded = request.files.get("workbook")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "error": "Selecciona un archivo Excel .xlsx."}), 400
    filename = secure_filename(uploaded.filename)
    if not filename.lower().endswith(".xlsx"):
        return jsonify({"ok": False, "error": "Solo se aceptan archivos .xlsx."}), 400
    temp_path = DATA_DIR / f"upload_{uuid.uuid4().hex}.xlsx"
    uploaded.save(temp_path)
    try:
        data = load_workbook_data(temp_path)
        if WORKBOOK_PATH.exists():
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            shutil.copy2(WORKBOOK_PATH, BACKUP_DIR / f"catalogo_anterior_{stamp}.xlsx")
        shutil.copy2(temp_path, WORKBOOK_PATH)
        data["source_filename"] = filename
        import_data_into_db(data, preserve_manual=True)
        set_setting("source_filename", filename)
        return jsonify({
            "ok": True,
            "message": f"Excel importado correctamente: {len(data['products'])} filas de productos y {len(data['boxes'])} cajas.",
            "stats": {"rows": len(get_products_raw()), "boxes": len(get_boxes()), "farms": len(get_farms())},
        })
    except Exception as exc:
        return jsonify({"ok": False, "error": f"No se pudo importar el Excel: {exc}"}), 400
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass

def write_export_workbook():
    if not WORKBOOK_PATH.exists():
        raise FileNotFoundError("No hay un Excel de origen cargado.")
    wb = load_workbook(WORKBOOK_PATH, data_only=False)
    ws = find_sheet(wb, "Catalogo")
    if ws is None:
        raise ValueError("No se encontró la hoja Catalogo.")
    bounds, table = table_bounds(ws, "Catalogo")
    if not bounds:
        raise ValueError("No se encontró la tabla Catalogo.")
    min_col, header_row, max_col, old_last_row = bounds
    headers = [ws.cell(header_row, c).value for c in range(min_col, max_col + 1)]
    rows = all_rows_with_calculations()
    # Preserve the table's column order by matching the actual header names.
    data_start = header_row + 1
    for r in range(data_start, old_last_row + 1):
        for c in range(min_col, max_col + 1):
            ws.cell(r, c).value = None
    for offset, row in enumerate(rows):
        r = data_start + offset
        if r > old_last_row and data_start <= old_last_row:
            source_style_row = old_last_row
            for c in range(min_col, max_col + 1):
                src = ws.cell(source_style_row, c)
                dst = ws.cell(r, c)
                if src.has_style:
                    from copy import copy
                    dst._style = copy(src._style)
                    dst.number_format = src.number_format
        lookup = {norm(k): v for k, v in row.items() if not k.startswith("_")}
        for c, header in zip(range(min_col, max_col + 1), headers):
            if not header:
                continue
            value = lookup.get(norm(str(header)))
            if isinstance(value, str) and value in {"BAJO", "ALTO", "y", "n", "NO ENCONTRADO"}:
                ws.cell(r, c).value = value
            else:
                ws.cell(r, c).value = value
    new_last_row = data_start + len(rows) - 1
    table.ref = f"{ws.cell(header_row,min_col).coordinate}:{ws.cell(new_last_row,max_col).coordinate}"
    if getattr(table, "autoFilter", None):
        table.autoFilter.ref = table.ref

    # Also write any edited box dimensions back into Sheet1 -> Cajas.
    box_ws = find_sheet(wb, "Sheet1")
    if box_ws is not None:
        box_bounds, box_table = table_bounds(box_ws, "Cajas")
        if box_bounds:
            bmin_col, bheader_row, bmax_col, bold_last_row = box_bounds
            box_headers = [box_ws.cell(bheader_row, c).value for c in range(bmin_col, bmax_col + 1)]
            box_records = list(get_boxes().values())
            for rr in range(bheader_row + 1, bold_last_row + 1):
                for cc in range(bmin_col, bmax_col + 1):
                    box_ws.cell(rr, cc).value = None
            for offset, box_record in enumerate(box_records):
                rr = bheader_row + 1 + offset
                if rr > bold_last_row and bold_last_row > bheader_row:
                    from copy import copy
                    for cc in range(bmin_col, bmax_col + 1):
                        src = box_ws.cell(bold_last_row, cc)
                        dst = box_ws.cell(rr, cc)
                        if src.has_style:
                            dst._style = copy(src._style)
                box_lookup = {norm(k): v for k, v in box_record.items()}
                for cc, header in zip(range(bmin_col, bmax_col + 1), box_headers):
                    if header:
                        box_ws.cell(rr, cc).value = box_lookup.get(norm(str(header)))
            box_last = bheader_row + len(box_records)
            box_table.ref = f"{box_ws.cell(bheader_row,bmin_col).coordinate}:{box_ws.cell(box_last,bmax_col).coordinate}"
            if getattr(box_table, "autoFilter", None):
                box_table.autoFilter.ref = box_table.ref

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return output

@app.get("/admin/export.xlsx")
@admin_required
def admin_export():
    output = write_export_workbook()
    return send_file(
        output, as_attachment=True,
        download_name="BloomDesk_catalogo_actualizado.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

@app.get("/health")
def health():
    return jsonify({"ok": True, "app": "BloomDesk", "version": "0.01"})

if __name__ == "__main__":
    initialize_data()
    print("\nBloomDesk v0.01")
    print("Abre en tu navegador: http://127.0.0.1:5000")
    print("La aplicación funciona localmente en este equipo.")
    app.run(host="127.0.0.1", port=5000, debug=False)
