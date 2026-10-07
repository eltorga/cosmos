from pathlib import Path
from io import BytesIO
from datetime import datetime, timedelta
import json, zipfile, re, html, math, unicodedata
import xml.etree.ElementTree as ET

TEMPLATE = Path('/template.xlsx')
MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS = {'m': MAIN_NS}

BASE_CODES = ('SB','EB','QB','HB','EB2','QB2')
BASE_NO_EXTRA = {
    'SB','EB','QB','HB','EB2','QB2',
    'SB UK','EB UK','QB UK','HB UK','EB2 UK','QB2 UK'
}
ARRIVAL_SUFFIXES = ('(M/T)','(T/W)','(W/T)','(T/F)','(F)')


def _shared_strings(z):
    out=[]
    try:
        root=ET.fromstring(z.read('xl/sharedStrings.xml'))
    except KeyError:
        return out
    for si in root.findall('{%s}si' % MAIN_NS):
        out.append(''.join((t.text or '') for t in si.iter('{%s}t' % MAIN_NS)))
    return out


def _sheet_rows(z, path, shared):
    root=ET.fromstring(z.read(path))
    rows=[]
    for row in root.findall('.//{%s}row' % MAIN_NS):
        vals={}
        for c in row.findall('{%s}c' % MAIN_NS):
            ref=c.get('r','')
            col=re.match(r'[A-Z]+',ref)
            if not col: continue
            col=col.group(0)
            v=c.find('{%s}v' % MAIN_NS)
            val=None if v is None else v.text
            if val is not None and c.get('t')=='s':
                try: val=shared[int(val)]
                except Exception: pass
            elif c.get('t')=='inlineStr':
                t=c.find('.//{%s}t' % MAIN_NS)
                val='' if t is None else (t.text or '')
            vals[col]=val
        rows.append((int(row.get('r','0')), vals))
    return rows


def _code_for_name(name):
    u=str(name or '').upper()
    # Same precedence as the source workbook Aprobado formula.
    for code in ('QB2','EB2','QB','EB','HB','SB'):
        if code in u:
            return code
    return ''


def _norm(s):
    s=unicodedata.normalize('NFKD',str(s or ''))
    s=''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    return re.sub(r'[^a-z0-9]+',' ',s).strip()


def _box_weight(box, extra):
    name=str(box.get('name','')).strip()
    l=float(box.get('largo') or 0); a=float(box.get('ancho') or 0); h=float(box.get('alto') or 0)
    if name in BASE_NO_EXTRA:
        return (l*a*h)/6000
    e=float(extra or 0)
    return ((l+e)*(a+e)*(h+e))/6000


def _box_approved(box, base_by_code, extra):
    code=_code_for_name(box.get('name'))
    if not code or code not in base_by_code:
        return ''
    return 'y' if _box_weight(box,extra) <= _box_weight(base_by_code[code],extra) + 1e-12 else 'n'


def load_config():
    with zipfile.ZipFile(TEMPLATE) as z:
        ss=_shared_strings(z)

        # Sheet1 / Cajas: B=Nombre, C=Largo, D=Ancho, E=Alto, F=Peso, G=Aprobado, U2=Seguro/extra.
        boxes=[]; box_extra=2.0
        for r,vals in _sheet_rows(z,'xl/worksheets/sheet2.xml',ss):
            if r==2 and vals.get('U') not in (None,''):
                try: box_extra=float(vals.get('U'))
                except Exception: pass
            if r<=1: continue
            name=vals.get('B')
            if not name: continue
            try:
                boxes.append({
                    'row':r,'name':str(name),'largo':float(vals.get('C') or 0),
                    'ancho':float(vals.get('D') or 0),'alto':float(vals.get('E') or 0),
                    'pesoStored':float(vals.get('F') or 0) if vals.get('F') not in (None,'') else None,
                    'aprobadoStored':str(vals.get('G') or ''), 'code':_code_for_name(name)
                })
            except Exception:
                pass

        # Guias: A Día, B Fecha, C Vuelos, D Entrega, E Ecuador, F Colombia, G Llegada; M2 Semana.
        guias=[]; guide_week=None
        rows3=_sheet_rows(z,'xl/worksheets/sheet3.xml',ss)
        for r,vals in rows3:
            if r==2 and vals.get('M') not in (None,''):
                try: guide_week=int(float(vals.get('M')))
                except Exception: guide_week=vals.get('M')
            if r<=1 or not vals.get('B'): continue
            try: serial=float(vals.get('B'))
            except Exception: continue
            guias.append({
                'row':r,'dia':vals.get('A') or '','fecha':serial,'vuelos':vals.get('C') or '',
                'entrega':vals.get('D') or '','ecuador':vals.get('E') or '',
                'colombia':vals.get('F') or '','llegada':vals.get('G') or ''
            })

        # Vendedores table is in Guias!I:K.
        sellers=[]
        for r,vals in rows3:
            if r<=1: continue
            frag=vals.get('J')
            if not frag: continue
            sellers.append({'name':vals.get('I') or '', 'fragment':str(frag).strip(), 'id':vals.get('K') or ''})

        # Fincas: B Nombre, C ID.
        farms=[]
        for r,vals in _sheet_rows(z,'xl/worksheets/sheet4.xml',ss):
            if r<=1: continue
            name=vals.get('B')
            if not name: continue
            farms.append({'name':str(name),'id':vals.get('C') or ''})
        farms.sort(key=lambda x:x['name'].lower())

        # Associate each specific Cajas row with its finca when possible.
        # The source file has a handful of shortened / legacy box prefixes
        # (e.g. "Anthonela" vs "Anthonela Farms"), so keep those aliases here
        # instead of hiding those boxes from the web selector.
        norm_farms=sorted(((_norm(f['name']),f['name']) for f in farms if _norm(f['name'])), key=lambda x:len(x[0]), reverse=True)
        farm_by_norm={_norm(f['name']):f['name'] for f in farms}
        box_prefix_aliases={
            'anthonela':'anthonela farms',
            'betel':'betel flowers',
            'ceres':'ceres farms',
            'coop':'coop farms',
            'flower party':'flowers party',
            'luxus':'luxus blumen',
            'nranajo':'naranjo',
            'optimum':'optimum flowers',
            'tumbabiro':'tumbabirro',
        }

        def fallback_group(name):
            raw=str(name or '').strip()
            up=raw.upper()
            if raw in BASE_CODES:
                return 'Cajas base'
            if up.endswith(' UK') and _code_for_name(raw):
                return 'Cajas UK'
            # Prefer a meaningful prefix before the box code.
            m=re.search(r'\b(?:QB2|EB2|QB|EB|HB|SB)\b', raw, flags=re.I)
            prefix=(raw[:m.start()] if m else raw).strip(' -_/')
            if not prefix:
                return 'Otros'
            # A few families intentionally share several descriptive box names.
            low=_norm(prefix)
            if low.startswith('lulu'): return 'Lulu'
            if low.startswith('proteas sol andino'): return 'Proteas Sol Andino'
            if low=='ec': return 'EC'
            return prefix

        for b in boxes:
            nb=_norm(b['name']); owner=''
            raw=b['name'].strip()
            if raw not in BASE_CODES:
                # 1) Exact/longest finca prefix.
                for nf, fname in norm_farms:
                    if nb==nf or nb.startswith(nf+' '):
                        owner=fname; break
                # 2) Known shortened / legacy prefixes.
                if not owner:
                    for prefix, target_norm in box_prefix_aliases.items():
                        if nb==prefix or nb.startswith(prefix+' '):
                            owner=farm_by_norm.get(target_norm,'')
                            if owner: break
            b['farm']=owner
            b['group']=owner.strip() if owner else fallback_group(raw)

        # Read Import Duties from the template itself, so the web follows the workbook.
        import_duty=.1586
        for r,vals in _sheet_rows(z,'xl/worksheets/sheet1.xml',ss):
            if r==2 and vals.get('X') not in (None,''):
                try: import_duty=float(vals.get('X'))
                except Exception: pass
                break

        first_date=guias[0]['fecha'] if guias else None
        last_date=guias[-1]['fecha'] if guias else None
        return {
            'farms':farms,'boxes':boxes,'guias':guias,'sellers':sellers,
            'guideWeek':guide_week,'firstDate':first_date,'lastDate':last_date,
            'importDuty':import_duty,'boxExtra':box_extra,'baseCodes':list(BASE_CODES),
            'baseNoExtra':sorted(BASE_NO_EXTRA)
        }


def xml_escape(s):
    return html.escape(str(s), quote=False)


def _num_text(value):
    if isinstance(value, bool): return '1' if value else '0'
    if isinstance(value, int): return str(value)
    if isinstance(value, float):
        if not math.isfinite(value): return ''
        return format(value, '.15g')
    return str(value)


def cell_text(col,row,value,style=None):
    attrs=f' r="{col}{row}"'
    if style: attrs+=f' s="{style}"'
    return f'<c{attrs} t="inlineStr"><is><t>{xml_escape(value or "")}</t></is></c>'


def cell_num(col,row,value,style=None):
    attrs=f' r="{col}{row}"'
    if style: attrs+=f' s="{style}"'
    if value in (None,''): return f'<c{attrs}/>'
    return f'<c{attrs}><v>{xml_escape(_num_text(value))}</v></c>'


def cell_formula(col,row,formula,style=None,cached=None,result_type=None,array=False):
    """Write formula + cached result, so formula-blind importers still see current values."""
    attrs=f' r="{col}{row}"'
    if style: attrs+=f' s="{style}"'
    if result_type == 'str': attrs+=' t="str"'
    if array: attrs+=' cm="1"'
    fattrs=''
    if array:
        fattrs=f' t="array" ref="{col}{row}"'
        if col=='L': fattrs+=' aca="1" ca="1"'
    v='<v/>' if cached is None else f'<v>{xml_escape(_num_text(cached))}</v>'
    return f'<c{attrs}><f{fattrs}>{xml_escape(formula)}</f>{v}</c>'


def _source_row_meta(sheet_xml):
    root=ET.fromstring(sheet_xml)
    row=root.find('.//{%s}row[@r="2"]' % MAIN_NS)
    styles={}; formulas={}
    if row is None: return styles,formulas
    for c in row.findall('{%s}c' % MAIN_NS):
        col=re.match(r'[A-Z]+',c.get('r',''))
        if not col: continue
        col=col.group(0)
        styles[col]=c.get('s')
        f=c.find('{%s}f' % MAIN_NS)
        if f is not None: formulas[col]=f.text or ''
    return styles, formulas


def _replace_sheet_data(sheet_xml, new_rows_xml, end_row):
    s=sheet_xml.decode('utf-8')
    header=re.search(r'<row r="1".*?</row>',s,re.S)
    if not header: raise RuntimeError('No se encontró el encabezado de la hoja test.')
    body='<sheetData>'+header.group(0)+''.join(new_rows_xml)+'</sheetData>'
    s=re.sub(r'<sheetData>.*?</sheetData>',body,s,count=1,flags=re.S)
    s=re.sub(r'<dimension ref="[^"]+"/>',f'<dimension ref="A1:AD{end_row}"/>',s,count=1)

    dv=(f'<dataValidations count="3">'
        f'<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="A2:A{end_row}"><formula1>INDIRECT("Fincas[Nombre]")</formula1></dataValidation>'
        f'<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="C2:C{end_row}"><formula1>INDIRECT("Cajas[Nombre]")</formula1></dataValidation>'
        f'<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="M2:M{end_row}"><formula1>INDIRECT("Guias[Fecha]")</formula1></dataValidation>'
        f'</dataValidations>')
    if re.search(r'<dataValidations[^>]*>.*?</dataValidations>',s,re.S):
        s=re.sub(r'<dataValidations[^>]*>.*?</dataValidations>',dv,s,count=1,flags=re.S)
    else:
        s=s.replace('<tableParts',dv+'<tableParts',1)
    return s.encode('utf-8')


def _update_table(table_xml, end_row, formulas):
    root=ET.fromstring(table_xml)
    root.set('ref',f'A1:AD{end_row}')
    af=root.find('{%s}autoFilter' % MAIN_NS)
    if af is not None: af.set('ref',f'A1:AD{end_row}')
    formula_by_name={
        'Markup':formulas.get('J',''), 'Guia':formulas.get('L',''), 'Duties':formulas.get('N',''),
        'Transport':formulas.get('R',''), 'Largo2':formulas.get('S',''), 'Ancho':formulas.get('T',''),
        'Alto':formulas.get('U',''), 'Volumen':formulas.get('V',''), 'Transport2':formulas.get('W',''),
        'Total':formulas.get('Y',''), 'FincaID':formulas.get('Z',''), 'Inventarios':formulas.get('AA','')
    }
    for tc in root.findall('.//{%s}tableColumn' % MAIN_NS):
        name=tc.get('name')
        old=tc.find('{%s}calculatedColumnFormula' % MAIN_NS)
        if name == 'Nombre':
            if old is not None: tc.remove(old)
            continue
        if name in formula_by_name and formula_by_name[name]:
            if old is None: old=ET.SubElement(tc,'{%s}calculatedColumnFormula' % MAIN_NS)
            old.text=formula_by_name[name]
    ET.register_namespace('',MAIN_NS)
    ET.register_namespace('mc','http://schemas.openxmlformats.org/markup-compatibility/2006')
    ET.register_namespace('xr','http://schemas.microsoft.com/office/spreadsheetml/2014/revision')
    ET.register_namespace('xr3','http://schemas.microsoft.com/office/spreadsheetml/2016/revision3')
    return ET.tostring(root,encoding='utf-8',xml_declaration=True)


def _peso_formula():
    checks=', '.join(f'Cajas[[#This Row],[Nombre]]="{n}"' for n in ('QB','EB','HB','QB2','EB2','SB','QB UK','EB UK','HB UK','QB2 UK','EB2 UK','SB UK'))
    return (
        f'IF(OR({checks}), '
        '(Cajas[[#This Row],[Largo]]*Cajas[[#This Row],[Ancho]]*Cajas[[#This Row],[Alto]])/6000, '
        '((Cajas[[#This Row],[Largo]]+$U$2)*(Cajas[[#This Row],[Ancho]]+$U$2)*(Cajas[[#This Row],[Alto]]+$U$2))/6000)'
    )


def _replace_cell_value(s, ref, value):
    pattern=rf'(<c\b[^>]*\br="{re.escape(ref)}"[^>]*>)(.*?)(</c>)'
    m=re.search(pattern,s,re.S)
    if not m: return s
    inner=m.group(2)
    v=f'<v>{xml_escape(_num_text(value))}</v>'
    if re.search(r'<v>.*?</v>|<v\s*/>',inner,re.S):
        inner=re.sub(r'<v>.*?</v>|<v\s*/>',v,inner,count=1,flags=re.S)
    else:
        inner+=v
    return s[:m.start()]+m.group(1)+inner+m.group(3)+s[m.end():]


def _replace_cell_formula(s, ref, formula):
    pattern=rf'(<c\b[^>]*\br="{re.escape(ref)}"[^>]*>)(.*?)(</c>)'
    m=re.search(pattern,s,re.S)
    if not m: return s
    inner=m.group(2)
    f=f'<f>{xml_escape(formula)}</f>'
    if re.search(r'<f(?:\s[^>]*)?>.*?</f>',inner,re.S):
        inner=re.sub(r'<f(?:\s[^>]*)?>.*?</f>',f,inner,count=1,flags=re.S)
    else:
        inner=f+inner
    return s[:m.start()]+m.group(1)+inner+m.group(3)+s[m.end():]


def _patch_cajas_sheet(sheet_xml, cfg, extra):
    s=sheet_xml.decode('utf-8')
    s=_replace_cell_value(s,'U2',extra)
    base_by_code={b['name'].strip():b for b in cfg['boxes'] if b['name'].strip() in BASE_CODES}
    formula=_peso_formula()
    for b in cfg['boxes']:
        r=b['row']
        weight=_box_weight(b,extra)
        approved=_box_approved(b,base_by_code,extra)
        s=_replace_cell_formula(s,f'F{r}',formula)
        s=_replace_cell_value(s,f'F{r}',weight)
        if approved:
            s=_replace_cell_value(s,f'G{r}',approved)
    return s.encode('utf-8')


def _patch_cajas_table(table_xml):
    root=ET.fromstring(table_xml)
    for tc in root.findall('.//{%s}tableColumn' % MAIN_NS):
        if tc.get('name')=='Peso':
            f=tc.find('{%s}calculatedColumnFormula' % MAIN_NS)
            if f is None: f=ET.SubElement(tc,'{%s}calculatedColumnFormula' % MAIN_NS)
            f.text=_peso_formula()
            break
    ET.register_namespace('',MAIN_NS)
    return ET.tostring(root,encoding='utf-8',xml_declaration=True)


def _roundup(n, digits=2):
    factor=10**digits
    n=float(n)
    if n >= 0: return math.ceil(n*factor-1e-12)/factor
    return math.floor(n*factor+1e-12)/factor


def _excel_date(serial):
    return datetime(1899,12,30) + timedelta(days=float(serial))


def _arrival_for_date(fecha, cfg):
    try: f=float(fecha)
    except Exception: return ''
    hit=next((g for g in cfg['guias'] if abs(float(g['fecha'])-f)<1e-9),None)
    return str((hit or {}).get('llegada') or '').strip()


def _strip_arrival(name):
    s=str(name or '').strip()
    pattern=r'\s*(?:'+'|'.join(re.escape(x) for x in ARRIVAL_SUFFIXES)+r')\s*$'
    return re.sub(pattern,'',s,flags=re.I).strip()


def _full_name(data,cfg):
    base=_strip_arrival(data.get('nombre',''))
    arr=_arrival_for_date(data.get('fecha'),cfg)
    return (base + (' '+arr if arr else '')).strip()


def _guide_value(data, cfg):
    fecha=float(data.get('fecha'))
    box=str(data.get('box','')).strip()
    finca=str(data.get('finca','')).strip()
    nombre=_full_name(data,cfg)
    if not fecha or not box: return ''

    dt=_excel_date(fecha)
    wd=dt.weekday()+1
    ec=box in {'QB','EB','HB','SB'}
    co=box in {'QB2','EB2'}
    es_tf='T/F' in nombre.upper()
    col_f=finca in {'Plazoleta','Flowers Party','HydranFlowers','Alexandra Farms','Circasia S.A.S.','Vuelven S.A.S.','Cultivos del Norte','La Conchita'}

    dia=''
    if wd==1 and ec: dia='Lunes'
    elif wd==1 and co: dia='Lunes'
    elif wd==2 and ec: dia='Martes'
    elif wd==2 and co: dia='Lunes'
    elif wd==3: dia='Miercoles'
    elif wd==4 and ec: dia='Jueves'
    elif wd==4 and co: dia='Miercoles'
    elif wd==5 and ec: dia='Viernes'
    elif wd==5 and co: dia='Jueves'
    elif wd==6 and ec and es_tf: dia='Lunes'
    elif wd==6 and ec: dia='Viernes'
    elif wd==6 and co: dia='Viernes'

    week=cfg.get('guideWeek')
    if week not in (None,''):
        try:
            if (_excel_date(fecha-2).isocalendar().week) != int(week): return 'ERROR S'
        except Exception: pass

    if not any(abs(float(g['fecha'])-fecha)<1e-9 for g in cfg['guias']): return 'ERROR F'
    if bool(col_f) != bool(co): return 'ERROR P'
    if not dia: return ''

    hit=next((g for g in cfg['guias'] if g['dia']==dia),None)
    if not hit: return ''
    if hit.get('vuelos')=='***Error de Fecha***': return 'ERROR V'
    if wd==3: return hit.get('ecuador','')
    return hit.get('colombia','') if co else hit.get('ecuador','')


def _standing_text(data):
    so=data.get('standingOrders',[])
    if isinstance(so,str): return so.strip()
    parts=[]
    for x in so or []:
        try: q=int(float(x.get('qty',0)))
        except Exception: q=0
        frag=str(x.get('fragment','')).strip()
        if q>0 and frag: parts.append(f'{q} {frag}')
    return ';'.join(parts)


def _inventory_value(data,cfg):
    text=_standing_text(data)
    if not text: return ''
    sellers={str(s['fragment']).strip().lower():str(s.get('id') or '').strip() for s in cfg.get('sellers',[])}
    week=cfg.get('guideWeek')
    try: odd=int(float(week))%2==1
    except Exception: odd=True
    result=[]
    for raw in text.replace('\xa0',' ').split(';'):
        s=raw.strip()
        if not s: continue
        su=s.upper()
        if '(*IMPAR)' in su and not odd: continue
        if '(*PAR)' in su and odd: continue
        m=re.match(r'\s*(\d+(?:\.\d+)?)\s+(.+)',s)
        if not m: continue
        q=int(float(m.group(1)))
        rawname=m.group(2).strip()
        name=rawname.split('[',1)[0].split('(',1)[0].strip()
        seller_id=sellers.get(name.lower(),'')
        if seller_id and q>0: result.extend([seller_id]*q)
    return (','.join(result)+',') if result else ''


def _computed_values(data, cfg, extra):
    box_name=str(data.get('box','')).strip()
    finca=str(data.get('finca','')).strip()
    qty=float(data.get('qty'))
    cant=float(data.get('cantidadMin'))
    cost=float(data.get('cost'))
    precio=float(data.get('precio'))

    b=next((x for x in cfg['boxes'] if x['name'].strip()==box_name),None)
    largo=float(b['largo']) if b else 0.0
    ancho=float(b['ancho']) if b else 0.0
    alto=float(b['alto']) if b else 0.0
    if b:
        volumen=_box_weight(b,extra)
    else:
        volumen=0.0

    # Exact source row formula used by test: ROUNDUP((Volumen*5.25)*1.36,2)
    transport2=_roundup(volumen*5.25*1.36,2) if b else 0.0
    transport=_roundup(transport2/cant,2) if cant else 0.0
    duties=_roundup(cost*float(cfg.get('importDuty') or .1586),2)

    if precio == 0:
        markup='BAJO'
    else:
        m=1-((cost+duties+transport)/(precio*.96))
        markup='BAJO' if m < 0 else ('ALTO' if m > 1 else m)

    farm=next((x for x in cfg['farms'] if x['name']==finca),None)
    finca_id=(farm or {}).get('id','')
    try:
        fid=float(finca_id)
        finca_id=int(fid) if fid.is_integer() else fid
    except Exception: pass

    return {
        'markup':markup,'guia':_guide_value(data,cfg),'duties':duties,'transport':transport,
        'largo':largo,'ancho':ancho,'alto':alto,'volumen':volumen,'transport2':transport2,
        'total':cant*precio*qty,'fincaId':finca_id,'inventarios':_inventory_value(data,cfg),
    }


def _as_bool_y_n(value, default=True):
    if value is None: return default
    if isinstance(value,bool): return value
    if isinstance(value,(int,float)): return bool(value)
    return str(value).strip().upper() not in {'N','NO','FALSE','0','OFF',''}


def build_xlsx(rows, box_extra=None):
    if not isinstance(rows,list) or not rows: raise ValueError('Agrega al menos una fila antes de exportar.')
    cfg=load_config()
    try: extra=float(cfg['boxExtra'] if box_extra is None else box_extra)
    except Exception: raise ValueError('El valor U2 / Seguro debe ser numérico.')
    if not math.isfinite(extra) or extra < 0: raise ValueError('El valor U2 / Seguro debe ser 0 o mayor.')

    with zipfile.ZipFile(TEMPLATE,'r') as zin:
        source_sheet=zin.read('xl/worksheets/sheet1.xml')
        styles, formulas=_source_row_meta(source_sheet)
        new_rows=[]
        for idx,data in enumerate(rows,start=2):
            finca=str(data.get('finca','')).strip()
            box=str(data.get('box','')).strip()
            variedad=str(data.get('variedad','')).strip()
            nombre_base=_strip_arrival(data.get('nombre',''))
            nombre=_full_name(data,cfg)
            required={
                'Finca':finca,'Qty':data.get('qty',''),'Type of Box':box,
                'Cantidad_Min':data.get('cantidadMin',''),'Variedad':variedad,
                'Nombre':nombre_base,'Cost':data.get('cost',''),'Markup':data.get('markup',''),
                'Precio':data.get('precio',''),'Fecha Entrega':data.get('fecha','')
            }
            missing=[k for k,v in required.items() if str(v).strip()=='']
            if missing: raise ValueError(f'Fila {idx-1}: falta ' + ', '.join(missing))
            try:
                markup_input=float(data.get('markup'))
                if markup_input < 0 or markup_input >= 100:
                    raise ValueError(f'Fila {idx-1}: Markup debe estar entre 0% y 99.99%.')
                qty=float(data.get('qty')); cant=float(data.get('cantidadMin'))
                cost=float(data.get('cost')); precio=float(data.get('precio')); fecha=float(data.get('fecha'))
            except ValueError as e:
                if str(e).startswith('Fila '): raise
                raise ValueError(f'Fila {idx-1}: Qty, Cantidad_Min, Cost, Markup, Precio y Fecha Entrega deben ser valores válidos.')

            standing_text=_standing_text(data)
            so_total=0
            if isinstance(data.get('standingOrders'),list):
                for x in data.get('standingOrders') or []:
                    try: so_total+=int(float(x.get('qty',0)))
                    except Exception: pass
            if so_total > qty + 1e-9:
                raise ValueError(f'Fila {idx-1}: Standing Orders ({so_total}) no puede superar Qty ({qty:g}).')

            computed=_computed_values(data,cfg,extra)
            send_email='Y' if _as_bool_y_n(data.get('sendEmail'),True) else 'N'
            markup_cached=computed['markup']
            markup_type='str' if isinstance(markup_cached,str) else None

            cells=[]
            cells.append(cell_text('A',idx,finca,styles.get('A')))
            cells.append(cell_num('B',idx,qty,styles.get('B')))
            cells.append(cell_text('C',idx,box,styles.get('C')))
            cells.append(cell_num('D',idx,cant,styles.get('D')))
            cells.append(cell_num('E',idx,cant,styles.get('E')))
            cells.append(cell_text('F',idx,variedad,styles.get('F')))
            cells.append(cell_text('G',idx,nombre,styles.get('G')))
            cells.append(cell_text('H',idx,'',styles.get('H')))
            cells.append(cell_num('I',idx,cost,styles.get('I')))
            cells.append(cell_formula('J',idx,formulas['J'],styles.get('J'),markup_cached,markup_type))
            cells.append(cell_num('K',idx,precio,styles.get('K')))
            cells.append(cell_formula('L',idx,formulas['L'],styles.get('L'),computed['guia'],'str',array=True))
            cells.append(cell_num('M',idx,fecha,styles.get('M')))
            cells.append(cell_formula('N',idx,formulas['N'],styles.get('N'),computed['duties']))
            cells.append(cell_num('O',idx,0,styles.get('O')))
            cells.append(cell_num('P',idx,1,styles.get('P')))
            cells.append(cell_num('Q',idx,0,styles.get('Q')))
            cells.append(cell_formula('R',idx,formulas['R'],styles.get('R'),computed['transport']))
            cells.append(cell_formula('S',idx,formulas['S'],styles.get('S'),computed['largo']))
            cells.append(cell_formula('T',idx,formulas['T'],styles.get('T'),computed['ancho']))
            cells.append(cell_formula('U',idx,formulas['U'],styles.get('U'),computed['alto']))
            cells.append(cell_formula('V',idx,formulas['V'],styles.get('V'),computed['volumen']))
            cells.append(cell_formula('W',idx,formulas['W'],styles.get('W'),computed['transport2']))
            cells.append(cell_num('X',idx,float(cfg.get('importDuty') or .1586),styles.get('X')))
            cells.append(cell_formula('Y',idx,formulas['Y'],styles.get('Y'),computed['total']))
            cells.append(cell_formula('Z',idx,formulas['Z'],styles.get('Z'),computed['fincaId']))
            cells.append(cell_formula('AA',idx,formulas.get('AA',''),styles.get('AA'),computed['inventarios'],'str',array=True))
            cells.append(cell_text('AB',idx,send_email,styles.get('AB')))
            cells.append(cell_text('AC',idx,'',styles.get('AC')))
            cells.append(cell_text('AD',idx,standing_text,styles.get('AD')))
            new_rows.append(f'<row r="{idx}" spans="1:30">'+''.join(cells)+'</row>')

        end_row=len(rows)+1
        patched_sheet=_replace_sheet_data(source_sheet,new_rows,end_row)
        patched_table=_update_table(zin.read('xl/tables/table1.xml'),end_row,formulas)
        patched_cajas_sheet=_patch_cajas_sheet(zin.read('xl/worksheets/sheet2.xml'),cfg,extra)
        patched_cajas_table=_patch_cajas_table(zin.read('xl/tables/table2.xml'))

        wbxml=zin.read('xl/workbook.xml').decode('utf-8')
        if '<calcPr ' in wbxml:
            wbxml=re.sub(
                r'<calcPr ([^>]*)/>',
                lambda m:'<calcPr '+re.sub(r'\s(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"','',m.group(1))+' calcMode="auto" fullCalcOnLoad="0" forceFullCalc="0"/>',
                wbxml,count=1
            )
        else:
            wbxml=wbxml.replace('</workbook>', '<calcPr calcMode="auto" fullCalcOnLoad="0" forceFullCalc="0"/></workbook>')

        rels=zin.read('xl/_rels/workbook.xml.rels').decode('utf-8')
        rels=re.sub(r'<Relationship[^>]+Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain"[^>]*/>','',rels)
        ctype=zin.read('[Content_Types].xml').decode('utf-8')
        ctype=re.sub(r'<Override PartName="/xl/calcChain.xml"[^>]*/>','',ctype)

        out=BytesIO()
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                if info.filename=='xl/calcChain.xml': continue
                if info.filename=='xl/worksheets/sheet1.xml': data=patched_sheet
                elif info.filename=='xl/worksheets/sheet2.xml': data=patched_cajas_sheet
                elif info.filename=='xl/tables/table1.xml': data=patched_table
                elif info.filename=='xl/tables/table2.xml': data=patched_cajas_table
                elif info.filename=='xl/workbook.xml': data=wbxml.encode('utf-8')
                elif info.filename=='xl/_rels/workbook.xml.rels': data=rels.encode('utf-8')
                elif info.filename=='[Content_Types].xml': data=ctype.encode('utf-8')
                else: data=zin.read(info.filename)
                zout.writestr(info,data)
        return out.getvalue()



def load_config_json():
    return json.dumps(load_config(), ensure_ascii=False)

def build_xlsx_to_file(rows_json, box_extra=None, output_path='/output.xlsx'):
    rows = json.loads(rows_json) if isinstance(rows_json, str) else rows_json
    data = build_xlsx(rows, box_extra)
    Path(output_path).write_bytes(data)
    return len(data)
