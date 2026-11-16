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
let catalog=[], farms=[], currentUser=null, currentProfile=null, currentRole='guest', localMode=false, csrfToken='';
let authReady=false, productPageOpen=false, catalogScrollY=0, searchDebounceTimer=null;
const VIEW_STORAGE_KEY='flowerpedia_view_v033';
const APP_BASE=(document.querySelector('meta[name="flowerpedia-base"]')?.content||'/').replace(/\/?$/,'/');
const LOCAL_WEB=['127.0.0.1','localhost','::1'].includes(location.hostname);
let selectedFilters={category:[],farm:[],color:[],season:[]};
const COLOR_FILTER_ORDER=['White','Cream','Sand','Yellow','Light Pink','Peach','Light Blue','Mustard','Coral','Orange','Medium Pink','Lavender','Spring','Green','Hot Pink','Bronze','Red','Burgundy','Purple','Blue','Earth','Bicolor'];
let filteredCatalog=[], visibleCount=72, currentProduct=null, galleryIndex=0, activeMarket='US', mixSelected=[];

function safeUrl(value){const s=String(value||'').trim();return /^(https?:\/\/|\/media\/|assets\/)/i.test(s)?s:'';}
function colorHex(name){return COLOR_MAP[norm(name)]||'#a7ada5';}
function dotHtml(name){const hex=colorHex(name);const style=hex==='assorted'?'background:linear-gradient(90deg,#e74b4b 0 25%,#f2ce46 25% 50%,#54a66a 50% 75%,#4788ca 75%)':`background:${hex}`;return `<i class="color-dot" style="${style}" title="${esc(name)}"></i>`;}
function colorHtml(product){
  const colors=[product['Color 1'],product['Color 2']].filter(Boolean);
  if(!colors.length)return '';
  if(colors.length===2){
    const a=colorHex(colors[0]),b=colorHex(colors[1]);
    const split=`background:linear-gradient(135deg,${a==='assorted'?'#e74b4b':a} 0 50%,${b==='assorted'?'#3977b9':b} 50% 100%)`;
    return `<span class="bicolor-pill"><i class="split-dot" style="${split}"></i>Bicolor</span>${colors.map(c=>`<button type="button" class="color-pair color-click" data-quick-filter="color" data-filter-value="${esc(c)}">${dotHtml(c)}<span class="color-label">${esc(c)}</span></button>`).join('')}`;
  }
  return `<button type="button" class="color-pair color-click" data-quick-filter="color" data-filter-value="${esc(colors[0])}">${dotHtml(colors[0])}<span class="color-label">${esc(colors[0])}</span></button>`;
}
function traffic(status){
  const s=String(status??'').trim().toLowerCase();
  if(s==='y')return '<i class="traffic y" title="Temprano"></i>';
  if(s==='n')return '<i class="traffic n" title="Tarde"></i>';
  return '';
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
function setModal(id,open=true){
  const el=$(id);if(!el)return;
  // El acceso por cuenta es obligatorio: no se puede cerrar el formulario sin sesión.
  if(id==='staffLoginModal'&&!open&&!currentUser)return;
  el.classList.toggle('active',open);el.setAttribute('aria-hidden',open?'false':'true');
}
function setAuthGate(required){
  document.body.classList.toggle('auth-required',!!required);
  if(required)setModal('staffLoginModal',true);
  else setModal('staffLoginModal',false);
}
function unique(values){const m=new Map();values.filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').forEach(v=>{const k=norm(v);if(!m.has(k))m.set(k,String(v).trim());});return [...m.values()].sort((a,b)=>a.localeCompare(b,'es'));}
function prepareCatalogProducts(products){
  return (products||[]).map(product=>{
    const farms=product.Fincas||[];
    const colors=[product['Color 1'],product['Color 2']].filter(Boolean);
    const searchText=[
      product.Producto,product['Categoría'],product.Composición,
      product['Color 1'],product['Color 2'],product.Season,product.Disponibilidad,
      ...farms,...(product.Tamaños||[])
    ].join(' ');
    return {
      ...product,
      _searchText:norm(searchText),
      _categoryNorm:norm(product['Categoría']),
      _farmNorms:farms.map(norm),
      _colorNorms:colors.map(norm),
      _seasonNorm:norm(product.Season),
      _availabilityNorm:norm(product.Disponibilidad||'Disponible')
    };
  });
}
function filterValues(type){
  if(type==='category')return unique(catalog.map(p=>p['Categoría']));
  if(type==='farm')return unique(catalog.flatMap(p=>p.Fincas||[]));
  if(type==='color'){const values=unique(catalog.flatMap(p=>[p['Color 1'],p['Color 2']]));return values.sort((a,b)=>{const ia=COLOR_FILTER_ORDER.findIndex(x=>norm(x)===norm(a)),ib=COLOR_FILTER_ORDER.findIndex(x=>norm(x)===norm(b));return (ia<0?999:ia)-(ib<0?999:ib)||a.localeCompare(b,'es');});}
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
  const icon={category:'fi-rr-flower-tulip',farm:'fi-rr-wheat',color:'fi-rr-palette',season:'fi-rr-calendar'}[type];
  if(button){button.innerHTML=`<i class="fi ${icon}"></i>${label}${selectedFilters[type].length?` · ${selectedFilters[type].length}`:''}<i class="fi fi-rr-angle-small-down"></i>`;button.classList.toggle('active',selectedFilters[type].length>0);}
}
function renderAllFilters(){
  ['category','farm','color','season'].forEach(renderFilter);
  const count=Object.values(selectedFilters).reduce((sum,items)=>sum+items.length,0);
  const badge=$('filterCount');
  if(badge){badge.textContent=count;badge.classList.toggle('hidden',count===0);}
}
function filterSummary(){
  const host=$('activeSummary');
  if(host)host.innerHTML='';
  const active=Object.values(selectedFilters).some(a=>a.length)||$('searchInput').value.trim().length>0;
  const clear=$('clearFiltersButton');
  if(clear){clear.disabled=!active;clear.classList.toggle('hidden',!active);}
}
function saveCatalogView(){
  try{
    localStorage.setItem(VIEW_STORAGE_KEY,JSON.stringify({
      columns:$('gridColumns')?.value||'6',
      search:$('searchInput')?.value||'',
      filters:selectedFilters,
      market:activeMarket
    }));
  }catch(error){console.warn('[Flowerpedia] No se pudo guardar la vista:',error);}
}
function restoreCatalogView(){
  try{
    const view=JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY)||'null');
    if(!view){
      const legacyColumns=localStorage.getItem('flowerpedia_grid_columns');
      if(['5','6','7','8','9','10'].includes(String(legacyColumns)))$('gridColumns').value=String(legacyColumns);
      return;
    }
    if(['5','6','7','8','9','10'].includes(String(view.columns)))$('gridColumns').value=String(view.columns);
    if(typeof view.search==='string')$('searchInput').value=view.search;
    if(view.filters&&typeof view.filters==='object'){
      for(const type of ['category','farm','color','season']){
        if(Array.isArray(view.filters[type]))selectedFilters[type]=view.filters[type].filter(x=>typeof x==='string').slice(0,50);
      }
    }
    if(['US','UK'].includes(view.market))activeMarket=view.market;
  }catch(error){console.warn('[Flowerpedia] No se pudo recuperar la vista:',error);}
}
function applyFilters(){
  const term=norm($('searchInput').value);
  const categories=selectedFilters.category.map(norm);
  const farms=selectedFilters.farm.map(norm);
  const colors=selectedFilters.color.map(norm);
  const seasons=selectedFilters.season.map(norm);
  filteredCatalog=catalog.filter(p=>{
    if(term&&!p._searchText.includes(term))return false;
    if(categories.length&&!categories.includes(p._categoryNorm))return false;
    if(farms.length&&!p._farmNorms.some(f=>farms.includes(f)))return false;
    if(colors.length&&!p._colorNorms.some(c=>colors.includes(c)))return false;
    if(seasons.length&&!seasons.includes(p._seasonNorm))return false;
    return true;
  });
  visibleCount=72;renderGrid();filterSummary();saveCatalogView();
}
function cardHtml(p){
  const images=p.images||[];
  const src=images.length?safeUrl(images[0].src):'';
  const image=src?`<img loading="lazy" src="${esc(src)}" alt="${esc(p.Producto)}">`:'<div class="image-fallback">✿</div>';
  const category=p['Categoría']?`<button type="button" class="product-category category-click" data-quick-filter="category" data-filter-value="${esc(p['Categoría'])}">${esc(p['Categoría'])}</button>`:'';
  const season=p.Season?`<button type="button" class="season-float season-click" data-quick-filter="season" data-filter-value="${esc(p.Season)}">${esc(p.Season)}</button>`:'';
  const eradicated=(p._availabilityNorm||norm(p.Disponibilidad))==='erradicado';
  const availability=eradicated?'<span class="availability-float">Erradicado</span>':'';
  return `<article class="product-card ${eradicated?'is-eradicated':''}" data-product-id="${esc(p.id)}" ${eradicated?'aria-label="Variedad erradicada"':''}>
    <div class="product-image">${image}${season}${availability}</div>
    <div class="product-info">
      <a class="product-name-link" href="${productUrl(p)}"><h3 class="product-name">${esc(p.Producto||'Producto sin nombre')}</h3></a>
      <div class="product-category-row">${category}</div>
      <div class="product-color-row">${colorHtml(p)}</div>
    </div>
  </article>`;
}
function bindProductCards(host){
  host.querySelectorAll('.product-card').forEach(card=>{
    card.addEventListener('click',e=>{
      if(e.target.closest('button,a'))return;
      const product=catalog.find(p=>p.id===card.dataset.productId);
      if(product)openDetails(product);
    });
    card.querySelector('.product-name-link')?.addEventListener('click',e=>{
      if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
      e.preventDefault();
      const product=catalog.find(p=>p.id===card.dataset.productId);
      if(product)openDetails(product);
    });
    card.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{
      img.replaceWith(Object.assign(document.createElement('div'),{className:'image-fallback',textContent:'✿'}));
    }));
  });
}
function renderGrid(){
  const host=$('productGrid'),shown=filteredCatalog.slice(0,visibleCount);
  host.innerHTML=shown.map(cardHtml).join('');
  bindProductCards(host);
  $('loadMoreButton').classList.toggle('hidden',visibleCount>=filteredCatalog.length);
  $('statusLine').textContent=filteredCatalog.length===catalog.length
    ?`${catalog.length.toLocaleString('es')} productos en el catálogo`
    :`${filteredCatalog.length.toLocaleString('es')} de ${catalog.length.toLocaleString('es')} productos`;
}
function renderUserArea(){
  const profile=$('profileArea'),login=$('staffLoginButton');
  if(!profile||!login)return;
  if(!currentUser){profile.classList.add('hidden');login.classList.remove('hidden');return;}
  profile.classList.remove('hidden');login.classList.add('hidden');
  const avatar=$('profileAvatar');
  const displayName=(currentProfile?.username||currentProfile?.display_name||currentUser.user_metadata?.display_name||'Cuenta');
  const label=displayName.trim();
  if(currentProfile?.avatar)avatar.innerHTML=`<img src="${esc(currentProfile.avatar)}" alt="">`;
  else avatar.innerHTML=`<span class="avatar-initials">${esc(label.slice(0,1).toUpperCase())}</span>`;
  const menu=$('profileMenu');
  menu.innerHTML=`<div class="profile-name">${esc(displayName)}</div><div class="profile-role">${currentRole==='admin'?'Administrador':'Personal'}</div>
    ${currentRole==='admin'&&LOCAL_WEB?'<a href="/admin"><i class="fi fi-rr-settings"></i> Administrar Flowerpedia</a>':''}
    <button type="button" id="profileLogout"><i class="fi fi-rr-sign-out-alt"></i> Cerrar sesión</button>`;
  $('profileLogout').addEventListener('click',async()=>{
    try{
      await window.FlowerpediaAuth.signOut();
      currentUser=null;currentProfile=null;currentRole='guest';
      catalog.forEach(product=>{
        delete product.variants;
        product.Tabla=(product.Tabla||[]).map(line=>({
          variety:line.variety??line.Variedad??'',
          stems:line.stems??line.Tallos??0
        }));
      });
      if(currentProduct)delete currentProduct.variants;
      $('detailPrices').classList.add('hidden');
      $('priceTableWrap').innerHTML='';
      if(productPageOpen){history.replaceState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}
      renderUserArea();applyFilters();setAuthGate(true);
      $('staffLoginError').classList.add('hidden');
      $('staffPassword').value='';
    }catch(e){alert(e.message);}
  });
}
function openAuthModal(){
  setModal('staffLoginModal',true);
  $('staffLoginError')?.classList.add('hidden');
}
function slugifyPart(value){
  const slug=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase().slice(0,70);
  return slug||'sin-nombre';
}
function routePath(){
  const path=window.location.pathname;
  return path.startsWith(APP_BASE)?`/${path.slice(APP_BASE.length)}`:path;
}
function productUrl(product){
  return `${APP_BASE}${String(product.publicCode||'').padStart(5,'0')}/${slugifyPart(product['Categoría'])}/${slugifyPart(product.Producto)}`;
}
function isProductRoute(){
  const path=routePath();
  return /^\/\d{5}\/[^/]+\/[^/]+\/?$/.test(path)
    || /^\/producto\/[^/]+\/[^/]+\/?$/.test(path);
}
function productFromLocation(){
  const path=routePath();
  const shortMatch=path.match(/^\/(\d{5})\/([^/]+)\/([^/]+)\/?$/);
  if(shortMatch){
    return catalog.find(p=>String(p.publicCode)===shortMatch[1]
      &&slugifyPart(p['Categoría'])===shortMatch[2]
      &&slugifyPart(p.Producto)===shortMatch[3])||null;
  }
  const legacy=path.match(/^\/producto\/([^/]+)\/([^/]+)\/?$/);
  if(legacy){
    const idMatch=legacy[2].match(/--([a-f0-9]{16})$/i);
    const product=idMatch?catalog.find(p=>String(p.id).toLowerCase()===idMatch[1].toLowerCase()
      &&slugifyPart(p['Categoría'])===legacy[1]):null;
    if(product){history.replaceState({flowerpediaProductCode:String(product.publicCode)},'',productUrl(product));return product;}
  }
  return null;
}
function showCatalogPage(restoreScroll=true){
  productPageOpen=false;currentProduct=null;
  $('productPage').classList.add('hidden');
  $('productPageContent').classList.remove('hidden');
  $('productNotFound').classList.add('hidden');
  $('pageShell').classList.remove('hidden');
  document.title='Flowerpedia · Catálogo';
  if(restoreScroll)window.scrollTo(0,catalogScrollY);
}
function showProductNotFound(){
  productPageOpen=true;
  $('pageShell').classList.add('hidden');
  $('productPage').classList.remove('hidden');
  $('productPageContent').classList.add('hidden');
  $('productNotFound').classList.remove('hidden');
  document.title='Variedad no encontrada · Flowerpedia';
  window.scrollTo(0,0);
}
function closeProductPage(){
  if(window.location.pathname!==APP_BASE)history.pushState({flowerpediaCatalog:true},'',APP_BASE);
  showCatalogPage(false);
}
function copyProductLink(){
  const url=window.location.href;
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(url).then(()=>{
      const button=$('copyProductLinkButton'),previous=button.innerHTML;
      button.innerHTML='<i class="fi fi-rr-check"></i> Enlace copiado';
      setTimeout(()=>button.innerHTML=previous,1800);
    }).catch(()=>window.prompt('Copia este enlace:',url));
  }else window.prompt('Copia este enlace:',url);
}
function handleLocationChange(){
  const product=productFromLocation();
  if(product){openDetails(product,{pushHistory:false});return;}
  if(isProductRoute()){showProductNotFound();return;}
  showCatalogPage(true);
}
function quickFilter(type,value){
  if(!type||!value)return;
  if(productPageOpen){history.pushState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}
  selectedFilters={category:[],farm:[],color:[],season:[]};
  selectedFilters[type]=[String(value)];
  $('searchInput').value='';
  renderAllFilters();applyFilters();saveCatalogView();
  const filterWrap=document.querySelector(`.filter-wrap[data-filter="${type}"]`);
  if(filterWrap){
    document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.toggle('open',w===filterWrap));
    filterWrap.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
}
function sizeSort(a,b){const x=parseFloat(String(a).replace(',','.'))||9999,y=parseFloat(String(b).replace(',','.'))||9999;return x-y;}
async function openDetails(product,{pushHistory=true}={}){
  if(!product)return;
  if(pushHistory){
    if(!productPageOpen)catalogScrollY=window.scrollY;
    const target=productUrl(product);
    if(window.location.pathname!==target){
      history.pushState({flowerpediaProductCode:String(product.publicCode)},'',target);
    }
  }
  currentProduct=product;
  galleryIndex=0;
  productPageOpen=true;
  $('pageShell').classList.add('hidden');
  $('productPage').classList.remove('hidden');
  $('productPageContent').classList.remove('hidden');
  $('productNotFound').classList.add('hidden');
  document.title=`${product.Producto||'Variedad'} · Flowerpedia`;

  $('detailCategory').textContent=product['Categoría']||'';
  $('detailCategory').dataset.filterValue=product['Categoría']||'';
  $('detailName').textContent=product.Producto||'';
  const eradicated=(product._availabilityNorm||norm(product.Disponibilidad))==='erradicado';
  $('detailAvailability').classList.toggle('hidden',!eradicated);
  $('detailFarmsWrap').classList.toggle('hidden',eradicated||!(product.Fincas||[]).length);
  $('detailColors').innerHTML=colorHtml(product);
  $('detailFarms').innerHTML=(product.Fincas||[]).map(f=>
    `<button type="button" class="color-pair farm-chip farm-click" data-quick-filter="farm" data-filter-value="${esc(f)}">${traffic((product.farmStatus||{})[f])}<span class="color-label">${esc(f)}</span></button>`
  ).join('')||'';

  $('detailSeasonWrap').classList.toggle('hidden',!product.Season);
  $('detailSeason').innerHTML=product.Season
    ?`<button type="button" class="chip season-chip" data-quick-filter="season" data-filter-value="${esc(product.Season)}">${esc(product.Season)}</button>`:'';
  $('detailSizeWrap').classList.toggle('hidden',!(product.Tamaños||[]).length);
  $('detailSizes').innerHTML=(product.Tamaños||[]).slice().sort(sizeSort)
    .map(s=>`<span class="chip">${esc(s)}</span>`).join('');

  const description=String(product.Composición||'').trim();
  $('detailDescriptionWrap').classList.toggle('hidden',!description);
  $('detailDescription').textContent=description;

  const showAdminColumns=currentRole==='admin';
  const composition=product.Tabla||[];
  $('detailTableWrap').classList.toggle('hidden',!composition.length);
  $('detailTable').innerHTML=renderCompositionTable(composition,showAdminColumns);

  renderGallery();
  $('detailPrices').classList.toggle('hidden',!showAdminColumns);
  if(showAdminColumns)renderPriceTable();
  else $('priceTableWrap').innerHTML='';

  renderRelatedProducts(product);
  window.scrollTo(0,0);
}
function renderRelatedProducts(product){
  const host=$('relatedProductGrid'),section=$('relatedProductsSection');
  const colorKeys=new Set(product._colorNorms||[product['Color 1'],product['Color 2']].filter(Boolean).map(norm));
  const seasonKey=product._seasonNorm||norm(product.Season);
  const categoryKey=product._categoryNorm||norm(product['Categoría']);
  const related=catalog
    .filter(candidate=>candidate.id!==product.id)
    .map(candidate=>{
      const sameColor=(candidate._colorNorms||[candidate['Color 1'],candidate['Color 2']].filter(Boolean).map(norm))
        .some(color=>colorKeys.has(color));
      const sameSeason=(candidate._seasonNorm||norm(candidate.Season))===seasonKey&&!!seasonKey;
      const sameCategory=(candidate._categoryNorm||norm(candidate['Categoría']))===categoryKey&&!!categoryKey;
      let score=0;
      if(sameColor&&sameCategory)score=5;
      else if(sameColor)score=4;
      else if(sameSeason&&sameCategory)score=3;
      else if(sameSeason)score=2;
      else if(sameCategory)score=1;
      return {product:candidate,score};
    })
    .filter(item=>item.score>0)
    .sort((a,b)=>b.score-a.score||norm(a.product.Producto).localeCompare(norm(b.product.Producto),'es'))
    .slice(0,Math.max(5,Math.min(10,Number($('gridColumns')?.value)||6)))
    .map(item=>item.product);
  section.classList.toggle('hidden',related.length===0);
  host.innerHTML=related.map(cardHtml).join('');
  bindProductCards(host);
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
  const diff=delta===null||delta===undefined?'':`<small class="box-diff">Δ ${Number(delta)>0?'+':''}${fmtNum(delta,3)}</small>`;
  return `<span class="box-info"><strong>${esc(info.Nombre||'')}</strong>${diff}</span>`;
}
function priceRowFarm(row,group){
  const status=(group.farmStatus||{})[row.Finca]??row._FarmArrival??'';
  return `<span class="traffic-cell">${traffic(status)}${esc(row.Finca||'—')}</span>`;
}
function renderPriceTable(){
  if(!currentProduct||currentRole!=='admin')return;
  const variants=(currentProduct.variants||[]).slice().sort((a,b)=>{
    const farm=norm(a.Finca).localeCompare(norm(b.Finca),'es');if(farm)return farm;
    const size=sizeSort(a.Tamaño,b.Tamaño);if(size)return size;
    const order=['EB','QB','HB','SB','EB2','QB2'];
    const ba=String(a['Caja EC']||a['Caja UK']||'').replace(' UK',''),bb=String(b['Caja EC']||b['Caja UK']||'').replace(' UK','');
    const box=(order.indexOf(ba)<0?99:order.indexOf(ba))-(order.indexOf(bb)<0?99:order.indexOf(bb));if(box)return box;
    return (Number(a['Total Tallos'])||999999)-(Number(b['Total Tallos'])||999999);
  });
  const host=$('priceTableWrap');
  const isUS=activeMarket==='US';
  const filtered=variants.filter(v=>isUS
    ?(v['Caja EC']||v.Venta!==null&&v.Venta!==undefined)
    :(v['Caja UK']||v['Venta UK']!==null&&v['Venta UK']!==undefined));
  if(!filtered.length){
    host.innerHTML=`<p class="muted">No hay datos de precios ${isUS?'USA':'UK'} para este producto.</p>`;
    return;
  }

  const grouped=new Map();
  filtered.forEach(row=>{
    const farm=String(row.Finca||'Sin finca').trim()||'Sin finca';
    if(!grouped.has(farm))grouped.set(farm,[]);
    grouped.get(farm).push(row);
  });
  const farmNames=[...grouped.keys()].sort((a,b)=>norm(a).localeCompare(norm(b),'es'));
  const header=isUS
    ?'<tr><th>Finca</th><th>Empaque</th><th>Caja EC</th><th>OP</th><th>Caja Finca</th><th>Tallos</th><th>Compra</th><th>Markup</th><th>Venta</th></tr>'
    :'<tr><th>Finca</th><th>Empaque</th><th>Caja UK</th><th>OP</th><th>Caja Finca</th><th>Tallos</th><th>Compra</th><th>Markup</th><th>Venta</th></tr>';

  const rowsHtml=farmNames.map(farm=>{
    const farmRows=grouped.get(farm);
    const status=(currentProduct.farmStatus||{})[farm]??farmRows[0]?._FarmArrival??'';
    const detailRows=farmRows.map(v=>{
      if(isUS){
        return `<tr>
          <td>${priceRowFarm(v,currentProduct)}</td><td>${esc(v.Tamaño||'—')}</td>
          <td>${boxInfoHtml(v._boxECInfo,null)}</td><td>${semHtml(v.Op)}</td>
          <td>${boxInfoHtml(v._boxFincaInfo,v._Op_diferencia)}</td>
          <td>${esc(v['Total Tallos']??'—')}</td><td>${money(v.Compra,'USD')}</td>
          <td class="markup-value">${percent(v.Markup)}</td><td><strong>${money(v.Venta,'USD')}</strong></td>
        </tr>`;
      }
      return `<tr>
        <td>${priceRowFarm(v,currentProduct)}</td><td>${esc(v.Tamaño||'—')}</td>
        <td>${boxInfoHtml(v._boxUKInfo,null)}</td><td>${semHtml(v['Op UK'])}</td>
        <td>${boxInfoHtml(v._boxFincaInfo,v._Op_UK_diferencia)}</td>
        <td>${esc(v['Total Tallos']??'—')}</td><td>${money(v['Compra UK']??v.Compra,'USD')}</td>
        <td class="markup-value">${percent(v['Markup UK'])}</td><td><strong>${money(v['Venta UK'],'GBP')}</strong></td>
      </tr>`;
    }).join('');
    return `<tr class="farm-group-row"><td colspan="9"><span class="farm-group-title">${traffic(status)}${esc(farm)}</span><span class="farm-group-count">${farmRows.length} ${farmRows.length===1?'registro':'registros'}</span></td></tr>${detailRows}`;
  }).join('');

  host.innerHTML=`<div class="price-table-wrap market-${isUS?'us':'uk'}-theme"><table class="price-table"><thead>${header}</thead><tbody>${rowsHtml}</tbody></table></div>`;
}
function renderArrivals(){
  const sorted=farms.filter(f=>['y','n'].includes(String(f.Llegada||'').toLowerCase())).slice().sort((a,b)=>String(a.Nombre||'').localeCompare(String(b.Nombre||''),'es'));
  $('farmArrivalList').innerHTML=sorted.map(f=>`<div class="arrival-item">${traffic(f.Llegada)}<strong>${esc(f.Nombre)}</strong><small class="muted">${f.Llegada==='y'?'Temprano':'Tarde'}</small></div>`).join('')||'<p class="muted">No hay llegadas con estado registrado.</p>';
  setModal('farmArrivalModal');
}
function renderMix(){
  $('mixSelected').innerHTML=mixSelected.map(p=>{const src=safeUrl(p.images?.[0]?.src);return `<div class="mix-selected-card"><div class="mix-selected-image">${src?`<img src="${esc(src)}" alt="">`:'✿'}</div><strong>${esc(p.Producto)}</strong><button type="button" data-remove-mix="${esc(p.id)}" aria-label="Quitar variedad">×</button></div>`;}).join('');
  const common=mixSelected.length?(mixSelected[0].Fincas||[]).filter(f=>mixSelected.every(p=>(p.Fincas||[]).some(x=>norm(x)===norm(f)))):[];
  if(!mixSelected.length)$('mixCommonFarms').innerHTML='<span class="muted">Añade al menos un producto.</span>';
  else if(!common.length)$('mixCommonFarms').innerHTML='<div class="alert error">No hay una finca común para todas las variedades.</div>';
  else $('mixCommonFarms').innerHTML=common.map(f=>`<span class="farm-chip">${traffic((mixSelected[0].farmStatus||{})[f])}${esc(f)}</span>`).join('');
}
function searchMix(){
  const term=norm($('mixSearchInput').value),host=$('mixSearchResults');
  if(!term){host.classList.add('hidden');host.innerHTML='';return;}
  const matches=catalog.filter(p=>norm(p.Producto).includes(term)||norm(p['Categoría']).includes(term)).filter(p=>!mixSelected.some(x=>x.id===p.id)).slice(0,12);
  host.innerHTML=matches.length?matches.map(p=>{const src=safeUrl(p.images?.[0]?.src);return `<div class="mix-result" data-add-mix="${esc(p.id)}"><span class="mini-thumb">${src?`<img src="${esc(src)}" alt="">`:'✿'}</span><span><strong>${esc(p.Producto)}</strong><br><small class="muted">${esc(p['Categoría'])} · ${(p.Fincas||[]).map(esc).join(', ')}</small></span></div>`;}).join(''):'<div class="mix-result muted">No se encontraron productos.</div>';
  host.classList.remove('hidden');
}
async function refreshCatalogForRole(){
  const response=await fetch('/api/catalog',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('No se pudo actualizar el catálogo autenticado.');
  const data=await response.json();
  catalog=prepareCatalogProducts(data.products||[]);
  farms=data.farms||farms;
  renderAllFilters();
  applyFilters();
}
async function loadStaticCatalogForRole(role){
  const filename=role==='admin'?'catalog-commercial.json':'catalog-public.json';
  const response=await fetch(`${APP_BASE}${filename}`,{cache:'no-store'});
  if(!response.ok)throw new Error(`No se pudo cargar ${filename}.`);
  const data=await response.json();
  catalog=prepareCatalogProducts(data.products||[]);
  farms=data.farms||farms;
  localMode=true;
  $('footerStatus').textContent='Catálogo Flowerpedia';
  renderAllFilters();
  applyFilters();
}
async function loadCatalog(){
  $('statusLine').textContent='Cargando catálogo…';
  if(!LOCAL_WEB){
    document.body.classList.add('public-static');
    $('footerStatus').textContent='Acceso requerido';

    try{
      const state=await window.FlowerpediaAuth.init();
      currentUser=state.user;
      currentProfile=state.profile;
      currentRole=state.profile?.role||'guest';

      if(currentUser){
        try{
          await loadStaticCatalogForRole(currentRole);
          $('footerStatus').textContent='Catálogo Flowerpedia';
        }catch(error){
          $('statusLine').textContent=`No se pudo cargar el catálogo: ${error.message}`;
        }
        setAuthGate(false);
      }else{
        $('statusLine').textContent='Inicia sesión para consultar el catálogo.';
        setAuthGate(true);
      }
    }catch(error){
      currentUser=null;currentProfile=null;currentRole='guest';
      $('statusLine').textContent='No se pudo restaurar la sesión. Inicia sesión para continuar.';
      $('staffLoginError').textContent='No se pudo recuperar tu sesión guardada. Vuelve a iniciar sesión.';
      $('staffLoginError').classList.remove('hidden');
      setAuthGate(true);
    }

    authReady=true;
    renderUserArea();
    return;
  }

  document.body.classList.remove('public-static');
  const auth=window.FlowerpediaAuth;
  const sessionPromise=auth?.configured
    ? auth.init().then(state=>{
        currentUser=state.user;currentProfile=state.profile;currentRole=state.profile?.role||'guest';
        setAuthGate(!currentUser);renderUserArea();return {state};
      }).catch(error=>{
        $('staffLoginError').textContent='No se pudo verificar tu sesión. Comprueba la conexión y vuelve a intentarlo.';
        $('staffLoginError').classList.remove('hidden');setAuthGate(true);return {error};
      })
    : Promise.resolve({error:new Error('No se pudo inicializar el acceso de Flowerpedia.')});

  let catalogError=null;
  try{
    const response=await fetch('/api/catalog',{cache:'no-store',credentials:'same-origin'});
    if(!response.ok)throw new Error('No se pudo consultar el catálogo del servidor');
    const data=await response.json();catalog=prepareCatalogProducts(data.products||[]);farms=data.farms||[];localMode=false;
    $('footerStatus').textContent='Catálogo Flowerpedia';
  }catch(error){catalogError=error;}
  const sessionResult=await sessionPromise;
  if(catalogError)$('statusLine').textContent=`No se pudo cargar el catálogo: ${catalogError.message}`;
  if(sessionResult.error){
    console.error('[Flowerpedia] No se pudo restaurar la sesión:',sessionResult.error);
    $('staffLoginError').textContent='No se pudo verificar tu sesión. Comprueba la conexión y vuelve a intentarlo.';
    $('staffLoginError').classList.remove('hidden');setAuthGate(true);
  }else{
    const state=sessionResult.state;currentUser=state.user;currentProfile=state.profile;currentRole=state.profile?.role||'guest';
    setAuthGate(!currentUser);
  }
  authReady=true;renderUserArea();renderAllFilters();applyFilters();
  if(currentUser){
    const product=productFromLocation();
    if(product)openDetails(product,{pushHistory:false});else if(isProductRoute())showProductNotFound();
  }
}
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>setModal(b.dataset.close,false)));
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{
    if(e.target===m&&m.id!=='staffLoginModal')setModal(m.id,false);
  }));
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;
    const activeModal=[...document.querySelectorAll('.modal.active')].find(m=>m.id!=='staffLoginModal');
    if(activeModal){setModal(activeModal.id,false);return;}
    if(productPageOpen)closeProductPage();
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
    if(!e.target.closest('.filter-menu-wrap'))document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
    const check=e.target.closest('input[data-filter-type]');
    if(check){if(productPageOpen){history.pushState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}const type=check.dataset.filterType;if(check.checked)selectedFilters[type].push(check.value);else selectedFilters[type]=selectedFilters[type].filter(x=>norm(x)!==norm(check.value));renderFilter(type);applyFilters();saveCatalogView();}
    const remove=e.target.closest('[data-remove-filter]');
    if(remove){if(productPageOpen){history.pushState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}const type=remove.dataset.removeFilter,value=remove.dataset.value;selectedFilters[type]=selectedFilters[type].filter(x=>norm(x)!==norm(value));renderFilter(type);applyFilters();saveCatalogView();}
    const quick=e.target.closest('[data-quick-filter]');
    if(quick){const type=quick.dataset.quickFilter,value=quick.dataset.filterValue;quickFilter(type,value);}
    const add=e.target.closest('[data-add-mix]');
    if(add){const p=catalog.find(x=>x.id===add.dataset.addMix);if(p)mixSelected.push(p);$('mixSearchInput').value='';$('mixSearchResults').classList.add('hidden');renderMix();}
    const rem=e.target.closest('[data-remove-mix]');
    if(rem){mixSelected=mixSelected.filter(x=>x.id!==rem.dataset.removeMix);renderMix();}
    const thumb=e.target.closest('[data-gallery-index]');
    if(thumb){galleryIndex=Number(thumb.dataset.galleryIndex)||0;renderGallery();}
  });
  $('searchInput').addEventListener('input',()=>{
    if(productPageOpen){history.pushState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer=setTimeout(()=>{applyFilters();saveCatalogView();},90);
  });
  $('clearFiltersButton').addEventListener('click',()=>{
    if($('clearFiltersButton').disabled)return;
    if(productPageOpen){history.pushState({flowerpediaCatalog:true},'',APP_BASE);showCatalogPage(false);}
    selectedFilters={category:[],farm:[],color:[],season:[]};$('searchInput').value='';
    renderAllFilters();applyFilters();saveCatalogView();document.querySelectorAll('.filter-wrap').forEach(w=>w.classList.remove('open'));
  });
  $('loadMoreButton').addEventListener('click',()=>{visibleCount+=72;renderGrid();});
  restoreCatalogView();
  const gridColumns=$('gridColumns');
  function applyGridColumns(){
    const selected=Number(gridColumns.value)||6,width=window.innerWidth;
    const effective=width<=720?Math.min(selected,2):width<=980?Math.min(selected,3):width<=1300?Math.min(selected,5):selected;
    document.documentElement.style.setProperty('--grid-columns',String(effective));
    document.documentElement.style.setProperty('--related-columns',String(selected));
    $('columnsValue').textContent=String(selected);
    $('columnsDecrease').disabled=selected<=5;
    $('columnsIncrease').disabled=selected>=10;
  }
  function changeGridColumns(delta){
    const next=Math.max(5,Math.min(10,(Number(gridColumns.value)||6)+delta));
    gridColumns.value=String(next);
    applyGridColumns();
    if(currentProduct)renderRelatedProducts(currentProduct);
    saveCatalogView();
  }
  applyGridColumns();
  $('columnsDecrease').addEventListener('click',()=>changeGridColumns(-1));
  $('columnsIncrease').addEventListener('click',()=>changeGridColumns(1));
  gridColumns.addEventListener('change',()=>{applyGridColumns();if(currentProduct)renderRelatedProducts(currentProduct);saveCatalogView();});
  window.addEventListener('resize',applyGridColumns);
  $('galleryPrev').addEventListener('click',()=>{if(!currentProduct)return;galleryIndex=(galleryIndex-1+(currentProduct.images||[]).length)%(currentProduct.images||[]).length;renderGallery();});
  $('galleryNext').addEventListener('click',()=>{if(!currentProduct)return;galleryIndex=(galleryIndex+1)%(currentProduct.images||[]).length;renderGallery();});
  $('mixBoxButton').addEventListener('click',()=>{mixSelected=[];$('mixSearchInput').value='';renderMix();setModal('mixBoxModal');$('mixSearchInput').focus();});
  $('mixSearchInput').addEventListener('input',searchMix);
  $('farmArrivalButton').addEventListener('click',renderArrivals);
  document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>{activeMarket=b.dataset.market;document.querySelectorAll('[data-market]').forEach(x=>x.classList.toggle('active',x===b));renderPriceTable();saveCatalogView();}));
  $('profileButton').addEventListener('click',()=> $('profileMenu').classList.toggle('hidden'));
  $('backToCatalog').addEventListener('click',e=>{e.preventDefault();closeProductPage();});
  $('copyProductLinkButton').addEventListener('click',copyProductLink);
  window.addEventListener('popstate',handleLocationChange);
  document.addEventListener('click',e=>{if(!e.target.closest('.profile-area'))$('profileMenu').classList.add('hidden');});
  $('staffLoginButton').addEventListener('click',()=>openAuthModal());
  $('staffLoginForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const error=$('staffLoginError');error.classList.add('hidden');
    const submit=$('staffLoginForm').querySelector('button[type="submit"]');
    submit.disabled=true;submit.textContent='Comprobando…';
    try{
      const state=await window.FlowerpediaAuth.signIn($('staffUsername').value.trim(),$('staffPassword').value);
      currentUser=state.user;currentProfile=state.profile;currentRole=state.profile?.role||'user';
      $('staffPassword').value='';
      if(LOCAL_WEB) await refreshCatalogForRole();
      else await loadStaticCatalogForRole(currentRole);
      renderUserArea();
      setAuthGate(false);
      if(isProductRoute()){const product=productFromLocation();if(product)openDetails(product,{pushHistory:false});else showProductNotFound();}
    }catch(err){
      error.textContent=err.message||'No se pudo iniciar sesión.';
      error.classList.remove('hidden');
    }finally{
      submit.disabled=false;submit.textContent='Iniciar sesión';
    }
  });
  loadCatalog();
});
