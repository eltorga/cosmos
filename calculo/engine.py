import json, re, zipfile
import xml.etree.ElementTree as ET

MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS = {'m': MAIN_NS, 'r': REL_NS}

BASE_US = {'SB','EB','QB','HB','EB2','QB2'}
BASE_UK = {'SB UK','EB UK','QB UK','HB UK','EB2 UK','QB2 UK'}

# Common naming aliases in the source workbook, only for cleaner visual grouping.
ALIASES = {
    'Ceres': 'Ceres Farms', 'Anthonela': 'Anthonela Farms', 'Coop': 'Coop Farms',
    'Betel': 'Betel Flowers', 'Tumbabiro': 'Tumbabirro', 'Optimum': 'Optimum Flowers',
    'Naranjo': 'Naranjo', 'Luxus': 'Luxus Blumen', 'Lulu': 'Lulu',
    'Flower Party': 'Flowers Party', 'Flowers Party': 'Flowers Party',
}

def _shared_strings(zf):
    path = 'xl/sharedStrings.xml'
    if path not in zf.namelist():
        return []
    root = ET.fromstring(zf.read(path))
    out = []
    for si in root.findall(f'{{{MAIN_NS}}}si'):
        parts = [t.text or '' for t in si.iter(f'{{{MAIN_NS}}}t')]
        out.append(''.join(parts))
    return out

def _sheet_paths(zf):
    wb = ET.fromstring(zf.read('xl/workbook.xml'))
    rels = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
    rel_map = {r.attrib['Id']: r.attrib['Target'] for r in rels.findall(f'{{{PKG_REL_NS}}}Relationship')}
    result = {}
    for s in wb.find('m:sheets', NS):
        rid = s.attrib[f'{{{REL_NS}}}id']
        target = rel_map[rid]
        if target.startswith('/'):
            full = target.lstrip('/')
        elif target.startswith('xl/'):
            full = target
        else:
            full = 'xl/' + target
        result[s.attrib['name']] = full
    return result

def _read_cells(zf, sheet_path, shared):
    root = ET.fromstring(zf.read(sheet_path))
    cells = {}
    for c in root.findall('.//m:c', NS):
        addr = c.attrib.get('r')
        if not addr:
            continue
        t = c.attrib.get('t')
        v = c.find('m:v', NS)
        inline = c.find('m:is', NS)
        formula = c.find('m:f', NS)
        value = None
        if t == 'inlineStr' and inline is not None:
            value = ''.join((x.text or '') for x in inline.iter(f'{{{MAIN_NS}}}t'))
        elif v is not None:
            raw = v.text or ''
            if t == 's':
                try: value = shared[int(raw)]
                except Exception: value = raw
            elif t == 'b':
                value = raw == '1'
            elif t in ('str','e'):
                value = raw
            else:
                try:
                    n = float(raw)
                    value = int(n) if n.is_integer() else n
                except Exception:
                    value = raw
        cells[addr] = {'value': value, 'formula': formula.text if formula is not None else None}
    return cells

def _kind(name):
    up = (name or '').upper()
    if 'QB2' in up: return 'QB2'
    if 'EB2' in up: return 'EB2'
    if 'QB' in up: return 'QB'
    if 'EB' in up: return 'EB'
    if 'HB' in up: return 'HB'
    if 'SB' in up: return 'SB'
    return ''

def _group(name, finca_names):
    if name in BASE_US or name in BASE_UK:
        return ''
    s = (name or '').strip()
    # Prefer a real finca name when it is clearly a prefix.
    matches = [f for f in finca_names if s.lower().startswith(f.lower())]
    if matches:
        return max(matches, key=len)
    # Alias by a leading keyword.
    for prefix, pretty in ALIASES.items():
        if s.lower().startswith(prefix.lower()):
            return pretty
    # Fallback: everything before the first box code.
    m = re.search(r'\b(?:QB2|EB2|QB|EB|HB|SB)', s, re.I)
    if m:
        group = s[:m.start()].strip(' -_/')
        return group or 'Otras'
    return 'Otras'

def load_excel(path):
    with zipfile.ZipFile(path) as zf:
        shared = _shared_strings(zf)
        paths = _sheet_paths(zf)
        sheet1 = _read_cells(zf, paths['Sheet1'], shared)
        guias = _read_cells(zf, paths['Guias'], shared)
        fincas = _read_cells(zf, paths['Fincas'], shared) if 'Fincas' in paths else {}

        finca_names = []
        for row in range(2, 2000):
            v = fincas.get(f'B{row}', {}).get('value')
            if v in (None, ''): continue
            finca_names.append(str(v).strip())

        week = guias.get('M2', {}).get('value')
        u2 = sheet1.get('U2', {}).get('value')
        try: u2 = float(u2)
        except Exception: u2 = 2.0

        boxes = []
        empty_run = 0
        for row in range(2, 5000):
            name = sheet1.get(f'B{row}', {}).get('value')
            if name in (None, ''):
                empty_run += 1
                if empty_run > 20 and boxes:
                    break
                continue
            empty_run = 0
            name = str(name).strip()
            def num(col):
                v = sheet1.get(f'{col}{row}', {}).get('value')
                try: return float(v) if v not in (None,'') else None
                except Exception: return None
            approved = sheet1.get(f'G{row}', {}).get('value')
            approved = str(approved).strip().lower() if approved not in (None,'') else ''
            boxes.append({
                'id': f'b{row}', 'sheetRow': row, 'name': name,
                'largo': num('C'), 'ancho': num('D'), 'alto': num('E'), 'peso': num('F'),
                'approved': approved, 'group': _group(name, finca_names), 'kind': _kind(name)
            })

        return json.dumps({
            'week': week,
            'u2': u2,
            'boxes': boxes,
            'source': 'US_WEEK_ACTIVE.xlsx'
        }, ensure_ascii=False)
