const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = value => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const COLOR_MAP = {
  'white':'#ffffff','cream':'#fff1bf','sand':'#d8c7a9','yellow':'#f5dc42','light pink':'#f2a9c0',
  'peach':'#f4b18e','light blue':'#91c9e8','mustard':'#d8a62b','coral':'#f47768','orange':'#ed8b28',
  'medium pink':'#d95c91','lavender':'#a991d1','spring':'#8fbd79','green':'#4d9860','hot pink':'#e52d82',
  'bronze':'#a86b43','red':'#c94343','burgundy':'#762d4b','purple':'#8050a2','blue':'#3977b9',
  'earth':'#806b54','fuchsia':'#d72e94','blush':'#e9a2ae','assorted colors':'assorted','assorted':'assorted',
  'bicolor':'#a26ab4','fall':'#d27a32'
};
let catalog=[], farms=[], currentUser=null, localMode=false, csrfToken='';
let selectedFilters={category:[],farm:[],color:[],season:[]};
let filteredCatalog=[], visibleCount=72, currentProduct=null, galleryIndex=0, activeMarket='US', mixSelected=[];

function safeUrl(value){const s=String(value||'').trim();return /^(https?:\/\/|\/media\/|assets\/)/i.test(s)?s:'';}
function colorHex(name){return COLOR_MAP[norm(name)]||'#a7ada5';}
function dotHtml(name){const hex=colorHex(name);const style=hex==='assorted'?'background:linear-gradient(90deg,#e74b4b 0 25%,#f2ce46 25% 50%,#54a66a 50% 75%,#4788ca 75%)':`background:${hex}`;return `<i class="color-dot" style="${style}" title="${esc(name)}"></i>`;}
function colorHtml(product){
  const colors=[product['Color 1'],product['Color 2']].filter(Boolean);
  if(!colors.length)return '<span class="color-label">Color no especificado</span>';
  if(colors.length===2){
    const a=colorHex(colors[0]),b=colorHex(colors[1]);
    const split=`background:linear-gradient(135deg,${a==='assorted'?'#e74b4b':a} 0 50%,${b==='assorted'?'#3977b9':b} 50% 100%)`;
    return `<span class="bicolor-pill"><i class="split-dot" style="${split}"></i>Bicolor</span>${colors.map(c=>`<span class="color-pair">${dotHtml(c)}<span class="color-label">${esc(c)}</span></span>`).join('')}`;
  }
  return `<span class="color-pair">${dotHtml(colors[0])}<span class="color-label">${esc(colors[0])}</span></span>`;
}
function traffic(status){
  const s=String(status??'').trim().toLowerCase();
  if(s==='y')return '<i class="traffic y" title="Temprano"></i>';
  if(s==='n')return '<i class="traffic n" title="Tarde"></i>';
  return '<i class="traffic off" title="Sin dato"></i>';
}
function semHtml(status,label=''){
  const s=String(status??'').trim().toLowerCase();
  const cls=s==='y'?'y':s==='n'?'n':'off';
  const title=s==='y'?'Aprobado':s==='n'?'No aprobado':(label||'Sin dato');
  return `<span class="semaphore-cell"><i class="traffic ${cls}" title="${title}"></i>${label?`<small>${esc(label)}</small>`:''}</span>`;
}
function money(value,currency='USD'){
  if(value===null||value===undefined||value==='')return '—';
  const n=Number(value);if(!Number.isFinite(n))return esc(value);
  return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
}
function percent(value){
  if(value===null||value===undefined||value==='')return '—';
  if(value==='BAJO'||value==='ALTO')return value;
  const n=Number(value);return Number.isFinite(n)?`${(n*100).toFixed(2)}%`:esc(value);
}
function fmtNum(value,digits=2){const n=Number(value);return Number.isFinite(n)?n.toFixed(digits):'—';}
async function getJson(url,options={}){
  const headers=new Headers(options.headers||{});
  if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase())&&csrfToken)headers.set('X-CSRF-Token',csrfToken);
  if(options.body&&!(options.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||`Error ${response.status}`);
  return data;
}
function setModal(id,open=true){const el=$(id);if(!el)return;el.classList.toggle('active',open);el.setAttribute('aria-hidden',open?'false':'true');}
function unique(values){const m=new Map();values.filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').forEach(v=>{const k=norm(v);if(!m.has(k))m.set(k,String(v).trim());});return [...m.values()].sort((a,b)=>a.localeCompare(b,'es'));}
function filterValues(type){
  if(type==='category')return unique(catalog.map(p=>p['Categoría']));
  if(type==='farm')return unique(farms.map(f=>f.Nombre).concat(catalog.flatMap(p=>p.Fincas||[])));
  if(type==='color')return unique(catalog.flatMap(p=>[p['Color 1'],p['Color 2']]));
  if(type==='season')return unique(catalog.map(p=>p.Season));
  return [];
}
function renderFilter(type){
  const host=$(`${type}Options`), chips=$(`${type}Chips`);
  const values=filterValues(type);
  if(!host||!chips)return;
  chips.innerHTML=selectedFilters[type].map(v=>`<span class="filter-chip">${esc(v)}<button type="button" data-remove-filter="${type}" data-value="${esc(v)}" aria-label="Quitar ${esc(v)}">×</button></span>`).join('');
  host.innerHTML=values.map(value=>{
    const checked=selectedFilters[type].some(x=>norm(x)===norm(value));
    const color=type==='color'?dotHtml(value):'';
    return `<label class="filter-option" data-option="${esc(norm(value))}"><input type="checkbox" data-filter-type="${type}" value="${esc(value)}" ${checked?'checked':''}>${color}<span>${esc(value)}</span></label>`;
  }).join('')||'<span class="muted">Sin opciones</span>';
  const wrap=document.querySelector(`.filter-wrap[data-filter="${type}"]`);
  const button=wrap?.querySelector('.filter-button');
  const label={category:'Categorías',farm:'Fincas',color:'Colores',season:'Temporada'}[type];
  if(button){button.innerHTML=`${label}${selectedFilters[type].length?` · ${selectedFilters[type].length}`:''}<i class="fi fi-rr-angle-small-down"></i>`;button.classList.toggle('active',selectedFilters[type].length>0);}
}
function renderAllFilters(){
  ['category','farm','color','season'].forEach(renderFilter);
  const count=Object.values(selectedFilters).reduce((sum,items)=>sum+items.length,0);
  const badge=$('filterCount');
  if(badge){badge.textContent=count;badge.classList.toggle('hidden',count===0);}
}
function filterSummary(){
  const host=$('activeSummary');const chips=[];
  Object.entries(selectedFilters).forEach(([type,values])=>values.forEach(v=>chips.push(`<span class="summary-chip">${esc(v)}<button data-remove-filter="${type}" data-value="${esc(v)}">×</button></span>`)));
  host.innerHTML=chips.join('');
  const active=Object.values(selectedFilters).some(a=>a.length)||$('searchInput').value.trim().length>0;
  $('clearFiltersButton').disabled=!active;
  const count=Object.values(selectedFilters).reduce((sum,items)=>sum+items.length,0);
  const badge=$('filterCount');
  if(badge){badge.textContent=count;badge.classList.toggle('hidden',count===0);}
}
function applyFilters(){
  const term=norm($('searchInput').value);
  filteredCatalog=catalog.filter(p=>{
    const haystack=norm([p.Producto,p['Categoría'],p.Composición,p['Color 1'],p['Color 2'],p.Season,...(p.Fincas||[]),...(p.Tamaños||[])].join(' '));
    if(term&&!haystack.includes(term))return false;
    if(selectedFilters.category.length&&!selectedFilters.category.some(v=>norm(v)===norm(p['Categoría'])))return false;
    if(selectedFilters.farm.length&&!(p.Fincas||[]).some(f=>selectedFilters.farm.some(v=>norm(v)===norm(f))))return false;
    if(selectedFilters.color.length&&![p['Color 1'],p['Color 2']].filter(Boolean).some(c=>selectedFilters.color.some(v=>norm(v)===norm(c))))return false;
    if(selectedFilters.season.length&&!selectedFilters.season.some(v=>norm(v)===norm(p.Season)))return false;
    return true;
  });
  visibleCount=72;renderGrid();filterSummary();
}
function cardHtml(p){
  const images=p.images||[];const src=images.length?safeUrl(images[0].src):'';
  const season=p.Season?`<span class="season-float">${esc(p.Season)}</span>`:'';
  const image=src?`<img loading="lazy" src="${esc(src)}" alt="${esc(p.Producto)}">`:'<div class="image-fallback">✿</div>';
  return `<article class="product-card" data-product-id="${esc(p.id)}">
    <div class="product-image">${image}${season}</div>
    <div class="product-info"><h3 class="product-name">${esc(p.Producto||'Producto sin nombre')}</h3>
      <span class="product-category">${esc(p['Categoría']||'Sin categoría')}</span>
      <div class="color-row">${colorHtml(p)}</div>
    </div></article>`;
}
function renderGrid(){
  const host=$('productGrid');const shown=filteredCatalog.slice(0,visibleCount);
  host.innerHTML=shown.map(cardHtml).join('');
  host.querySelectorAll('.product-card').forEach(card=>{
    card.addEventListener('click',()=>{const product=catalog.find(p=>p.id===card.dataset.productId);if(product)openDetails(product);});
    card.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.replaceWith(Object.assign(document.createElement('div'),{className:'image-fallback',textContent:'✿'}));}));
  });
  $('loadMoreButton').classList.toggle('hidden',visibleCount>=filteredCatalog.length);
  $('statusLine').textContent=filteredCatalog.length===catalog.length?`${catalog.length.toLocaleString('es')} productos en el catálogo`:`${filteredCatalog.length.toLocaleString('es')} de ${catalog.length.toLocaleString('es')} productos`;
}
function renderUserArea(){
  const profile=$('profileArea'),login=$('staffLoginButton');
  if(!localMode){
    profile.classList.add('hidden');login.classList.remove('hidden');
    $('staffLoginForm').classList.add('hidden');
    $('staffLoginUnavailable').classList.remove('hidden');
    return;
  }
  if(!currentUser){
    profile.classList.add('hidden');login.classList.remove('hidden');
    $('staffLoginForm').classList.remove('hidden');
    $('staffLoginUnavailable').classList.add('hidden');
    return;
  }
  profile.classList.remove('hidden');login.classList.add('hidden');
  $('staffLoginForm').classList.remove('hidden');
  $('staffLoginUnavailable').classList.add('hidden');
  const avatar=$('profileAvatar');
  if(currentUser.avatar)avatar.innerHTML=`<img src="${esc(currentUser.avatar)}" alt="">`;
  else avatar.innerHTML='<i class="fi fi-rr-user"></i>';
  const menu=$('profileMenu');
  menu.innerHTML=`<div class="profile-name">${esc(currentUser.username)} · ${currentUser.role==='admin'?'Administrador':'Personal'}</div>
    ${currentUser.role==='admin'?'<a href="/admin"><i class="fi fi-rr-settings"></i> Administración</a>':''}
    <button type="button" id="profileLogout"><i class="fi fi-rr-sign-out-alt"></i> Cerrar sesión</button>`;
  $('profileLogout').addEventListener('click',async()=>{try{await getJson('api/logout',{method:'POST',body:'{}'});currentUser=null;await loadCatalog();menu.classList.add('hidden');}catch(e){alert(e.message);}});
}
function sizeSort(a,b){const x=parseFloat(String(a).replace(',','.'))||9999,y=parseFloat(String(b).replace(',','.'))||9999;return x-y;}
function openDetails(product){
  currentProduct=product;galleryIndex=0;
  $('detailCategory').textContent=product['Categoría']||'';
  $('detailName').textContent=product.Producto||'';
  $('detailColors').innerHTML=colorHtml(product);
  $('detailFarms').innerHTML=(product.Fincas||[]).map(f=>`<span class="farm-chip">${traffic((product.farmStatus||{})[f])}<span>${esc(f)}</span></span>`).join('')||'<span class="muted">—</span>';
  $('detailSeasonWrap').classList.toggle('hidden',!product.Season);
  $('detailSeason').innerHTML=product.Season?`<span class="chip season-chip">${esc(product.Season)}</span>`:'';
  $('detailSizeWrap').classList.toggle('hidden',!(product.Tamaños||[]).length);
  $('detailSizes').innerHTML=(product.Tamaños||[]).slice().sort(sizeSort).map(s=>`<span class="chip">${esc(s)}</span>`).join('');
  const showAdminComposition=!!(currentUser&&currentUser.role==='admin');
  $('detailTableWrap').classList.toggle('hidden',!(product.Tabla||[]).length);
  $('detailTable').innerHTML=renderCompositionTable(product.Tabla||[],showAdminComposition);
  renderGallery();
  const hasPrices=localMode&&currentUser&&['admin','staff'].includes(currentUser.role)&&Array.isArray(product.variants);
  $('detailPrices').classList.toggle('hidden',!hasPrices);
  $('staffHint').classList.toggle('hidden',!localMode||hasPrices);
  if(hasPrices){activeMarket='US';document.querySelectorAll('[data-market]').forEach(b=>b.classList.toggle('active',b.dataset.market==='US'));renderPriceTable();}
  setModal('detailModal');
}
function renderGallery(){
  const images=currentProduct?.images||[];
  const main=$('detailImage'),fallback=$('detailImageFallback');
  const selected=images[galleryIndex];
  if(selected&&safeUrl(selected.src)){main.src=selected.src;main.style.display='block';fallback.style.display='none';}
  else{main.style.display='none';fallback.style.display='grid';}
  main.onerror=()=>{main.style.display='none';fallback.style.display='grid';};
  $('galleryPrev').classList.toggle('hidden',images.length<2);
  $('galleryNext').classList.toggle('hidden',images.length<2);
  $('detailThumbnails').innerHTML=images.map((img,i)=>`<button class="thumbnail ${i===galleryIndex?'active':''}" data-gallery-index="${i}" aria-label="Ver imagen ${i+1}"><img src="${esc(img.src)}" alt=""></button>`).join('');
}
function renderCompositionTable(lines,showAdminColumns=false){
  if(!lines.length)return '';
  const normalized=lines.map(x=>({
    variety:x.variety??x.Variedad??'',
    stems:Number(x.stems??x.Tallos??0)||0,
    price:Number(x.price??x.Precio??0)||0
  }));
  const sumStems=normalized.reduce((s,x)=>s+x.stems,0);
  const sumTotal=normalized.reduce((s,x)=>s+x.stems*x.price,0);
  const avg=sumStems?sumTotal/sumStems:0;
  return `<div class="composition-table-wrap"><table class="composition-table">
    <thead><tr><th>Variedad</th><th class="num">Tallos</th>${showAdminColumns?'<th class="num">Precio</th><th class="num">Total</th>':''}</tr></thead>
    <tbody>${normalized.map(x=>`<tr><td>${esc(x.variety)}</td><td class="num">${x.stems}</td>${showAdminColumns?`<td class="num">${fmtNum(x.price)}</td><td class="num">${fmtNum(x.stems*x.price)}</td>`:''}</tr>`).join('')}</tbody>
    ${showAdminColumns?`<tfoot><tr><td>TOTAL</td><td class="num">${sumStems}</td><td class="num">${fmtNum(avg)}</td><td class="num">${money(sumTotal,'USD')}</td></tr></tfoot>`:''}
  </table></div>`;
}
function boxInfoHtml(info,delta){
  if(!info)return '<span class="box-info"><strong>—</strong></span>';
  const dims=[info.Largo,info.Ancho,info.Alto].map(x=>fmtNum(x,1)).join(' × ');
  const diff=delta===null||delta===undefined?'':`<small class="box-diff">Δ peso: ${Number(delta)>0?'+':''}${fmtNum(delta,3)}</small>`;
  return `<span class="box-info"><strong>${esc(info.Nombre||'')}</strong><small>${dims} cm · ${fmtNum(info.Peso,3)}</small>${diff}</span>`;
}
function priceRowFarm(row,group){
  const status=(group.farmStatus||{})[row.Finca]??row._FarmArrival??'-';
  return `<span class="traffic-cell">${traffic(status)}${esc(row.Finca||'—')}</span>`;
}
function renderPriceTable(){
  if(!currentProduct||!currentUser)return;
  const variants=(currentProduct.variants||[]).slice().sort((a,b)=>{
    const farm=norm(a.Finca).localeCompare(norm(b.Finca));if(farm)return farm;
    const size=sizeSort(a.Tamaño,b.Tamaño);if(size)return size;
    const order=['EB','QB','HB','SB','EB2','QB2'];
    const ba=String(a['Caja EC']||a['Caja UK']||'').replace(' UK',''),bb=String(b['Caja EC']||b['Caja UK']||'').replace(' UK','');
    const box=(order.indexOf(ba)<0?99:order.indexOf(ba))-(order.indexOf(bb)<0?99:order.indexOf(bb));if(box)return box;
    return (Number(a['Total Tallos'])||999999)-(Number(b['Total Tallos'])||999999);
  });
  const host=$('priceTableWrap');
  if(activeMarket==='US'){
    host.innerHTML=variants.filter(v=>v['Caja EC']||v.Venta!==null&&v.Venta!==undefined).length?`<div class="price-table-wrap"><table class="price-table"><thead><tr><th>Finca</th><th>Empaque</th><th>Caja EC</th><th>OP</th><th>Caja Finca</th><th>Tallos</th><th>Compra</th><th>Markup</th><th>Venta</th></tr></thead><tbody>
      ${variants.filter(v=>v['Caja EC']||v.Venta!==null&&v.Venta!==undefined).map(v=>`<tr>
        <td>${priceRowFarm(v,currentProduct)}</td><td>${esc(v.Tamaño||'—')}</td>
        <td>${boxInfoHtml(v._boxECInfo,null)}</td>
        <td>${semHtml(v.Op)}</td><td>${boxInfoHtml(v._boxFincaInfo,v._Op_diferencia)}</td>
        <td>${esc(v['Total Tallos']??'—')}</td><td>${money(v.Compra,'USD')}</td><td class="markup-value">${percent(v.Markup)}</td><td><strong>${money(v.Venta,'USD')}</strong></td>
      </tr>`).join('')}</tbody></table></div>`:'<p class="muted">No hay datos de precios USA para este producto.</p>';
  }else{
    host.innerHTML=variants.filter(v=>v['Caja UK']||v['Venta UK']!==null&&v['Venta UK']!==undefined).length?`<div class="price-table-wrap"><table class="price-table"><thead><tr><th>Finca</th><th>Empaque</th><th>Caja UK</th><th>OP UK</th><th>Caja Finca</th><th>Tallos</th><th>Compra UK</th><th>Markup UK</th><th>Venta UK</th></tr></thead><tbody>
      ${variants.filter(v=>v['Caja UK']||v['Venta UK']!==null&&v['Venta UK']!==undefined).map(v=>`<tr>
        <td>${priceRowFarm(v,currentProduct)}</td><td>${esc(v.Tamaño||'—')}</td>
        <td>${boxInfoHtml(v._boxUKInfo,null)}</td><td>${semHtml(v['Op UK'])}</td>
        <td>${boxInfoHtml(v._boxFincaInfo,v._Op_UK_diferencia)}</td>
        <td>${esc(v['Total Tallos']??'—')}</td><td>${money(v['Compra UK']??v.Compra,'USD')}</td>
        <td class="markup-value">${percent(v['Markup UK'])}</td><td><strong>${money(v['Venta UK'],'GBP')}</strong></td>
      </tr>`).join('')}</tbody></table></div>`:'<p class="muted">No hay datos de precios UK para este producto.</p>';
  }
}
function renderArrivals(){
  const sorted=farms.slice().sort((a,b)=>String(a.Nombre||'').localeCompare(String(b.Nombre||''),'es'));
  $('farmArrivalList').innerHTML=sorted.map(f=>`<div class="arrival-item">${traffic(f.Llegada)}<strong>${esc(f.Nombre)}</strong><small class="muted">${f.Llegada==='y'?'Temprano':f.Llegada==='n'?'Tarde':'Sin dato'}</small></div>`).join('');
  setModal('farmArrivalModal');
}
function renderMix(){
  $('mixSelected').innerHTML=mixSelected.map(p=>`<span class="mix-pill">${esc(p.Producto)} <button data-remove-mix="${esc(p.id)}">×</button></span>`).join('');
  const common=mixSelected.length?(mixSelected[0].Fincas||[]).filter(f=>mixSelected.every(p=>(p.Fincas||[]).some(x=>norm(x)===norm(f)))):[];
  if(!mixSelected.length)$('mixCommonFarms').innerHTML='<span class="muted">Añade al menos un producto.</span>';
  else if(!common.length)$('mixCommonFarms').innerHTML='<div class="alert error">No hay una finca común para todas las variedades.</div>';
  else $('mixCommonFarms').innerHTML=common.map(f=>`<span class="farm-chip">${traffic((mixSelected[0].farmStatus||{})[f])}${esc(f)}</span>`).join('');
}
function searchMix(){
  const term=norm($('mixSearchInput').value),host=$('mixSearchResults');
  if(!term){host.classList.add('hidden');host.innerHTML='';return;}
  const matches=catalog.filter(p=>norm(p.Producto).includes(term)||norm(p['Categoría']).includes(term)).filter(p=>!mixSelected.some(x=>x.id===p.id)).slice(0,12);
  host.innerHTML=matches.length?matches.map(p=>`<div class="mix-result" data-add-mix="${esc(p.id)}"><span class="mini-thumb">✿</span><span><strong>${esc(p.Producto)}</strong><br><small class="muted">${esc(p['Categoría'])} · ${(p.Fincas||[]).map(esc).join(', ')}</small></span></div>`).join(''):'<div class="mix-result muted">No se encontraron productos.</div>';
  host.classList.remove('hidden');
}
async function loadCatalog(){
  $('statusLine').textContent='Cargando catálogo…';
  try{
    const res=await fetch('api/catalog',{credentials:'same-origin',cache:'no-store'});
    if(res.ok){
      const data=await res.json();catalog=data.products||[];farms=data.farms||[];currentUser=data.user||null;csrfToken=data.csrfToken||'';localMode=true;
      $('footerStatus').textContent='Catálogo local sincronizado con Excel';
    }else throw new Error('No hay API local');
  }catch(e){
    try{
      const res=await fetch('catalog.json',{cache:'no-store'});if(!res.ok)throw new Error('No se pudo leer catalog.json');
      const data=await res.json();catalog=data.products||[];farms=data.farms||[];currentUser=null;localMode=false;
      $('footerStatus').textContent='Catálogo público · GitHub Pages';
    }catch(err){$('statusLine').textContent=`No se pudo cargar el catálogo: ${err.message}`;return;}
  }
  renderUserArea();renderAllFilters();applyFilters();
}
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>setModal(b.dataset.close,false)));
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)setModal(m.id,false);}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal.active').forEach(m=>setModal(m.id,false));});
  $('filtersToggle').addEventListener('click',e=>{
    e.stopPropagation();
    const pop=$('filtersPopover');
    const open=pop.classList.contains('hidden');
    pop.classList.toggle('hidden',!open);
    $('filtersToggle').setAttribute('aria-expanded',open?'true':'false');
    if(!open)document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
  });
  document.querySelectorAll('.filter-wrap').forEach(w=>{
    w.querySelector('.filter-button').addEventListener('click',e=>{
      e.stopPropagation();
      document.querySelectorAll('.filter-wrap').forEach(x=>{if(x!==w)x.classList.remove('open');});
      w.classList.toggle('open');
    });
    w.querySelector('.filter-search').addEventListener('input',e=>{
      const q=norm(e.target.value);w.querySelectorAll('.filter-option').forEach(o=>o.style.display=norm(o.textContent).includes(q)?'flex':'none');
    });
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.filter-menu-wrap')){
      $('filtersPopover').classList.add('hidden');
      $('filtersToggle').setAttribute('aria-expanded','false');
      document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
    }else if(!e.target.closest('.filter-wrap')){
      document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
    }
    const check=e.target.closest('input[data-filter-type]');
    if(check){const type=check.dataset.filterType;if(check.checked)selectedFilters[type].push(check.value);else selectedFilters[type]=selectedFilters[type].filter(x=>norm(x)!==norm(check.value));renderFilter(type);applyFilters();}
    const remove=e.target.closest('[data-remove-filter]');
    if(remove){const type=remove.dataset.removeFilter,value=remove.dataset.value;selectedFilters[type]=selectedFilters[type].filter(x=>norm(x)!==norm(value));renderFilter(type);applyFilters();}
    const add=e.target.closest('[data-add-mix]');
    if(add){const p=catalog.find(x=>x.id===add.dataset.addMix);if(p)mixSelected.push(p);$('mixSearchInput').value='';$('mixSearchResults').classList.add('hidden');renderMix();}
    const rem=e.target.closest('[data-remove-mix]');
    if(rem){mixSelected=mixSelected.filter(x=>x.id!==rem.dataset.removeMix);renderMix();}
    const thumb=e.target.closest('[data-gallery-index]');
    if(thumb){galleryIndex=Number(thumb.dataset.galleryIndex)||0;renderGallery();}
  });
  $('searchInput').addEventListener('input',applyFilters);
  $('clearFiltersButton').addEventListener('click',()=>{
    if($('clearFiltersButton').disabled)return;
    selectedFilters={category:[],farm:[],color:[],season:[]};$('searchInput').value='';
    renderAllFilters();applyFilters();
    $('filtersPopover').classList.add('hidden');
    $('filtersToggle').setAttribute('aria-expanded','false');
  });
  $('loadMoreButton').addEventListener('click',()=>{visibleCount+=72;renderGrid();});
  $('gridColumns').addEventListener('change',e=>document.documentElement.style.setProperty('--grid-columns',e.target.value));
  $('galleryPrev').addEventListener('click',()=>{if(!currentProduct)return;galleryIndex=(galleryIndex-1+(currentProduct.images||[]).length)%(currentProduct.images||[]).length;renderGallery();});
  $('galleryNext').addEventListener('click',()=>{if(!currentProduct)return;galleryIndex=(galleryIndex+1)%(currentProduct.images||[]).length;renderGallery();});
  $('mixBoxButton').addEventListener('click',()=>{mixSelected=[];$('mixSearchInput').value='';renderMix();setModal('mixBoxModal');$('mixSearchInput').focus();});
  $('mixSearchInput').addEventListener('input',searchMix);
  $('farmArrivalButton').addEventListener('click',renderArrivals);
  document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>{activeMarket=b.dataset.market;document.querySelectorAll('[data-market]').forEach(x=>x.classList.toggle('active',x===b));renderPriceTable();}));
  $('profileButton').addEventListener('click',()=> $('profileMenu').classList.toggle('hidden'));
  document.addEventListener('click',e=>{if(!e.target.closest('.profile-area'))$('profileMenu').classList.add('hidden');});
  $('staffLoginButton').addEventListener('click',()=>{
    if(!localMode){
      $('staffLoginForm').classList.add('hidden');
      $('staffLoginUnavailable').classList.remove('hidden');
    }else{
      $('staffLoginForm').classList.remove('hidden');
      $('staffLoginUnavailable').classList.add('hidden');
    }
    $('staffLoginError').classList.add('hidden');
    setModal('staffLoginModal');
  });
  $('staffLoginForm').addEventListener('submit',async e=>{
    e.preventDefault();const error=$('staffLoginError');error.classList.add('hidden');
    try{const data=await getJson('api/login',{method:'POST',body:JSON.stringify({username:$('staffUsername').value,password:$('staffPassword').value})});currentUser=data.user;$('staffPassword').value='';setModal('staffLoginModal',false);await loadCatalog();}
    catch(err){error.textContent=err.message;error.classList.remove('hidden');}
  });
  loadCatalog();
});
