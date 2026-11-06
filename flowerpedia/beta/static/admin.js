const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
const $ = id => document.getElementById(id);
let adminData = {products:[],boxes:[],farms:[],options:{},settings:{}};
let currentEdit = null;
const standardBoxes = ['SB','EB','QB','HB','EB2','QB2'];
const esc = v => String(v ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const norm = v => String(v ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const num = v => { if(v===null||v===undefined||v==='') return null; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:null; };
const roundUp2 = v => Math.ceil((Number(v)-1e-8)*100)/100;
async function api(url,options={}) {
  const headers=new Headers(options.headers||{});
  if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase())) headers.set('X-CSRF-Token',csrfToken);
  if(options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  const res=await fetch(url,{...options,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||`Error ${res.status}`);
  return data;
}
function notice(message,type='success') {
  const box=$('adminNotice'); box.textContent=message; box.className=`alert ${type}`; box.classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
  setTimeout(()=>box.classList.add('hidden'),7000);
}
function switchAdminTab(tab) {
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===tab));
  document.querySelectorAll('.admin-panel').forEach(p=>p.classList.toggle('active',p.id===`panel-${tab}`));
  if(tab==='editor') updateCalculations();
}
function fillSelect(id, values, placeholder, selected='') {
  const el=$(id); if(!el) return;
  const unique=[...new Map((values||[]).filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').map(v=>[norm(v),String(v).trim()])).values()];
  if(selected && !unique.some(v=>norm(v)===norm(selected))) unique.unshift(String(selected));
  el.innerHTML=`<option value="">${esc(placeholder)}</option>`+unique.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if(selected) el.value=unique.find(v=>norm(v)===norm(selected))||'';
}
function boxByName(name) {
  return adminData.boxes.find(b=>norm(b.Nombre)===norm(name));
}
function populateSelects(row={}) {
  const farms=adminData.farms.map(f=>f.Nombre);
  const categories=[...(adminData.options['Categoría']||[]),...adminData.products.map(p=>p['Categoría'])];
  const colors=[...(adminData.options.Color||[]),...adminData.products.flatMap(p=>[p['Color 1'],p['Color 2']])];
  const seasons=[...(adminData.options.Season||[]),...adminData.products.map(p=>p.Season)];
  const sizes=[...(adminData.options['Tamaño']||[]),...adminData.products.map(p=>p.Tamaño)];
  const usBoxes=[...standardBoxes.filter(n=>boxByName(n)),...adminData.products.map(p=>p['Caja EC'])];
  const farmBoxes=adminData.boxes.filter(b=>!/\sUK$/i.test(b.Nombre||'')).map(b=>b.Nombre);
  const ukBoxes=adminData.boxes.filter(b=>/\sUK$/i.test(b.Nombre||'')).map(b=>b.Nombre);
  fillSelect('pFinca',farms,'Selecciona finca',row.Finca);
  fillSelect('pCategory',categories,'Selecciona categoría',row['Categoría']);
  fillSelect('pColor1',colors,'Sin color',row['Color 1']);
  fillSelect('pColor2',colors,'Sin segundo color',row['Color 2']);
  fillSelect('pSeason',seasons,'Sin temporada',row.Season);
  fillSelect('pSize',sizes,'Selecciona tamaño',row.Tamaño);
  fillSelect('pUsBoxType',[...new Set(usBoxes.filter(Boolean))],'Selecciona tipo de caja',row['Caja EC']);
  const farmBoxLabels=farmBoxes.map(name=>{
    const b=boxByName(name); return {name,label:`${name} · ${b?.Largo??'—'}×${b?.Ancho??'—'}×${b?.Alto??'—'} cm`};
  });
  $('pFarmBox').innerHTML='<option value="">Selecciona caja de finca</option>'+farmBoxLabels.map(b=>`<option value="${esc(b.name)}">${esc(b.label)}</option>`).join('');
  if(row['Caja Finca']) {
    if(!farmBoxLabels.some(b=>norm(b.name)===norm(row['Caja Finca']))) $('pFarmBox').insertAdjacentHTML('beforeend',`<option value="${esc(row['Caja Finca'])}">${esc(row['Caja Finca'])}</option>`);
    $('pFarmBox').value=row['Caja Finca'];
  }
  fillSelect('pUkBox',ukBoxes,'Selecciona caja UK',row['Caja UK']);
}
function showStats() {
  const s=adminData.stats||{};
  $('adminStats').innerHTML=[
    ['Registros',s.rows||0],['Productos',s.products||0],['Cajas',s.boxes||0],['Fincas',s.farms||0]
  ].map(([label,value])=>`<div class="stat-card"><span>${label}</span><strong>${Number(value).toLocaleString('es')}</strong></div>`).join('');
  $('activeWorkbook').textContent=adminData.source_filename||'current_week.xlsx';
}
function renderProductList() {
  const term=norm($('adminProductSearch').value);
  const filtered=adminData.products.filter(p=>norm([p.Producto,p['Categoría'],p.Finca,p.Tamaño,p['Caja EC'],p['Caja Finca'],p['Caja UK']].join(' ')).includes(term));
  const shown=filtered.slice(0,150);
  $('adminProductRows').innerHTML=shown.map(p=>`
    <tr>
      <td><strong>${esc(p.Producto||'—')}</strong></td><td>${esc(p['Categoría']||'—')}</td><td>${esc(p.Finca||'—')}</td><td>${esc(p.Tamaño||'—')}</td>
      <td>${p.Venta!==null&&p.Venta!==undefined?`$${Number(p.Venta).toFixed(2)}`:'—'}</td>
      <td>${p['Venta UK']!==null&&p['Venta UK']!==undefined?`£${Number(p['Venta UK']).toFixed(2)}`:'—'}</td>
      <td><span class="status-tag ${p._source==='manual'?'neutral':'success'}">${p._source==='manual'?'Manual':'Excel'}</span></td>
      <td><div class="row-actions"><button class="icon-btn" data-edit-product="${esc(p._id)}">Editar</button><button class="icon-btn danger" data-delete-product="${esc(p._id)}">×</button></div></td>
    </tr>`).join('') || '<tr><td colspan="8">No se encontraron registros.</td></tr>';
  $('productListCount').textContent=`Mostrando ${shown.length} de ${filtered.length} registros coincidentes (máximo 150 por vista).`;
}
function renderBoxes() {
  const term=norm($('boxSearch').value);
  const rows=adminData.boxes.filter(b=>norm(b.Nombre).includes(term));
  $('boxRows').innerHTML=rows.map(b=>`
    <tr><td><strong>${esc(b.Nombre)}</strong></td><td>${b.Largo??'—'}</td><td>${b.Ancho??'—'}</td><td>${b.Alto??'—'}</td>
    <td>${b.Peso!==null&&b.Peso!==undefined?Number(b.Peso).toFixed(3):'—'}</td><td>${esc(b.Aprobado||'—')}</td>
    <td>${b.Largo2??'—'} × ${b.Ancho2??'—'} × ${b.Alto2??'—'}</td><td><button class="icon-btn" data-edit-box="${esc(b.Nombre)}">Editar medidas</button></td></tr>`).join('') || '<tr><td colspan="8">Sin resultados.</td></tr>';
}
async function renderUsers() {
  try {
    const data=await api('/api/admin/users');
    $('userRows').innerHTML=data.users.map(u=>`
      <tr data-user-row="${u.id}">
        <td><strong>${esc(u.username)}</strong></td>
        <td><select class="user-role"><option value="staff" ${u.role==='staff'?'selected':''}>Personal</option><option value="admin" ${u.role==='admin'?'selected':''}>Administrador</option></select></td>
        <td><label class="inline-check"><input class="user-active" type="checkbox" ${u.is_active?'checked':''}> Activo</label></td>
        <td><input class="user-password" type="password" placeholder="Nueva contraseña (opcional)" minlength="10"></td>
        <td><div class="row-actions"><button class="icon-btn" data-save-user="${u.id}">Guardar</button><button class="icon-btn danger" data-delete-user="${u.id}">Eliminar</button></div></td>
      </tr>`).join('') || '<tr><td colspan="5">No hay usuarios.</td></tr>';
  } catch(e) { notice(e.message,'error'); }
}
function setFormValue(id,value) { $(id).value = value===null||value===undefined ? '' : value; }
function clearProductForm() {
  currentEdit=null;
  $('editProductId').value='';
  $('editorTitle').textContent='Añadir producto';
  ['pFinca','pCategory','pColor1','pColor2','pSeason','pSize','pUsBoxType','pFarmBox','pUkBox'].forEach(id=>$(id).value='');
  ['pName','pImage','pComposition','pTable','pStems','pUsCost','pUsPrice','pUsMarkup','pUkCost','pUkPrice','pUkMarkup'].forEach(id=>$(id).value='');
  document.querySelector('input[name="usMode"][value="price"]').checked=true;
  document.querySelector('input[name="ukMode"][value="price"]').checked=true;
  populateSelects();
  updateCalculations();
}
function editProduct(id) {
  const row=adminData.products.find(p=>p._id===id);
  if(!row) return;
  currentEdit=id;
  $('editProductId').value=id;
  $('editorTitle').textContent=`Editar: ${row.Producto||'producto'}`;
  populateSelects(row);
  setFormValue('pName',row.Producto);
  setFormValue('pImage',row.IMG);
  setFormValue('pComposition',row.Composición);
  setFormValue('pTable',row.Tabla);
  setFormValue('pStems',row['Total Tallos']);
  setFormValue('pUsCost',row.Compra);
  setFormValue('pUsPrice',row.Venta);
  setFormValue('pUsMarkup',row.Markup==='BAJO'||row.Markup==='ALTO'?'':row.Markup==null?'':(Number(row.Markup)*100).toFixed(2));
  setFormValue('pUkCost',row['Compra UK']);
  setFormValue('pUkPrice',row['Venta UK']);
  setFormValue('pUkMarkup',row['Markup UK']==='BAJO'||row['Markup UK']==='ALTO'?'':row['Markup UK']==null?'':(Number(row['Markup UK'])*100).toFixed(2));
  document.querySelector('input[name="usMode"][value="price"]').checked=true;
  document.querySelector('input[name="ukMode"][value="price"]').checked=true;
  switchAdminTab('editor');
  updateCalculations();
}
function currentMode(market) {
  return document.querySelector(`input[name="${market}Mode"]:checked`)?.value || 'price';
}
function calculateUS() {
  const type=$('pUsBoxType').value, box=boxByName(type);
  const stems=num($('pStems').value), cost=num($('pUsCost').value), price=num($('pUsPrice').value);
  if(!box||!stems||stems<=0||cost===null) return null;
  let l=num(box.Largo),w=num(box.Ancho),h=num(box.Alto);
  if([l,w,h].some(x=>x===null)) return null;
  if(!standardBoxes.includes(type)) { const margin=num(adminData.settings.safety_margin_cm)||2; l+=margin;w+=margin;h+=margin; }
  const volume=l*w*h/6000;
  const transportTotal=roundUp2(volume*(num(adminData.settings.us_transport_volume_rate)||5.25)*(num(adminData.settings.us_transport_multiplier)||1.36));
  const transport=roundUp2(transportTotal/stems);
  const duties=roundUp2(cost*(num(adminData.settings.us_duties_rate)||0.1586));
  const total=cost+duties+transport;
  const factor=num(adminData.settings.us_sale_factor)||0.96;
  const markup=price&&price>0 ? 1-total/(price*factor) : null;
  return {volume,transportTotal,transport,duties,total,markup,box};
}
function calculateUK() {
  const type=$('pUkBox').value, box=boxByName(type);
  const stems=num($('pStems').value);
  let purchase=num($('pUkCost').value);
  if(purchase===null) purchase=num($('pUsCost').value);
  const price=num($('pUkPrice').value);
  if(!box||!stems||stems<=0||purchase===null) return null;
  const l=num(box.Largo),w=num(box.Ancho),h=num(box.Alto);
  if([l,w,h].some(x=>x===null)) return null;
  const volume=l*w*h/6000;
  const transportTotal=roundUp2(volume*(num(adminData.settings.uk_transport_volume_rate)||3.2)*(num(adminData.settings.uk_transport_multiplier)||1.1));
  const transport=roundUp2(transportTotal/stems);
  const rate=num(adminData.settings.uk_exchange_rate)||1.26;
  const costGBP=purchase/rate;
  const total=roundUp2(costGBP+transport);
  const factor=num(adminData.settings.uk_sale_factor)||0.97;
  const markup=price&&price>0 ? 1-total/(price*factor) : null;
  return {volume,transportTotal,transport,costGBP,total,markup,box};
}
function calcOpUS() {
  const type=$('pUsBoxType').value, farmName=$('pFarmBox').value;
  if(!type||!farmName||!norm(farmName).includes(norm(type))) return '';
  const b=boxByName(farmName); return b?.Aprobado||'NO ENCONTRADO';
}
function calcOpUK() {
  const type=$('pUkBox').value, farmName=$('pFarmBox').value;
  if(!type||!farmName) return '';
  const base=type.replace(/\s+UK$/i,'');
  if(!norm(farmName).includes(norm(base))) return '';
  const farmBox=boxByName(farmName),ukBox=boxByName(type);
  if(!farmBox||!ukBox||num(farmBox.Peso)===null) return 'NO ENCONTRADO';
  const cap=num(ukBox.Largo)*num(ukBox.Ancho)*num(ukBox.Alto)/6000;
  return num(farmBox.Peso)<=cap?'y':'n';
}
function updateCalculations() {
  const usMode=currentMode('us'), us=calculateUS();
  $('pUsPrice').readOnly=usMode==='markup';
  $('pUsMarkup').readOnly=usMode==='price';
  if(usMode==='markup') {
    const target=num($('pUsMarkup').value);
    if(us&&target!==null&&target>=0&&target<100) {
      const raw=us.total/((num(adminData.settings.us_sale_factor)||0.96)*(1-target/100));
      $('pUsPrice').value=roundUp2(raw).toFixed(2);
    } else $('pUsPrice').value='';
  } else if(us&&us.markup!==null) {
    $('pUsMarkup').value=(us.markup*100).toFixed(2);
  } else $('pUsMarkup').value='';
  $('usCalcResult').textContent=us ? `Transporte por tallo: $${us.transport.toFixed(2)} · Duties: $${us.duties.toFixed(2)} · Coste aplicado: $${us.total.toFixed(2)} · Markup calculado: ${$('pUsMarkup').value?$('pUsMarkup').value+'%':'—'}` : 'Introduce Caja EC, Total Tallos y Compra para calcular.';
  const opUS=calcOpUS(); $('usOpStatus').textContent=`Op: ${opUS||'—'}`; $('usOpStatus').className=`status-tag ${opUS==='y'?'success':opUS==='n'?'neutral':'neutral'}`;
  const ub=us?.box;
  $('usBoxPreview').textContent=ub?`Dimensiones de ${ub.Nombre}: ${ub.Largo} × ${ub.Ancho} × ${ub.Alto} cm · Peso volumétrico: ${Number(ub.Peso||0).toFixed(3)}`:'';
  const ukMode=currentMode('uk'), uk=calculateUK();
  $('pUkPrice').readOnly=ukMode==='markup';
  $('pUkMarkup').readOnly=ukMode==='price';
  if(ukMode==='markup') {
    const target=num($('pUkMarkup').value);
    if(uk&&target!==null&&target>=0&&target<100) {
      const raw=uk.total/((num(adminData.settings.uk_sale_factor)||0.97)*(1-target/100));
      $('pUkPrice').value=roundUp2(raw).toFixed(2);
    } else $('pUkPrice').value='';
  } else if(uk&&uk.markup!==null) {
    $('pUkMarkup').value=(uk.markup*100).toFixed(2);
  } else $('pUkMarkup').value='';
  $('ukCalcResult').textContent=uk ? `Transporte por tallo: £${uk.transport.toFixed(2)} · Compra convertida: £${uk.costGBP.toFixed(2)} · Coste total: £${uk.total.toFixed(2)} · Markup calculado: ${$('pUkMarkup').value?$('pUkMarkup').value+'%':'—'}` : 'Introduce Caja UK, Total Tallos y Compra (UK o USA) para calcular.';
  const opUK=calcOpUK(); $('ukOpStatus').textContent=`Op UK: ${opUK||'—'}`; $('ukOpStatus').className=`status-tag ${opUK==='y'?'success':opUK==='n'?'neutral':'neutral'}`;
  const kb=uk?.box;
  $('ukBoxPreview').textContent=kb?`Dimensiones de ${kb.Nombre}: ${kb.Largo} × ${kb.Ancho} × ${kb.Alto} cm · Peso volumétrico: ${Number(kb.Peso||0).toFixed(3)}`:'';
}
function buildProductPayload() {
  const usMode=currentMode('us'), ukMode=currentMode('uk');
  const row={
    'Finca':$('pFinca').value,'ID':null,'Categoría':$('pCategory').value,'Producto':$('pName').value.trim(),
    'Composición':$('pComposition').value,'Color 1':$('pColor1').value,'Color 2':$('pColor2').value,
    'Season':$('pSeason').value,'Tamaño':$('pSize').value,'Tabla':$('pTable').value,'IMG':$('pImage').value.trim(),
    'Caja EC':$('pUsBoxType').value,'Op':calcOpUS(),'Caja Finca':$('pFarmBox').value,
    'Total Tallos':num($('pStems').value),'Compra':num($('pUsCost').value),'Markup':null,'Venta':num($('pUsPrice').value),
    'Caja UK':$('pUkBox').value,'Op UK':calcOpUK(),'Compra UK':num($('pUkCost').value),'Markup UK':null,'Venta UK':num($('pUkPrice').value)
  };
  if(usMode==='markup') {
    const target=num($('pUsMarkup').value);
    if(target!==null) row.Markup=target/100;
  }
  if(ukMode==='markup') {
    const target=num($('pUkMarkup').value);
    if(target!==null) row['Markup UK']=target/100;
  }
  const us=calculateUS();
  if(us && usMode==='price') row.Markup=us.markup;
  const uk=calculateUK();
  if(uk && ukMode==='price') row['Markup UK']=uk.markup;
  return row;
}
async function saveProduct(e) {
  e.preventDefault();
  try {
    updateCalculations();
    const row=buildProductPayload();
    if(!row.Producto) throw new Error('El nombre del producto es obligatorio.');
    if(currentEdit) await api(`/api/admin/products/${currentEdit}`,{method:'PUT',body:JSON.stringify(row)});
    else await api('/api/admin/products',{method:'POST',body:JSON.stringify(row)});
    notice(currentEdit?'Producto actualizado correctamente.':'Producto añadido correctamente.');
    await loadAdminData();
    clearProductForm();
    switchAdminTab('products');
  } catch(err) { notice(err.message,'error'); }
}
async function deleteProduct(id) {
  if(!confirm('¿Eliminar este registro del catálogo?')) return;
  try { await api(`/api/admin/products/${id}`,{method:'DELETE'}); notice('Registro eliminado.'); await loadAdminData(); }
  catch(e){notice(e.message,'error');}
}
async function editBox(name) {
  const box=boxByName(name); if(!box) return;
  const l=prompt(`Largo en cm · ${name}`,box.Largo??'');
  if(l===null) return;
  const w=prompt(`Ancho en cm · ${name}`,box.Ancho??'');
  if(w===null) return;
  const h=prompt(`Alto en cm · ${name}`,box.Alto??'');
  if(h===null) return;
  try {
    await api(`/api/admin/boxes/${encodeURIComponent(name)}`,{method:'PUT',body:JSON.stringify({Largo:l,Ancho:w,Alto:h})});
    notice(`Dimensiones actualizadas para ${name}.`); await loadAdminData();
  } catch(e){notice(e.message,'error');}
}
async function createUser(e) {
  e.preventDefault();
  try {
    await api('/api/admin/users',{method:'POST',body:JSON.stringify({username:$('newUsername').value,password:$('newUserPassword').value,role:$('newUserRole').value})});
    $('createUserForm').reset(); await renderUsers(); notice('Usuario creado correctamente.');
  } catch(e){notice(e.message,'error');}
}
async function saveUser(id) {
  const row=document.querySelector(`[data-user-row="${id}"]`);
  const payload={role:row.querySelector('.user-role').value,is_active:row.querySelector('.user-active').checked};
  const password=row.querySelector('.user-password').value;
  if(password) payload.password=password;
  try { await api(`/api/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(payload)}); row.querySelector('.user-password').value=''; notice('Usuario actualizado.'); await renderUsers(); }
  catch(e){notice(e.message,'error');}
}
async function deleteUser(id) {
  if(!confirm('¿Eliminar este usuario?')) return;
  try { await api(`/api/admin/users/${id}`,{method:'DELETE'}); await renderUsers(); notice('Usuario eliminado.'); }
  catch(e){notice(e.message,'error');}
}
async function importWorkbook(e) {
  e.preventDefault();
  const file=$('workbookFile').files[0]; if(!file) return;
  const form=new FormData(); form.append('workbook',file);
  try {
    const result=await api('/api/admin/import',{method:'POST',body:form});
    $('importWorkbookForm').reset(); notice(result.message||'Excel importado.');
    await loadAdminData();
  } catch(err){notice(err.message,'error');}
}
async function saveSitePassword(e) {
  e.preventDefault();
  const password=$('newSitePassword').value;
  if(!password) {notice('Escribe una nueva contraseña.','error');return;}
  try {await api('/api/admin/settings',{method:'POST',body:JSON.stringify({site_password:password})});$('newSitePassword').value='';notice('Contraseña del catálogo actualizada.');}
  catch(e){notice(e.message,'error');}
}
async function saveFormulaSettings(e) {
  e.preventDefault();
  const keys=['us_transport_volume_rate','us_transport_multiplier','us_duties_rate','us_sale_factor','uk_transport_volume_rate','uk_transport_multiplier','uk_exchange_rate','uk_sale_factor','safety_margin_cm'];
  const payload={}; keys.forEach(k=>payload[k]=num($(`setting_${k}`).value));
  try {const data=await api('/api/admin/settings',{method:'POST',body:JSON.stringify(payload)});adminData.settings=data.settings;notice('Parámetros de cálculo guardados.');updateCalculations();}
  catch(e){notice(e.message,'error');}
}
function populateSettings() {
  Object.entries(adminData.settings||{}).forEach(([key,value])=>{
    const el=$(`setting_${key}`); if(el) el.value=value;
  });
}
async function loadAdminData() {
  const data=await api('/api/admin/data');
  adminData=data;
  showStats();
  renderProductList();
  renderBoxes();
  populateSelects();
  populateSettings();
  await renderUsers();
}
document.addEventListener('DOMContentLoaded',async()=>{
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.addEventListener('click',()=>switchAdminTab(b.dataset.adminTab)));
  $('newProductButton').addEventListener('click',()=>{clearProductForm();switchAdminTab('editor');});
  $('cancelEditButton').addEventListener('click',()=>switchAdminTab('products'));
  $('resetProductForm').addEventListener('click',clearProductForm);
  $('productForm').addEventListener('submit',saveProduct);
  $('adminProductSearch').addEventListener('input',renderProductList);
  $('boxSearch').addEventListener('input',renderBoxes);
  $('createUserForm').addEventListener('submit',createUser);
  $('importWorkbookForm').addEventListener('submit',importWorkbook);
  $('sitePasswordForm').addEventListener('submit',saveSitePassword);
  $('formulaSettingsForm').addEventListener('submit',saveFormulaSettings);
  document.querySelectorAll('[data-market-tab]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-market-tab]').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.market-admin-panel').forEach(x=>x.classList.toggle('active',x.id===`market-${b.dataset.marketTab}`));
  }));
  document.querySelectorAll('input[name="usMode"],input[name="ukMode"]').forEach(el=>el.addEventListener('change',updateCalculations));
  ['pUsBoxType','pFarmBox','pUkBox','pStems','pUsCost','pUsPrice','pUsMarkup','pUkCost','pUkPrice','pUkMarkup'].forEach(id=>$(id).addEventListener('input',updateCalculations));
  ['pUsBoxType','pFarmBox','pUkBox'].forEach(id=>$(id).addEventListener('change',updateCalculations));
  document.addEventListener('click',e=>{
    const edit=e.target.closest('[data-edit-product]'); if(edit) editProduct(edit.dataset.editProduct);
    const del=e.target.closest('[data-delete-product]'); if(del) deleteProduct(del.dataset.deleteProduct);
    const box=e.target.closest('[data-edit-box]'); if(box) editBox(box.dataset.editBox);
    const save=e.target.closest('[data-save-user]'); if(save) saveUser(save.dataset.saveUser);
    const delUser=e.target.closest('[data-delete-user]'); if(delUser) deleteUser(delUser.dataset.deleteUser);
  });
  try { await loadAdminData(); } catch(e){notice(e.message,'error');}
});
