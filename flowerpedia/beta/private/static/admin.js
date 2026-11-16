const csrfToken=document.querySelector('meta[name="csrf-token"]')?.content||'';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=v=>String(v??'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(',','.'));return Number.isFinite(n)?n:null;};
const roundUp2=v=>Math.ceil((Number(v)-1e-9)*100)/100;
let data={products:[],boxes:[],farms:[],options:{},settings:{},compositions:{}};
let currentEdit=null,currentProductKey='',currentImages=[],previewIndex=0,currentIdentity={category:'',product:''};
let usLastEdited='price',ukLastEdited='price',dragImageIndex=null;

async function api(url,options={}){
  const headers=new Headers(options.headers||{});
  if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))headers.set('X-CSRF-Token',csrfToken);
  if(options.body&&!(options.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const res=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const json=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(json.error||`Error ${res.status}`);
  return json;
}
function notice(message,type='success'){
  const el=$('adminNotice');el.textContent=message;el.className=`alert ${type}`;el.classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});setTimeout(()=>el.classList.add('hidden'),7500);
}
function switchTab(tab){
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===tab));
  document.querySelectorAll('.admin-panel').forEach(p=>p.classList.toggle('active',p.id===`panel-${tab}`));
  if(tab==='editor')updateCalculations();
}
function unique(values){
  const m=new Map();(values||[]).filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').forEach(v=>{if(!m.has(norm(v)))m.set(norm(v),String(v).trim());});
  return [...m.values()].sort((a,b)=>a.localeCompare(b,'es'));
}
function fillSelect(id,values,placeholder,selected=''){
  const el=$(id);if(!el)return;
  const vals=unique(values);if(selected&&!vals.some(v=>norm(v)===norm(selected)))vals.unshift(String(selected));
  el.innerHTML=`<option value="">${esc(placeholder)}</option>`+vals.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if(selected)el.value=vals.find(v=>norm(v)===norm(selected))||'';
}
function boxByName(name){return data.boxes.find(b=>norm(b.Nombre)===norm(name));}
function boxDimensions(box){
  if(!box)return '—';
  return `${Number(box.Largo).toFixed(1)} × ${Number(box.Ancho).toFixed(1)} × ${Number(box.Alto).toFixed(1)} cm`;
}
function boxWeight(box){return num(box?.Peso);}
function effectiveBoxWeight(box){
  if(!box)return null;
  const [l,w,h]=[num(box.Largo),num(box.Ancho),num(box.Alto)];
  if([l,w,h].some(x=>x===null))return null;
  const margin=num(box.U2);
  const standard=['EB','QB','HB','SB','EB2','QB2','EB UK','QB UK','HB UK','SB UK','EB2 UK','QB2 UK'].includes(String(box.Nombre||'').toUpperCase());
  const extra=standard?0:(margin===null?(num(data.settings.safety_margin_cm)??2):margin);
  return (l+extra)*(w+extra)*(h+extra)/6000;
}
function boxType(name){
  const s=String(name||'').toUpperCase();
  if(['EB','QB','HB','SB','EB2','QB2'].includes(s))return 'Base USA';
  if(['EB UK','QB UK','HB UK','SB UK','EB2 UK','QB2 UK'].includes(s))return 'Base UK';
  return 'Caja de finca';
}
function boxDisplay(name){
  const box=boxByName(name);if(!box)return name||'';
  return `${name} · ${boxDimensions(box)} · ${Number(effectiveBoxWeight(box)||0).toFixed(3)}`;
}
function sem(status,label=''){
  const s=String(status??'').trim().toLowerCase(),cls=s==='y'?'y':s==='n'?'n':'off';
  const text=label||(s==='y'?'Aprobado':s==='n'?'No aprobado':'Sin dato');
  return `<span class="inline-semaphore"><i class="traffic ${cls}"></i><small>${esc(text)}</small></span>`;
}
function percent(value){
  if(value===null||value===undefined||value==='')return '—';
  if(value==='BAJO'||value==='ALTO')return value;
  const n=Number(value);return Number.isFinite(n)?`${(n*100).toFixed(2)}%`:'—';
}
function money(value,currency='USD'){
  if(value===null||value===undefined||value==='')return '—';
  const n=Number(value);return Number.isFinite(n)?new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(n):esc(value);
}
function showStats(){
  const s=data.stats||{};
  $('adminStats').innerHTML=[['Registros',s.rows||0],['Productos',s.products||0],['Cajas',s.boxes||0],['Fincas',s.farms||0]]
    .map(([name,value])=>`<div class="stat-card"><span>${name}</span><strong>${Number(value).toLocaleString('es')}</strong></div>`).join('');
  $('activeWorkbook').textContent=data.source_filename||'current_week.xlsx';
  $('workbookFilename').textContent=data.source_filename||'current_week.xlsx';
  $('syncTimestamp').textContent=`Última consulta: ${new Date().toLocaleTimeString()}`;
}
function populateListFilters(){
  fillSelect('adminFarmFilter',data.farms.map(f=>f.Nombre),'Todas las fincas');
  fillSelect('adminCategoryFilter',data.products.map(p=>p['Categoría']),'Todas las categorías');
  fillSelect('adminColorFilter',data.products.flatMap(p=>[p['Color 1'],p['Color 2']]),'Todos los colores');
}
function productImage(row){
  const img=row._images?.[0]?.src;
  return img?`<img class="admin-thumb" src="${esc(img)}" alt="">`:'<div class="admin-thumb" style="display:grid;place-items:center;color:#789078">✿</div>';
}
function productBoxRank(row){
  const name=String(row['Caja EC']||row['Caja UK']||'').replace(/\s+UK$/i,'').trim().toUpperCase();
  const order=['SB','EB','QB','HB','EB2','QB2'];
  const index=order.indexOf(name);
  return index<0?99:index;
}
function productSizeRank(value){
  const match=String(value||'').match(/\d+(?:[.,]\d+)?/);
  return match?Number(match[0].replace(',','.')):9999;
}
function renderProductList(){
  const q=norm($('adminProductSearch').value),farm=$('adminFarmFilter').value,cat=$('adminCategoryFilter').value,color=$('adminColorFilter').value;
  const rows=data.products.filter(p=>{
    if(q&&!norm([p.Producto,p['Categoría'],p.Finca,p.Tamaño,p['Caja EC'],p['Caja Finca'],p['Caja UK']].join(' ')).includes(q))return false;
    if(farm&&norm(p.Finca)!==norm(farm))return false;
    if(cat&&norm(p['Categoría'])!==norm(cat))return false;
    if(color&&![p['Color 1'],p['Color 2']].some(x=>norm(x)===norm(color)))return false;
    return true;
  }).sort((a,b)=>{
    const byFarm=norm(a.Finca).localeCompare(norm(b.Finca),'es');if(byFarm)return byFarm;
    const byBox=productBoxRank(a)-productBoxRank(b);if(byBox)return byBox;
    const bySize=productSizeRank(a.Tamaño)-productSizeRank(b.Tamaño);if(bySize)return bySize;
    return norm(a.Producto).localeCompare(norm(b.Producto),'es');
  });
  const shown=rows.slice(0,250);
  const groups=new Map();
  shown.forEach(p=>{const key=p.Finca||'Sin finca';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);});
  const host=$('adminProductTables');
  const headers='<tr><th>Imagen</th><th>Categoría</th><th>Producto</th><th>Empaque</th><th>Caja EC / OP</th><th>Compra</th><th>Markup USA</th><th>Venta USA</th><th>Caja UK / OP UK</th><th>Compra UK</th><th>Markup UK</th><th>Venta UK</th><th></th></tr>';
  host.innerHTML=[...groups.entries()].map(([farmName,items])=>{
    const arrival=String(items[0]?._FarmArrival||'').toLowerCase();
    const status=arrival==='y'?'y':arrival==='n'?'n':'off';
    const tableRows=items.map(p=>`
      <tr>
        <td>${productImage(p)}</td>
        <td>${esc(p['Categoría']||'—')}</td><td><strong>${esc(p.Producto||'—')}</strong></td><td>${esc(p.Tamaño||'—')}</td>
        <td><div class="inline-semaphore"><i class="traffic ${p.Op==='y'?'y':p.Op==='n'?'n':'off'}"></i>${esc(p['Caja EC']||'—')}</div></td>
        <td>${money(p.Compra,'USD')}</td><td>${percent(p.Markup)}</td><td><strong>${money(p.Venta,'USD')}</strong></td>
        <td><div class="inline-semaphore"><i class="traffic ${p['Op UK']==='y'?'y':p['Op UK']==='n'?'n':'off'}"></i>${esc(p['Caja UK']||'—')}</div></td>
        <td>${money(p['Compra UK']??p.Compra,'USD')}</td><td>${percent(p['Markup UK'])}</td><td><strong>${money(p['Venta UK'],'GBP')}</strong></td>
        <td><div class="row-actions"><button class="icon-btn" data-edit-product="${esc(p._id)}">Editar</button><button class="icon-btn danger" data-delete-product="${esc(p._id)}">×</button></div></td>
      </tr>`).join('');
    return `<section class="farm-product-group">
      <div class="farm-product-heading"><span class="inline-semaphore"><i class="traffic ${status}"></i></span><h3>${esc(farmName)}</h3><span class="tiny muted">${items.length} registros</span></div>
      <div class="table-scroll"><table class="data-table product-admin-table"><thead>${headers}</thead><tbody>${tableRows}</tbody></table></div>
    </section>`;
  }).join('')||'<p class="muted">No se encontraron registros.</p>';
  $('productListCount').textContent=`Mostrando ${shown.length} de ${rows.length} registros coincidentes${rows.length>250?' · ajusta los filtros para ver más':''}.`;
}

function populateProductSelects(row={}){
  const boxNames=data.boxes.map(b=>b.Nombre);
  fillSelect('pFinca',data.farms.map(f=>f.Nombre),'Selecciona finca',row.Finca);
  fillSelect('pCategory',[...(data.options['Categoría']||[]),...data.products.map(p=>p['Categoría'])],'Selecciona categoría',row['Categoría']);
  fillSelect('pSize',[...(data.options['Tamaño']||[]),...data.products.map(p=>p.Tamaño)],'Selecciona empaque',row.Tamaño);
  const colors=[...(data.options.Color||[]),...data.products.flatMap(p=>[p['Color 1'],p['Color 2']])];
  fillSelect('pColor1',colors,'Sin color',row['Color 1']);
  fillSelect('pColor2',colors,'Sin segundo color',row['Color 2']);
  fillSelect('pSeason',[...(data.options.Season||[]),...data.products.map(p=>p.Season)],'Sin temporada',row.Season);
  setVal('pAvailability',row.Disponibilidad||'Disponible');
  fillSelect('pUsBox',STANDARD_US.filter(x=>boxByName(x)),'Selecciona caja base',row['Caja EC']);
  fillSelect('pUkBox',STANDARD_UK.filter(x=>boxByName(x)),'Selecciona caja UK',row['Caja UK']);
  const farmBoxes=boxNames.filter(n=>boxType(n)==='Caja de finca');
  fillSelect('pFarmBox',farmBoxes,'Selecciona caja de finca',row['Caja Finca']);
  fillSelect('pFarmBoxUK',farmBoxes,'Selecciona caja de finca',row['Caja Finca']);
}
const STANDARD_US=['EB','QB','HB','SB','EB2','QB2'];
const STANDARD_UK=STANDARD_US.map(x=>`${x} UK`);
function setVal(id,value){$(id).value=value===null||value===undefined?'':value;}
function clearForm(){
  currentEdit=null;currentProductKey='';currentImages=[];previewIndex=0;currentIdentity={category:'',product:''};
  $('editProductId').value='';$('editorTitle').textContent='Añadir producto';
  ['pStems','pName','pComposition','pUsCost','pUsMarkup','pUsPrice','pUkCost','pUkMarkup','pUkPrice'].forEach(id=>setVal(id,''));
  ['pFinca','pCategory','pSize','pColor1','pColor2','pSeason','pUsBox','pFarmBox','pUkBox','pFarmBoxUK'].forEach(id=>setVal(id,''));
  populateProductSelects();setVal('pAvailability','Disponible');renderCompositionRows([]);renderImageManager();usLastEdited='price';ukLastEdited='price';updateCalculations();
}
function editProduct(id){
  const row=data.products.find(p=>p._id===id);if(!row)return;
  currentEdit=id;currentProductKey=row._productKey;currentIdentity={category:row['Categoría']||'',product:row.Producto||''};currentImages=(row._images||[]).map(x=>({...x}));previewIndex=0;
  $('editProductId').value=id;$('editorTitle').textContent=`Editar ${row.Producto||'producto'} · ${row.Finca||''}`;
  populateProductSelects(row);
  setVal('pStems',row['Total Tallos']);setVal('pName',row.Producto);setVal('pComposition',row.Composición);setVal('pAvailability',row.Disponibilidad||'Disponible');
  setVal('pUsCost',row.Compra);setVal('pUsPrice',row.Venta);setVal('pUsMarkup',row.Markup==='BAJO'||row.Markup==='ALTO'?'':row.Markup==null?'':(Number(row.Markup)*100).toFixed(2));
  setVal('pUkCost',row['Compra UK']);setVal('pUkPrice',row['Venta UK']);setVal('pUkMarkup',row['Markup UK']==='BAJO'||row['Markup UK']==='ALTO'?'':row['Markup UK']==null?'':(Number(row['Markup UK'])*100).toFixed(2));
  const composition=data.compositions?.[row._productKey]||[];
  renderCompositionRows(composition);renderImageManager();
  usLastEdited='price';ukLastEdited='price';updateCalculations();
  switchTab('editor');
}
function sizeNum(value){const n=parseFloat(String(value||'').replace(',','.'));return Number.isFinite(n)?n:9999;}
function renderCompositionRows(rows){
  const host=$('compositionRows');
  host.innerHTML=(rows||[]).map((r,i)=>compositionRowHtml(r,i)).join('');
  if(!rows?.length)host.innerHTML=compositionRowHtml({variety:'',stems:0,price:0},0);
  updateCompositionTotals();
}
function compositionRowHtml(row,i){
  const variety=row.variety??row.Variedad??'',stems=row.stems??row.Tallos??0,price=row.price??row.Precio??0;
  return `<tr data-composition-row="${i}">
    <td><input class="comp-variety" value="${esc(variety)}" placeholder="Nombre de variedad"></td>
    <td><input class="comp-stems" type="number" min="0" step="1" value="${esc(stems)}"></td>
    <td><input class="comp-price" type="number" min="0" step="0.0001" value="${esc(price)}"></td>
    <td class="num comp-total">${(Number(stems)||0)*(Number(price)||0)?((Number(stems)||0)*(Number(price)||0)).toFixed(2):'0.00'}</td>
    <td><button class="icon-btn danger" type="button" data-remove-composition="${i}">×</button></td>
  </tr>`;
}
function getCompositionRows(){
  return [...$('compositionRows').querySelectorAll('tr')].map(tr=>({
    variety:tr.querySelector('.comp-variety').value.trim(),
    stems:num(tr.querySelector('.comp-stems').value)||0,
    price:num(tr.querySelector('.comp-price').value)||0
  })).filter(x=>x.variety);
}
function updateCompositionTotals(){
  const rows=[...$('compositionRows').querySelectorAll('tr')];let stems=0,total=0;
  rows.forEach(tr=>{
    const s=num(tr.querySelector('.comp-stems').value)||0,p=num(tr.querySelector('.comp-price').value)||0,t=s*p;
    stems+=s;total+=t;tr.querySelector('.comp-total').textContent=t.toFixed(2);
  });
  const avg=stems?total/stems:0;
  $('compositionTotals').innerHTML=`<tr><td>TOTAL</td><td class="num">${stems}</td><td class="num">${avg.toFixed(2)}</td><td class="num">${total.toFixed(2)}</td><td></td></tr>`;
}
function addCompositionRow(){const rows=getCompositionRows();rows.push({variety:'',stems:0,price:0});renderCompositionRows(rows);}
function getSelectedBoxInfo(id){
  const box=boxByName($(id).value);
  if(!box)return null;
  return box;
}
function updateBoxHints(){
  const ec=getSelectedBoxInfo('pUsBox'),farm=getSelectedBoxInfo('pFarmBox'),uk=getSelectedBoxInfo('pUkBox');
  $('usBoxInfo').textContent=ec?`${boxDimensions(ec)} · peso ${Number(effectiveBoxWeight(ec)||0).toFixed(3)}`:'';
  const farmU2=farm?(boxType(farm.Nombre)==='Caja de finca'?(num(farm.U2)??num(data.settings.safety_margin_cm)??2):0):0;
  $('farmBoxInfo').textContent=farm?`${boxDimensions(farm)} · peso ${Number(effectiveBoxWeight(farm)||0).toFixed(3)} · U2 aplicado ${farmU2.toFixed(1)} cm`:'';
  $('ukBoxInfo').textContent=uk?`${boxDimensions(uk)} · peso ${Number(effectiveBoxWeight(uk)||0).toFixed(3)}`:'';
}
function usCost(){
  const box=boxByName($('pUsBox').value),stems=num($('pStems').value),cost=num($('pUsCost').value);
  if(!box||!stems||stems<=0||cost===null)return null;
  const [l,w,h]=[num(box.Largo),num(box.Ancho),num(box.Alto)];
  if([l,w,h].some(x=>x===null))return null;
  const volume=effectiveBoxWeight(box);
  const transportTotal=roundUp2(volume*(num(data.settings.us_transport_volume_rate)||5.25)*(num(data.settings.us_transport_multiplier)||1.36));
  const transport=roundUp2(transportTotal/stems),duties=roundUp2(cost*(num(data.settings.us_duties_rate)||0.1586));
  return {total:cost+duties+transport,transport,duties,volume};
}
function ukCost(){
  const box=boxByName($('pUkBox').value),stems=num($('pStems').value);
  let purchase=num($('pUkCost').value);if(purchase===null)purchase=num($('pUsCost').value);
  if(!box||!stems||stems<=0||purchase===null)return null;
  const [l,w,h]=[num(box.Largo),num(box.Ancho),num(box.Alto)];if([l,w,h].some(x=>x===null))return null;
  const volume=l*w*h/6000,transportTotal=roundUp2(volume*(num(data.settings.uk_transport_volume_rate)||3.2)*(num(data.settings.uk_transport_multiplier)||1.1));
  const transport=roundUp2(transportTotal/stems),costGBP=purchase/(num(data.settings.uk_exchange_rate)||1.26);
  return {total:roundUp2(costGBP+transport),transport,costGBP,volume};
}
function compareUS(){
  const base=boxByName($('pUsBox').value),farm=boxByName($('pFarmBox').value);
  if(!base||!farm||effectiveBoxWeight(base)===null||effectiveBoxWeight(farm)===null)return {status:'',delta:null};
  return {status:effectiveBoxWeight(farm)<=effectiveBoxWeight(base)?'y':'n',delta:effectiveBoxWeight(farm)-effectiveBoxWeight(base)};
}
function compareUK(){
  const base=boxByName($('pUkBox').value),farm=boxByName($('pFarmBox').value);
  if(!base||!farm)return {status:'',delta:null};
  const capacity=num(base.Largo)*num(base.Ancho)*num(base.Alto)/6000,weight=effectiveBoxWeight(farm);
  if(!Number.isFinite(capacity)||weight===null)return {status:'',delta:null};
  return {status:weight<=capacity?'y':'n',delta:weight-capacity};
}
function setSemaphore(id,status,delta){
  const el=$(id),cls=status==='y'?'y':status==='n'?'n':'off';
  const label=status==='y'?'OP aprobado':status==='n'?'OP no aprobado':'OP sin comparar';
  const hasDelta=delta!==null&&delta!==undefined&&Number.isFinite(Number(delta));
  const value=hasDelta?`${Number(delta)>0?'+':''}${Number(delta).toFixed(3)}`:'—';
  const deltaClass=hasDelta?(Number(delta)>0?'excess':Number(delta)<0?'margin':'exact'):'';
  el.innerHTML=`<i class="traffic ${cls}" aria-hidden="true"></i><span class="op-preview-delta ${deltaClass}">${value}</span>`;
  el.setAttribute('aria-label',`${label}${hasDelta?`: ${value}`:''}`);
  el.title=label;
}
function setOpHeader(id,status,label){
  const el=$(id),cls=status==='y'?'y':status==='n'?'n':'off';
  const state=status==='y'?'approved':status==='n'?'rejected':'pending';
  el.className=`op-heading-status ${state}`;
  el.innerHTML=`<i class="traffic ${cls}"></i><span>${label}</span>`;
}
function updateCalculations(market='both',source='other'){
  const stems=num($('pStems').value);
  const us=usCost(),uc=compareUS();
  setSemaphore('usSemaphore',uc.status,uc.delta);
  setOpHeader('usOpStatus',uc.status,'OP USA');
  const uk=ukCost(),ukc=compareUK();
  setSemaphore('ukSemaphore',ukc.status,ukc.delta);
  setOpHeader('ukOpStatus',ukc.status,'OP UK');
  if(market==='both'||market==='us'){
    if(source==='usMarkup'||(source==='other'&&usLastEdited==='markup')){
      const target=num($('pUsMarkup').value);
      if(us&&target!==null&&target>=0&&target<100){
        const price=us.total/((num(data.settings.us_sale_factor)||.96)*(1-target/100));
        $('pUsPrice').value=roundUp2(price).toFixed(2);
      }else if(source==='usMarkup')$('pUsPrice').value='';
    }else{
      const price=num($('pUsPrice').value);
      if(us&&price!==null&&price>0){const mark=1-us.total/(price*(num(data.settings.us_sale_factor)||.96));$('pUsMarkup').value=(mark*100).toFixed(2);}
      else if(source==='usPrice'||source==='other')$('pUsMarkup').value='';
    }
    $('usCalcResult').textContent=us?`Transporte/tallo $${us.transport.toFixed(2)} · Duties $${us.duties.toFixed(2)} · Coste calculado $${us.total.toFixed(2)} · ${stems||0} tallos`:'Completa Caja EC, Tallos y Compra para calcular el markup.';
  }
  if(market==='both'||market==='uk'){
    if(source==='ukMarkup'||(source==='other'&&ukLastEdited==='markup')){
      const target=num($('pUkMarkup').value);
      if(uk&&target!==null&&target>=0&&target<100){
        const price=uk.total/((num(data.settings.uk_sale_factor)||.97)*(1-target/100));
        $('pUkPrice').value=roundUp2(price).toFixed(2);
      }else if(source==='ukMarkup')$('pUkPrice').value='';
    }else{
      const price=num($('pUkPrice').value);
      if(uk&&price!==null&&price>0){const mark=1-uk.total/(price*(num(data.settings.uk_sale_factor)||.97));$('pUkMarkup').value=(mark*100).toFixed(2);}
      else if(source==='ukPrice'||source==='other')$('pUkMarkup').value='';
    }
    $('ukCalcResult').textContent=uk?`Transporte/tallo £${uk.transport.toFixed(2)} · Compra convertida £${uk.costGBP.toFixed(2)} · Coste calculado £${uk.total.toFixed(2)} · ${stems||0} tallos`:'Completa Caja UK, Tallos y Compra para calcular el markup.';
  }
  updateBoxHints();
}
function buildProductPayload(){
  const row={
    Finca:$('pFinca').value,ID:null,'Categoría':$('pCategory').value,Producto:$('pName').value.trim(),
    Composición:$('pComposition').value.trim(),'Color 1':$('pColor1').value,'Color 2':$('pColor2').value,
    Season:$('pSeason').value,Disponibilidad:$('pAvailability').value||'Disponible',Tamaño:$('pSize').value,Tabla:null,IMG:null,
    'Caja EC':$('pUsBox').value,Op:compareUS().status,'Caja Finca':$('pFarmBox').value,
    'Total Tallos':num($('pStems').value),Compra:num($('pUsCost').value),Markup:null,Venta:num($('pUsPrice').value),
    'Caja UK':$('pUkBox').value,'Op UK':compareUK().status,'Compra UK':num($('pUkCost').value),'Markup UK':null,'Venta UK':num($('pUkPrice').value),
    composition:getCompositionRows()
  };
  const us=usCost(),up=num($('pUsPrice').value);
  if(us&&up&&up>0)row.Markup=1-us.total/(up*(num(data.settings.us_sale_factor)||.96));
  const uk=ukCost(),kp=num($('pUkPrice').value);
  if(uk&&kp&&kp>0)row['Markup UK']=1-uk.total/(kp*(num(data.settings.uk_sale_factor)||.97));
  return row;
}
function renderImageManager(){
  const host=$('adminThumbnails'),images=currentImages||[];
  const active=images[previewIndex]||images[0];
  $('adminMainPreview').innerHTML=active?`<img src="${esc(active.src)}" alt="Imagen principal">`:'<span>✿</span>';
  host.innerHTML=images.map((img,i)=>`<div class="admin-thumb-item ${i===previewIndex?'active':''}" draggable="true" data-image-index="${i}">
    <img src="${esc(img.src)}" alt="">
    <div class="thumb-controls"><button type="button" data-image-up="${i}" title="Mover a la izquierda">‹</button><button type="button" data-image-down="${i}" title="Mover a la derecha">›</button><button type="button" class="remove" data-image-delete="${i}" title="Eliminar">×</button></div>
  </div>`).join('')||'<span class="tiny muted">Todavía no hay imágenes para este producto.</span>';
}
async function persistImageOrder(){
  if(!currentProductKey)return;
  try{
    const result=await api(`/api/admin/media/${encodeURIComponent(currentProductKey)}`,{method:'PUT',body:JSON.stringify({paths:currentImages.map(x=>x.path)})});
    currentImages=result.images||[];previewIndex=0;renderImageManager();notice('Orden de imágenes actualizado.');
  }catch(e){notice(e.message,'error');}
}
async function uploadImages(files){
  if(!files.length)return;
  const category=$('pCategory').value,product=$('pName').value.trim();
  if(!category||!product){notice('Primero completa Categoría y Producto, y guarda el registro.','error');return;}
  if(!currentProductKey||norm(currentIdentity.category)!==norm(category)||norm(currentIdentity.product)!==norm(product)){
    notice('Guarda primero los cambios de categoría o producto antes de subir imágenes.','error');return;
  }
  const key=currentProductKey;
  const form=new FormData();form.append('category',category);form.append('product',product);
  [...files].forEach(f=>form.append('images',f));
  try{
    const result=await api(`/api/admin/media/${encodeURIComponent(key)}`,{method:'POST',body:form});
    currentProductKey=key;currentImages=result.images||[];previewIndex=Math.max(0,currentImages.length-files.length);renderImageManager();
    notice(`${files.length} imagen(es) subida(s). Se comparten con todos los empaques de ${product}.`);
    await loadAdminData(false);
  }catch(e){notice(e.message,'error');}
}
async function saveProduct(e){
  e.preventDefault();
  try{
    updateCalculations('both','other');
    const payload=buildProductPayload();
    if(!payload.Producto)throw new Error('El nombre del producto es obligatorio.');
    let result;
    if(currentEdit)result=await api(`/api/admin/products/${currentEdit}`,{method:'PUT',body:JSON.stringify(payload)});
    else result=await api('/api/admin/products',{method:'POST',body:JSON.stringify(payload)});
    currentEdit=result.id;currentProductKey=result.productKey;currentIdentity={category:payload['Categoría'],product:payload.Producto};$('editProductId').value=result.id;
    notice('Registro guardado y sincronizado con el Excel.');
    await loadAdminData(false);
    const updated=data.products.find(p=>p._id===currentEdit);
    if(updated){currentImages=updated._images||[];renderImageManager();}
    $('editorTitle').textContent=`Editar ${payload.Producto} · ${payload.Finca}`;
    switchTab('products');
  }catch(err){notice(err.message,'error');}
}
async function deleteProduct(id){
  if(!confirm('¿Eliminar este registro del catálogo?'))return;
  try{await api(`/api/admin/products/${id}`,{method:'DELETE'});notice('Registro eliminado del Excel y del catálogo.');await loadAdminData();}
  catch(e){notice(e.message,'error');}
}
function boxPreviewValues(box,u2Input){
  const standard=['EB','QB','HB','SB','EB2','QB2','EB UK','QB UK','HB UK','SB UK','EB2 UK','QB2 UK'].includes(String(box.Nombre||'').toUpperCase());
  const globalU2=num(data.settings.safety_margin_cm)??2;
  const u2=standard?0:(u2Input===null?globalU2:u2Input);
  const l=num(box.Largo),w=num(box.Ancho),h=num(box.Alto);
  const weight=[l,w,h].some(v=>v===null)?null:(l+u2)*(w+u2)*(h+u2)/6000;
  const baseCode=(String(box.Nombre).toUpperCase().match(/QB2|EB2|QB|EB|HB|SB/)||[])[0];
  const upperName=String(box.Nombre||'').toUpperCase();
  const isUkBase=['EB UK','QB UK','HB UK','SB UK','EB2 UK','QB2 UK'].includes(upperName);
  const baseName=isUkBase?`${baseCode} UK`:baseCode;
  const base=baseCode?boxByName(baseName):null;
  const baseWeight=base?effectiveBoxWeight(base):null;
  const status=weight===null||baseWeight===null?'':(weight<=baseWeight?'y':'n');
  const delta=weight===null||baseWeight===null?null:weight-baseWeight;
  return {u2,weight,status,delta,standard};
}
function boxFarmGroup(name){
  const normalized=norm(name);
  const matches=(data.farms||[]).map(f=>String(f.Nombre||'')).filter(Boolean).sort((a,b)=>b.length-a.length);
  return matches.find(f=>normalized.startsWith(norm(f)))||'Otras cajas';
}
function renderBoxes(){
  const q=norm($('boxSearch').value),type=$('boxTypeFilter').value;
  const boxes=data.boxes.filter(b=>(!q||norm(b.Nombre).includes(q))&&(!type||boxType(b.Nombre)===type));
  const systemOrder=['SB','EB','QB','HB','EB2','QB2','SB UK','EB UK','QB UK','HB UK','EB2 UK','QB2 UK'];
  const system=boxes.filter(b=>boxType(b.Nombre)!=='Caja de finca').sort((a,b)=>systemOrder.indexOf(a.Nombre)-systemOrder.indexOf(b.Nombre));
  const farmGroups=new Map();
  boxes.filter(b=>boxType(b.Nombre)==='Caja de finca').forEach(b=>{
    const group=boxFarmGroup(b.Nombre);
    if(!farmGroups.has(group))farmGroups.set(group,[]);
    farmGroups.get(group).push(b);
  });
  const ordered=[...(system.length?[['Cajas del sistema',system]]:[]),...[...farmGroups.entries()].sort((a,b)=>norm(a[0]).localeCompare(norm(b[0]),'es')).map(([name,items])=>[name,items.sort((a,b)=>norm(a.Nombre).localeCompare(norm(b.Nombre),'es'))])];
  const rowsHtml=ordered.map(([groupName,items])=>{
    const rows=items.map(b=>{
      const preview=boxPreviewValues(b,num(b.U2));
      const inputValue=b.U2===null||b.U2===undefined?'':Number(b.U2).toFixed(1);
      const placeholder=Number(data.settings.safety_margin_cm??2).toFixed(1);
      const note=preview.standard?'Caja base · U2 = 0':(b.U2===null||b.U2===undefined?'':'U2 propio');
      return `<tr data-box-row="${esc(b.Nombre)}">
        <td><strong>${esc(b.Nombre)}</strong></td><td>${boxType(b.Nombre)}</td>
        <td>${b.Largo??'—'}</td><td>${b.Ancho??'—'}</td><td>${b.Alto??'—'}</td>
        <td><div class="box-u2-editor"><input class="box-u2-input" type="number" min="0" step="0.1" data-box-u2="${esc(b.Nombre)}" value="${inputValue}" placeholder="${preview.standard?'0':placeholder}" ${preview.standard?'disabled':''}><button class="icon-btn" type="button" data-save-box-u2="${esc(b.Nombre)}" ${preview.standard?'disabled':''}>Guardar</button></div><small class="tiny muted box-u2-note">${note}</small></td>
        <td data-box-weight>${preview.weight===null?'—':preview.weight.toFixed(3)}</td>
        <td data-box-approved>${sem(preview.status)}</td>
        <td data-box-delta>${preview.delta===null?'—':`${preview.delta>0?'+':''}${preview.delta.toFixed(3)}`}</td>
        <td><button class="icon-btn" data-edit-box="${esc(b.Nombre)}">Editar medidas</button></td>
      </tr>`;
    }).join('');
    return `<tr class="box-group-heading"><td colspan="10">${esc(groupName)}</td></tr>${rows}`;
  }).join('');
  $('boxRows').innerHTML=rowsHtml||'<tr><td colspan="10">No hay cajas coincidentes.</td></tr>';
}

function previewBoxU2(input){
  const row=input.closest('[data-box-row]');if(!row)return;
  const box=boxByName(row.dataset.boxRow);if(!box)return;
  const value=num(input.value);
  const preview=boxPreviewValues(box,value);
  const weight=row.querySelector('[data-box-weight]');
  const approved=row.querySelector('[data-box-approved]');
  const delta=row.querySelector('[data-box-delta]');
  if(weight)weight.textContent=preview.weight===null?'—':preview.weight.toFixed(3);
  if(approved)approved.innerHTML=sem(preview.status);
  if(delta)delta.textContent=preview.delta===null?'—':`${preview.delta>0?'+':''}${preview.delta.toFixed(3)}`;
  const note=row.querySelector('.box-u2-note');
  if(note)note.textContent=preview.standard?'Caja base · U2 = 0':(value===null?'':`Vista previa · U2 ${value.toFixed(1)} cm`);
  row.classList.toggle('preview-changed',!preview.standard&&value!==num(box.U2));
}
async function saveBoxU2(name){
  const box=boxByName(name),row=document.querySelector(`[data-box-row="${CSS.escape(name)}"]`);
  if(!box||!row)return;
  const raw=row.querySelector('.box-u2-input').value;
  const value=raw.trim()===''?null:num(raw);
  if(value!==null&&value<0){notice('U2 debe ser cero o mayor.','error');return;}
  try{
    await api(`/api/admin/boxes/${encodeURIComponent(name)}`,{method:'PUT',body:JSON.stringify({Largo:box.Largo,Ancho:box.Ancho,Alto:box.Alto,U2:value})});
    notice(`U2 de ${name} guardado. Peso y semáforos recalculados.`);
    await loadAdminData();
  }catch(e){notice(e.message,'error');}
}
async function editBox(name){
  const b=boxByName(name);if(!b)return;
  const l=prompt(`Largo (cm) · ${name}`,b.Largo);if(l===null)return;
  const w=prompt(`Ancho (cm) · ${name}`,b.Ancho);if(w===null)return;
  const h=prompt(`Alto (cm) · ${name}`,b.Alto);if(h===null)return;
  try{await api(`/api/admin/boxes/${encodeURIComponent(name)}`,{method:'PUT',body:JSON.stringify({Largo:l,Ancho:w,Alto:h})});notice(`Dimensiones de ${name} actualizadas.`);await loadAdminData();}
  catch(e){notice(e.message,'error');}
}
async function createBox(){
  try{
    const result=await api('/api/admin/boxes',{method:'POST',body:JSON.stringify({Nombre:$('newBoxName').value,Largo:$('newBoxLength').value,Ancho:$('newBoxWidth').value,Alto:$('newBoxHeight').value,U2:$('newBoxU2').value===''?null:$('newBoxU2').value})});
    $('newBoxName').value=$('newBoxLength').value=$('newBoxWidth').value=$('newBoxHeight').value=$('newBoxU2').value='';
    notice(`Caja ${result.box.Nombre} creada; peso y semáforo calculados.`);await loadAdminData();
  }catch(e){notice(e.message,'error');}
}
async function saveBoxMargin(){
  const value=num($('boxSafetyMargin').value);if(value===null||value<0){notice('U2 debe ser cero o mayor.','error');return;}
  try{const result=await api('/api/admin/settings',{method:'POST',body:JSON.stringify({safety_margin_cm:value})});data.settings=result.settings;notice('U2 general actualizado en Sheet1!U2. Las cajas con U2 propio mantienen su valor.');await loadAdminData();}
  catch(e){notice(e.message,'error');}
}
async function loadUsers(){
  const result=await api('/api/admin/users');
  const currentId=Number(result.current_user_id);
  $('userRows').innerHTML=result.users.map(u=>{
    const isSelf=Number(u.id)===currentId;
    const avatar=u.avatar_path?`<img src="/avatar/${esc(u.avatar_path)}" alt="">`:'<i class="fi fi-rr-user"></i>';
    return `<tr data-user-row="${u.id}" class="${isSelf?'current-admin-row':''}">
      <td><span class="user-profile-cell"><span class="user-avatar-small">${avatar}</span></span></td>
      <td><strong>${esc(u.username)}</strong>${isSelf?'<span class="current-user-tag">Tu cuenta</span>':''}</td>
      <td><select class="user-role" ${isSelf?'disabled title="No puedes cambiar tu propio rol"':''}><option value="staff" ${u.role==='staff'?'selected':''}>Personal</option><option value="admin" ${u.role==='admin'?'selected':''}>Administrador</option></select></td>
      <td><label class="inline-check"><input class="user-active" type="checkbox" ${u.is_active?'checked':''} ${isSelf?'disabled title="Tu cuenta debe permanecer activa"':''}> Activo</label></td>
      <td><input class="user-password" type="password" minlength="4" placeholder="Nueva contraseña"></td>
      <td><input class="user-avatar-upload" type="file" accept="image/*"></td>
      <td><div class="row-actions"><button class="icon-btn" data-save-user="${u.id}">Guardar</button><button class="icon-btn danger" data-delete-user="${u.id}" ${isSelf?'disabled title="No puedes eliminar tu propia cuenta"':''}>Eliminar</button></div></td>
    </tr>`;
  }).join('')||'<tr><td colspan="7">No hay usuarios.</td></tr>';
}
async function createUser(e){
  e.preventDefault();
  try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({username:$('newUsername').value,password:$('newUserPassword').value,role:$('newUserRole').value})});$('createUserForm').reset();await loadUsers();notice('Usuario creado.');}
  catch(e){notice(e.message,'error');}
}
async function saveUser(id){
  const row=document.querySelector(`[data-user-row="${id}"]`),payload={role:row.querySelector('.user-role').value,is_active:row.querySelector('.user-active').checked};
  const password=row.querySelector('.user-password').value;if(password)payload.password=password;
  try{
    await api(`/api/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(payload)});
    const file=row.querySelector('.user-avatar-upload').files[0];
    if(file){const form=new FormData();form.append('avatar',file);await api(`/api/admin/users/${id}/avatar`,{method:'POST',body:form});}
    await loadUsers();notice('Usuario actualizado.');
  }catch(e){notice(e.message,'error');}
}
async function deleteUser(id){
  if(!confirm('¿Eliminar este usuario?'))return;
  try{await api(`/api/admin/users/${id}`,{method:'DELETE'});await loadUsers();notice('Usuario eliminado.');}
  catch(e){notice(e.message,'error');}
}
async function importWorkbook(e){
  e.preventDefault();const file=$('workbookFile').files[0];if(!file)return;
  const form=new FormData();form.append('workbook',file);
  try{const result=await api('/api/admin/import',{method:'POST',body:form});$('importWorkbookForm').reset();notice(result.message);await loadAdminData();}
  catch(e){notice(e.message,'error');}
}
async function importImages(e){
  e.preventDefault();
  const file=$('imagesArchive').files[0];
  if(!file)return;
  const form=new FormData();form.append('archive',file);
  try{
    const result=await api('/api/admin/media/import-zip',{method:'POST',body:form});
    $('importImagesForm').reset();
    notice(result.message||'Imágenes importadas correctamente.');
    await loadAdminData();
  }catch(error){notice(error.message,'error');}
}
async function saveSettings(e){
  e.preventDefault();
  const keys=['us_transport_volume_rate','us_transport_multiplier','us_duties_rate','us_sale_factor','uk_transport_volume_rate','uk_transport_multiplier','uk_exchange_rate','uk_sale_factor'];
  const payload={};keys.forEach(k=>payload[k]=num($(`setting_${k}`).value));
  try{const result=await api('/api/admin/settings',{method:'POST',body:JSON.stringify(payload)});data.settings=result.settings;notice('Parámetros guardados y sincronizados con Excel.');await loadAdminData();}
  catch(e){notice(e.message,'error');}
}
function populateSettings(){
  Object.entries(data.settings||{}).forEach(([key,value])=>{const el=$(`setting_${key}`);if(el)el.value=value;});
  $('boxSafetyMargin').value=data.settings.safety_margin_cm??2;
}
async function loadAdminData(showNoticeOnError=true){
  try{
    const result=await api('/api/admin/data');data=result;
    $('newProductButton').disabled=!result.workbook_available;
    $('workbookMissingNotice').classList.toggle('hidden',!!result.workbook_available);
    showStats();populateListFilters();renderProductList();renderBoxes();populateProductSelects();populateSettings();
    if($('editProductId').value){const row=data.products.find(p=>p._id===currentEdit);if(row){populateProductSelects(row);currentImages=row._images||[];renderImageManager();}}
  }catch(e){if(showNoticeOnError)notice(e.message,'error');throw e;}
}
function reorderImages(from,to){
  if(from===to||from<0||to<0||from>=currentImages.length||to>=currentImages.length)return;
  const [item]=currentImages.splice(from,1);currentImages.splice(to,0,item);previewIndex=0;renderImageManager();persistImageOrder();
}
document.addEventListener('DOMContentLoaded',async()=>{
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.adminTab)));
  $('newProductButton').addEventListener('click',()=>{clearForm();switchTab('editor');});
  $('cancelEditButton').addEventListener('click',()=>switchTab('products'));
  $('resetProductForm').addEventListener('click',clearForm);
  $('productForm').addEventListener('submit',saveProduct);
  $('adminProductSearch').addEventListener('input',renderProductList);
  ['adminFarmFilter','adminCategoryFilter','adminColorFilter'].forEach(id=>$(id).addEventListener('change',renderProductList));
  $('addCompositionRow').addEventListener('click',addCompositionRow);
  $('compositionRows').addEventListener('input',updateCompositionTotals);
  $('compositionRows').addEventListener('click',e=>{
    const btn=e.target.closest('[data-remove-composition]');if(!btn)return;
    const rows=getCompositionRows();rows.splice(Number(btn.dataset.removeComposition),1);renderCompositionRows(rows);
  });
  $('productImages').addEventListener('change',e=>uploadImages(e.target.files));
  $('adminThumbnails').addEventListener('click',e=>{
    const up=e.target.closest('[data-image-up]'),down=e.target.closest('[data-image-down]'),del=e.target.closest('[data-image-delete]');
    if(up)reorderImages(Number(up.dataset.imageUp),Number(up.dataset.imageUp)-1);
    else if(down)reorderImages(Number(down.dataset.imageDown),Number(down.dataset.imageDown)+1);
    else if(del){
      const index=Number(del.dataset.imageDelete),item=currentImages[index];
      if(item)api(`/api/admin/media/${encodeURIComponent(currentProductKey)}`,{method:'DELETE',body:JSON.stringify({path:item.path})})
        .then(r=>{currentImages=r.images||[];previewIndex=0;renderImageManager();notice('Imagen eliminada.');loadAdminData(false);})
        .catch(err=>notice(err.message,'error'));
    }else{
      const thumb=e.target.closest('[data-image-index]');if(thumb){previewIndex=Number(thumb.dataset.imageIndex);renderImageManager();}
    }
  });
  $('adminThumbnails').addEventListener('dragstart',e=>{const item=e.target.closest('[data-image-index]');if(item){dragImageIndex=Number(item.dataset.imageIndex);item.classList.add('dragging');e.dataTransfer.effectAllowed='move';}});
  $('adminThumbnails').addEventListener('dragend',e=>{e.target.closest('.admin-thumb-item')?.classList.remove('dragging');});
  $('adminThumbnails').addEventListener('dragover',e=>{if(e.target.closest('[data-image-index]'))e.preventDefault();});
  $('adminThumbnails').addEventListener('drop',e=>{const item=e.target.closest('[data-image-index]');if(item&&dragImageIndex!==null){e.preventDefault();reorderImages(dragImageIndex,Number(item.dataset.imageIndex));dragImageIndex=null;}});
  ['pUsBox','pFarmBox','pUkBox','pStems','pUsCost','pUkCost'].forEach(id=>$(id).addEventListener('input',()=>updateCalculations('both','other')));
  $('pUsPrice').addEventListener('input',()=>{usLastEdited='price';updateCalculations('us','usPrice');});
  $('pUsMarkup').addEventListener('input',()=>{usLastEdited='markup';updateCalculations('us','usMarkup');});
  $('pUkPrice').addEventListener('input',()=>{ukLastEdited='price';updateCalculations('uk','ukPrice');});
  $('pUkMarkup').addEventListener('input',()=>{ukLastEdited='markup';updateCalculations('uk','ukMarkup');});
  $('pFarmBox').addEventListener('change',()=>{$('pFarmBoxUK').value=$('pFarmBox').value;updateCalculations();});
  $('pFarmBoxUK').addEventListener('change',()=>{$('pFarmBox').value=$('pFarmBoxUK').value;updateCalculations();});
  ['pUsBox','pFarmBox','pUkBox'].forEach(id=>$(id).addEventListener('change',()=>updateCalculations()));
  document.querySelectorAll('[data-market-tab]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-market-tab]').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.market-admin-panel').forEach(x=>x.classList.toggle('active',x.id===`market-${b.dataset.marketTab}`));
  }));
  $('boxSearch').addEventListener('input',renderBoxes);$('boxTypeFilter').addEventListener('change',renderBoxes);
  $('createBoxButton').addEventListener('click',createBox);$('saveBoxMargin').addEventListener('click',saveBoxMargin);
  $('createUserForm').addEventListener('submit',createUser);
  $('importWorkbookForm').addEventListener('submit',importWorkbook);
  $('importImagesForm').addEventListener('submit',importImages);
  $('formulaSettingsForm').addEventListener('submit',saveSettings);
  document.addEventListener('click',e=>{
    const edit=e.target.closest('[data-edit-product]');if(edit)editProduct(edit.dataset.editProduct);
    const del=e.target.closest('[data-delete-product]');if(del)deleteProduct(del.dataset.deleteProduct);
    const box=e.target.closest('[data-edit-box]');if(box)editBox(box.dataset.editBox);
    const save=e.target.closest('[data-save-user]');if(save)saveUser(save.dataset.saveUser);
    const delUser=e.target.closest('[data-delete-user]');if(delUser)deleteUser(delUser.dataset.deleteUser);
  });
  $('boxRows').addEventListener('input',e=>{const input=e.target.closest('[data-box-u2]');if(input)previewBoxU2(input);});
  $('boxRows').addEventListener('click',e=>{const btn=e.target.closest('[data-save-box-u2]');if(btn)saveBoxU2(btn.dataset.saveBoxU2);});
  try{await loadAdminData();}catch(e){}
  try{await loadUsers();}catch(e){}
});
