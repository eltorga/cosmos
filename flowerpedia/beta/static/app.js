const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
let catalog = [];
let farms = [];
let options = {};
let currentUser = null;
let selectedFilters = { category: [], farm: [], color: [] };
let filteredCatalog = [];
let visibleCount = 64;
let activeGroup = null;
let activeMarket = 'US';
let mixSelected = [];

const $ = (id) => document.getElementById(id);
const norm = (v) => String(v ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const safeUrl = (value) => {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
};
const money = (value, currency='USD') => {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return esc(value);
  return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
};
const percent = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (value === 'BAJO' || value === 'ALTO') return value;
  const n = Number(value);
  return Number.isFinite(n) ? `${(n*100).toFixed(2)}%` : esc(value);
};
const colorMap = {
  'white':'#ffffff','cream':'#fff1bf','sand':'#d8c7a9','yellow':'#f5dc42',
  'light pink':'#f2a9c0','peach':'#f4b18e','light blue':'#91c9e8','mustard':'#d8a62b',
  'coral':'#f47768','orange':'#ed8b28','medium pink':'#d95c91','lavender':'#a991d1',
  'spring':'#8fbd79','green':'#4d9860','hot pink':'#e52d82','bronze':'#a86b43',
  'red':'#c94343','burgundy':'#762d4b','purple':'#8050a2','blue':'#3977b9',
  'earth':'#806b54','fuchsia':'#d72e94','blush':'#e9a2ae','assorted colors':'assorted',
  'assorted':'assorted','bicolor':'#a26ab4','fall':'#d27a32'
};
function colorDot(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  const c = colorMap[norm(name)] || '#a7ada5';
  const style = c === 'assorted'
    ? 'background:linear-gradient(90deg,#e74b4b 0 25%,#f2ce46 25% 50%,#54a66a 50% 75%,#4788ca 75%);'
    : `background:${c};`;
  return `<span class="color-dot" style="${style}" title="${esc(name)}"></span>`;
}
function colorContent(group) {
  const vals = [group['Color 1'], group['Color 2']].filter(Boolean);
  if (!vals.length) return '<span class="color-label">Color no especificado</span>';
  return vals.map(v => `<span class="color-pair">${colorDot(v)}<span class="color-label">${esc(v)}</span></span>`).join('');
}
function statusIcon(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'y') return {icon:'☀️',cls:'y',label:'Temprano'};
  if (s === 'n') return {icon:'🌙',cls:'n',label:'Tarde / no disponible'};
  if (s === '-') return {icon:'◷',cls:'variable',label:'Variable'};
  return {icon:'↗',cls:'',label:'Sin dato'};
}
function farmMap() {
  const map = new Map();
  farms.forEach(f => map.set(norm(f.Nombre), f));
  return map;
}
async function api(url, options={}) {
  const headers = new Headers(options.headers || {});
  if (!['GET','HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  const response = await fetch(url, {...options, headers});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}
function setModal(id, open=true) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.toggle('active', open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
}
function uniqueValues(values) {
  const map = new Map();
  values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').forEach(v => {
    const key = norm(v);
    if (!map.has(key)) map.set(key, String(v).trim());
  });
  return [...map.values()].sort((a,b)=>a.localeCompare(b,'es'));
}
function getFilterValues(type) {
  if (type === 'category') return uniqueValues(catalog.map(p=>p['Categoría']));
  if (type === 'farm') return uniqueValues(catalog.flatMap(p=>p.Fincas || []));
  if (type === 'color') return uniqueValues(catalog.flatMap(p=>[p['Color 1'],p['Color 2']]));
  return [];
}
function renderFilter(type) {
  const host = $(`${type}FilterOptions`);
  if (!host) return;
  const values = getFilterValues(type);
  host.innerHTML = values.map(value => `
    <label class="filter-option" data-filter-value="${esc(norm(value))}">
      <input type="checkbox" data-filter-type="${type}" value="${esc(value)}" ${selectedFilters[type].some(v=>norm(v)===norm(value))?'checked':''}>
      <span>${esc(value)}</span>
    </label>`).join('') || '<span class="muted tiny">Sin opciones</span>';
  const wrap = document.querySelector(`.filter-wrap[data-filter="${type}"]`);
  const button = wrap?.querySelector('.filter-button');
  if (button) {
    const label = type === 'category' ? 'Categorías' : type === 'farm' ? 'Fincas' : 'Colores';
    button.innerHTML = `${label}${selectedFilters[type].length ? ` · ${selectedFilters[type].length}` : ''} <span>⌄</span>`;
    button.classList.toggle('active', selectedFilters[type].length > 0);
  }
}
function renderAllFilters() {
  ['category','farm','color'].forEach(renderFilter);
}
function applyFilters() {
  const term = norm($('searchInput').value);
  filteredCatalog = catalog.filter(p => {
    const haystack = norm([
      p.Producto,p['Categoría'],p.Composición,p['Color 1'],p['Color 2'],p.Season,
      ...(p.Fincas || []),...(p.Tamaños || [])
    ].join(' '));
    if (term && !haystack.includes(term)) return false;
    if (selectedFilters.category.length && !selectedFilters.category.some(v=>norm(v)===norm(p['Categoría']))) return false;
    if (selectedFilters.farm.length && !(p.Fincas || []).some(f=>selectedFilters.farm.some(v=>norm(v)===norm(f)))) return false;
    if (selectedFilters.color.length && ![p['Color 1'],p['Color 2']].filter(Boolean).some(c=>selectedFilters.color.some(v=>norm(v)===norm(c)))) return false;
    return true;
  });
  visibleCount = 64;
  renderGrid();
  renderActiveFilters();
}
function renderActiveFilters() {
  const host = $('activeFilters');
  const chips = [];
  for (const type of Object.keys(selectedFilters)) {
    selectedFilters[type].forEach(value => chips.push(`<span class="active-filter">${esc(value)} <button data-remove-filter="${type}" data-value="${esc(value)}">×</button></span>`));
  }
  host.innerHTML = chips.join('');
}
function cardHtml(p) {
  const img = safeUrl(p.IMG);
  const imageHtml = img
    ? `<img loading="lazy" src="${esc(img)}" alt="${esc(p.Producto)}">`
    : `<div class="image-fallback">✿</div>`;
  const sizes = (p.Tamaños || []).slice(0,4).map(s=>`<span class="size-chip">${esc(s)}</span>`).join('');
  const moreSizes = (p.Tamaños || []).length > 4 ? `<span class="size-chip">+${p.Tamaños.length-4}</span>` : '';
  const season = p.Season ? `<span class="chip season">${esc(p.Season)}</span>` : '';
  return `<article class="product-card" data-product-id="${esc(p.id)}">
    <div class="product-image">${imageHtml}</div>
    <div class="product-info">
      <h3 class="product-name">${esc(p.Producto || 'Producto sin nombre')}</h3>
      <span class="product-category">${esc(p['Categoría'] || 'Sin categoría')}</span>
      <div class="color-row">${colorContent(p)}</div>
      <div class="card-meta"><div class="chip-row">${sizes}${moreSizes}</div>${season}</div>
    </div>
  </article>`;
}
function renderGrid() {
  const host = $('productGrid');
  const visible = filteredCatalog.slice(0,visibleCount);
  host.innerHTML = visible.map(cardHtml).join('');
  host.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => {
      const group = catalog.find(p=>p.id===card.dataset.productId);
      if (group) openDetails(group);
    });
    card.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.replaceWith(Object.assign(document.createElement('div'),{className:'image-fallback',textContent:'✿'}));}));
  });
  $('loadMoreButton').classList.toggle('hidden', visibleCount >= filteredCatalog.length);
  $('statusLine').textContent = filteredCatalog.length === catalog.length
    ? `${catalog.length.toLocaleString('es')} productos en el catálogo`
    : `${filteredCatalog.length.toLocaleString('es')} de ${catalog.length.toLocaleString('es')} productos`;
}
function renderUserArea() {
  const host = $('userArea');
  if (!currentUser) {
    host.innerHTML = '<button class="btn subtle" id="openStaffLogin">Acceso personal</button>';
    $('openStaffLogin').addEventListener('click',()=>setModal('staffLoginModal'));
    return;
  }
  const adminLink = currentUser.role === 'admin' ? '<a class="btn subtle" href="/admin">Administrar</a>' : '';
  host.innerHTML = `${adminLink}<span class="user-pill">${currentUser.role === 'admin' ? 'Admin' : 'Personal'} · ${esc(currentUser.username)}</span><button class="btn subtle" id="staffLogout">Salir</button>`;
  $('staffLogout').addEventListener('click', async ()=>{
    try { await api('/api/logout',{method:'POST',body:'{}'}); currentUser=null; await loadCatalog(); }
    catch(e){ alert(e.message); }
  });
}
function renderDetailTable(text, isStaff=false) {
  const value = String(text || '').trim();
  if (!value) return '';
  const lines = value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  let tableLines = lines.filter(x=>x.includes('|'));
  if (!isStaff) {
    tableLines = tableLines.map(line => {
      const parts = line.split('|');
      const offset = line.trim().startsWith('|') ? 1 : 0;
      if (parts.length > offset + 2) parts.splice(offset + 2, 2);
      return parts.join('|');
    });
  }
  if (tableLines.length >= 2) {
    const parsed = tableLines.filter(x=>!/^(\|?\s*:?-{3,}:?\s*\|)+$/.test(x.replace(/\s/g,'')));
    if (parsed.length) {
      const cells = parsed.map(line=>line.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim()));
      const head = cells[0];
      const body = cells.slice(1);
      return `<table><thead><tr>${head.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body.map(row=>`<tr>${head.map((_,i)=>`<td>${esc(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  }
  return `<div class="long-text">${esc(value)}</div>`;
}
function openDetails(group) {
  activeGroup = group;
  const img = safeUrl(group.IMG);
  $('detailImage').style.display = img ? 'block' : 'none';
  $('detailImageFallback').style.display = img ? 'none' : 'grid';
  $('detailImage').src = img || '';
  $('detailImage').onerror = () => { $('detailImage').style.display='none'; $('detailImageFallback').style.display='grid'; };
  $('detailCategory').textContent = group['Categoría'] || 'Sin categoría';
  $('detailName').textContent = group.Producto || 'Producto sin nombre';
  $('detailColors').innerHTML = colorContent(group);
  $('detailFarms').innerHTML = (group.Fincas || []).map(f=>`<button class="chip filter-chip" data-filter-kind="farm" data-filter-value="${esc(f)}">${esc(f)}</button>`).join('') || '<span class="muted">—</span>';
  $('detailSeasonWrap').classList.toggle('hidden',!group.Season);
  $('detailSeason').innerHTML = group.Season ? `<span class="chip season">${esc(group.Season)}</span>` : '';
  $('detailSizeWrap').classList.toggle('hidden',!(group.Tamaños || []).length);
  $('detailSizes').innerHTML = (group.Tamaños || []).map(s=>`<span class="chip">${esc(s)}</span>`).join('');
  $('detailCompositionWrap').classList.toggle('hidden',!group.Composición);
  $('detailComposition').textContent = group.Composición || '';
  const staff = !!(currentUser && ['admin','staff'].includes(currentUser.role));
  $('detailTableWrap').classList.toggle('hidden',!group.Tabla);
  $('detailTable').innerHTML = renderDetailTable(group.Tabla, staff);
  $('detailPrices').classList.toggle('hidden',!staff);
  $('staffHint').classList.toggle('hidden',staff);
  if (staff) {
    activeMarket = 'US';
    document.querySelectorAll('[data-market]').forEach(b=>b.classList.toggle('active',b.dataset.market==='US'));
    renderPriceTable();
  }
  setModal('detailModal');
}
function renderPriceTable() {
  if (!activeGroup || !currentUser) return;
  const variants = activeGroup.variants || [];
  const host = $('priceTableWrap');
  const rows = activeMarket === 'US'
    ? variants.filter(v=>v['Caja EC'] || v['Venta'] !== null && v['Venta'] !== undefined)
    : variants.filter(v=>v['Caja UK'] || v['Venta UK'] !== null && v['Venta UK'] !== undefined);
  if (!rows.length) {
    host.innerHTML = `<p class="muted tiny">No hay datos de precios ${activeMarket} para este producto.</p>`;
    return;
  }
  if (activeMarket === 'US') {
    host.innerHTML = `<div class="table-scroll"><table class="price-table"><thead><tr><th>Finca</th><th>Tamaño</th><th>Caja EC</th><th>Op</th><th>Caja Finca</th><th>Total Tallos</th><th>Compra</th><th>Markup</th><th>Venta</th></tr></thead><tbody>
      ${rows.map(v=>`<tr><td>${esc(v.Finca||'—')}</td><td>${esc(v.Tamaño||'—')}</td><td>${esc(v['Caja EC']||'—')}</td><td>${esc(v.Op||'—')}</td><td>${esc(v['Caja Finca']||'—')}</td><td>${esc(v['Total Tallos']??'—')}</td><td>${money(v.Compra,'USD')}</td><td><strong>${percent(v.Markup)}</strong></td><td><strong>${money(v.Venta,'USD')}</strong></td></tr>`).join('')}
    </tbody></table></div>`;
  } else {
    host.innerHTML = `<div class="table-scroll"><table class="price-table"><thead><tr><th>Finca</th><th>Tamaño</th><th>Caja UK</th><th>Op UK</th><th>Compra UK · USD</th><th>Markup UK</th><th>Venta UK · GBP</th></tr></thead><tbody>
      ${rows.map(v=>`<tr><td>${esc(v.Finca||'—')}</td><td>${esc(v.Tamaño||'—')}</td><td>${esc(v['Caja UK']||'—')}</td><td>${esc(v['Op UK']||'—')}</td><td>${money(v['Compra UK'] ?? v.Compra,'USD')}</td><td><strong>${percent(v['Markup UK'])}</strong></td><td><strong>${money(v['Venta UK'],'GBP')}</strong></td></tr>`).join('')}
    </tbody></table></div>`;
  }
}
function openFarmArrivals() {
  const map = farmMap();
  const sorted = [...farms].sort((a,b)=>String(a.Nombre||'').localeCompare(String(b.Nombre||''),'es'));
  $('farmArrivalList').innerHTML = sorted.map(f=>{
    const status = statusIcon(f.Llegada);
    return `<div class="arrival-item ${status.cls}"><span>${status.icon}</span><strong>${esc(f.Nombre)}</strong><small class="muted">${esc(status.label)}</small></div>`;
  }).join('');
  setModal('farmArrivalModal');
}
function renderMix() {
  $('mixSelected').innerHTML = mixSelected.map(p=>`<span class="mix-pill">${esc(p.Producto)} <button data-remove-mix="${esc(p.id)}">×</button></span>`).join('');
  const common = mixSelected.length ? mixSelected[0].Fincas.filter(f=>mixSelected.every(p=>(p.Fincas||[]).some(x=>norm(x)===norm(f)))) : [];
  const host = $('mixCommonFarms');
  if (!mixSelected.length) host.innerHTML = '<span class="muted tiny">Añade al menos un producto.</span>';
  else if (!common.length) host.innerHTML = '<div class="alert error">No hay una finca común que tenga todas las variedades seleccionadas.</div>';
  else {
    const map = farmMap();
    host.innerHTML = common.sort((a,b)=>a.localeCompare(b,'es')).map(f=>{
      const status = statusIcon(map.get(norm(f))?.Llegada);
      return `<span class="arrival-item ${status.cls}">${status.icon} ${esc(f)}</span>`;
    }).join('');
  }
}
function searchMix() {
  const term = norm($('mixSearchInput').value);
  const host = $('mixSearchResults');
  if (!term) { host.classList.add('hidden'); host.innerHTML=''; return; }
  const matches = catalog.filter(p=>norm(p.Producto).includes(term) || norm(p['Categoría']).includes(term)).filter(p=>!mixSelected.some(x=>x.id===p.id)).slice(0,10);
  host.innerHTML = matches.length ? matches.map(p=>`<div class="mix-result" data-add-mix="${esc(p.id)}"><span class="mini-thumb">✿</span><span><strong>${esc(p.Producto)}</strong><br><small class="muted">${esc(p['Categoría'])} · ${(p.Fincas||[]).map(esc).join(', ')}</small></span></div>`).join('') : '<div class="mix-result muted">No se encontraron productos.</div>';
  host.classList.remove('hidden');
}
function clearAllFilters() {
  selectedFilters = {category:[],farm:[],color:[]};
  $('searchInput').value='';
  renderAllFilters();
  applyFilters();
}
async function loadCatalog() {
  $('statusLine').textContent = 'Cargando datos del archivo Excel…';
  try {
    const data = await api('/api/catalog');
    catalog = data.products || [];
    farms = data.farms || [];
    options = data.options || {};
    currentUser = data.user || null;
    $('catalogStats').textContent = `${data.stats.products} productos · ${data.stats.rows} registros`;
    renderUserArea();
    renderAllFilters();
    applyFilters();
  } catch (e) {
    $('statusLine').textContent = `No se pudo cargar el catálogo: ${e.message}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>setModal(btn.dataset.close,false)));
  document.querySelectorAll('.modal').forEach(modal=>modal.addEventListener('click',e=>{if(e.target===modal)setModal(modal.id,false);}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal.active').forEach(m=>setModal(m.id,false));});

  document.querySelectorAll('.filter-wrap').forEach(wrap=>{
    const button=wrap.querySelector('.filter-button');
    button.addEventListener('click',()=>{
      document.querySelectorAll('.filter-wrap').forEach(other=>{if(other!==wrap)other.classList.remove('open');});
      wrap.classList.toggle('open');
    });
    wrap.querySelector('.filter-search').addEventListener('input',e=>{
      const term=norm(e.target.value);
      wrap.querySelectorAll('.filter-option').forEach(opt=>opt.style.display=norm(opt.textContent).includes(term)?'flex':'none');
    });
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.filter-wrap')) document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
    const filterInput=e.target.closest('input[data-filter-type]');
    if(filterInput){
      const type=filterInput.dataset.filterType;
      if(filterInput.checked) selectedFilters[type].push(filterInput.value);
      else selectedFilters[type]=selectedFilters[type].filter(v=>norm(v)!==norm(filterInput.value));
      renderFilter(type); applyFilters();
    }
    const remove=e.target.closest('[data-remove-filter]');
    if(remove){
      const type=remove.dataset.removeFilter, value=remove.dataset.value;
      selectedFilters[type]=selectedFilters[type].filter(v=>norm(v)!==norm(value));
      renderFilter(type); applyFilters();
    }
    const farmChip=e.target.closest('.filter-chip');
    if(farmChip){
      const type=farmChip.dataset.filterKind, value=farmChip.dataset.filterValue;
      if(!selectedFilters[type].some(v=>norm(v)===norm(value))) selectedFilters[type].push(value);
      setModal('detailModal',false); renderFilter(type); applyFilters();
    }
    const add=e.target.closest('[data-add-mix]');
    if(add){
      const group=catalog.find(p=>p.id===add.dataset.addMix);
      if(group) mixSelected.push(group);
      $('mixSearchInput').value=''; $('mixSearchResults').classList.add('hidden'); renderMix();
    }
    const removeMix=e.target.closest('[data-remove-mix]');
    if(removeMix){mixSelected=mixSelected.filter(p=>p.id!==removeMix.dataset.removeMix);renderMix();}
  });

  $('searchInput').addEventListener('input',applyFilters);
  $('clearFiltersButton').addEventListener('click',clearAllFilters);
  $('loadMoreButton').addEventListener('click',()=>{visibleCount+=64;renderGrid();});
  $('mixBoxButton').addEventListener('click',()=>{mixSelected=[];$('mixSearchInput').value='';renderMix();setModal('mixBoxModal');$('mixSearchInput').focus();});
  $('mixSearchInput').addEventListener('input',searchMix);
  $('farmArrivalButton').addEventListener('click',openFarmArrivals);
  document.querySelectorAll('[data-market]').forEach(btn=>btn.addEventListener('click',()=>{
    activeMarket=btn.dataset.market;
    document.querySelectorAll('[data-market]').forEach(b=>b.classList.toggle('active',b===btn));
    renderPriceTable();
  }));
  $('staffLoginForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const error=$('staffLoginError');error.classList.add('hidden');
    try{
      const data=await api('/api/login',{method:'POST',body:JSON.stringify({username:$('staffUsername').value,password:$('staffPassword').value})});
      currentUser=data.user; $('staffPassword').value=''; setModal('staffLoginModal',false); await loadCatalog();
    }catch(err){error.textContent=err.message;error.classList.remove('hidden');}
  });
  loadCatalog();
});
