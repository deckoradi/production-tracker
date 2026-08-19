// PRODUCTION TRACKER - orders.js
let currentUser=null,orders=[],selectedOrderId=null,currentPage=1,totalPages=1,totalOrders=0;
const LIMIT=100;
const $=id=>document.getElementById(id);
const token=localStorage.getItem('token'),userStr=localStorage.getItem('user');
if(!token||!userStr){location.href='index.html'}else{try{currentUser=JSON.parse(userStr)}catch(e){localStorage.clear();location.href='index.html'}}
const companyDisplay=$('companyDisplay'),adminPanel=$('adminPanel'),ordersContainer=$('ordersContainer'),searchInput=$('searchInput'),searchBtn=$('searchBtn'),clearSearchBtn=$('clearSearchBtn'),logoutBtn=$('logoutBtn'),sendReportBtn=$('sendReportBtn'),phaseModal=$('phaseModal'),modalOrderNumber=$('modalOrderNumber'),modalOrderInfo=$('modalOrderInfo'),phasesContainer=$('phasesContainer'),closeModal=document.querySelector('.close-modal'),orderCount=$('orderCount');
if(companyDisplay)companyDisplay.textContent=currentUser?.company||'';
const headers=json=>{const h={Authorization:`Bearer ${token}`};if(json)h['Content-Type']='application/json';return h};
async function api(url,opt={}){const r=await fetch(url,opt);let d={};try{d=await r.json()}catch(_){}if(r.status===401){localStorage.clear();location.href='index.html';throw Error('Sesija je istekla.')}if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d}

document.addEventListener('DOMContentLoaded',()=>{if(currentUser?.role==='admin'){adminPanel?.classList.remove('hidden');addAdminControls();loadUsers()}loadOrders()});
searchBtn?.addEventListener('click',()=>loadOrders(searchInput?.value||'',1));searchInput?.addEventListener('keyup',e=>{if(e.key==='Enter')loadOrders(searchInput.value,1)});clearSearchBtn?.addEventListener('click',()=>{if(searchInput)searchInput.value='';loadOrders('',1)});logoutBtn?.addEventListener('click',()=>{localStorage.clear();location.href='index.html'});closeModal?.addEventListener('click',()=>phaseModal?.classList.add('hidden'));window.addEventListener('click',e=>{if(e.target===phaseModal)phaseModal.classList.add('hidden')});

function addAdminControls(){if(!adminPanel||$('orderManagementPanel'))return;const p=document.createElement('div');p.id='orderManagementPanel';p.style='margin:15px 0;padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#fff';p.innerHTML=`<b>Upravljanje nalozima</b><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"><button id="deleteActiveOrdersBtn" style="padding:10px 16px;background:#e53e3e;color:white;border:0;border-radius:8px;font-weight:700">🗑️ Obriši aktivne naloge</button><button id="deleteAllHistoryBtn" style="padding:10px 16px;background:#718096;color:white;border:0;border-radius:8px;font-weight:700">🧹 Obriši sve + istoriju</button></div><div id="orderManagementStatus" style="margin-top:10px"></div>`;adminPanel.appendChild(p);$('deleteActiveOrdersBtn').onclick=clearActive;$('deleteAllHistoryBtn').onclick=clearAll}

async function clearActive(){
  if(!confirm('Obrisati sve aktivne naloge? Istorija ostaje sačuvana.'))return;
  try{
    const d=await api('/api/clear-orders',{method:'POST',headers:headers()});
    document.getElementById('orderManagementStatus').textContent=`✅ Obrisano ${d.deletedOrders} aktivnih naloga. Istorija je sačuvana.`;
    loadOrders('',1);
  }catch(e){document.getElementById('orderManagementStatus').textContent='❌ '+e.message}
}
async function clearAll(){
  if(!confirm('PAŽNJA: brišu se aktivni nalozi I SVA istorija. Nastaviti?'))return;
  try{
    const d=await api('/api/clear-all',{method:'POST',headers:headers()});
    document.getElementById('orderManagementStatus').textContent=`✅ Obrisano ${d.deletedOrders} naloga i ${d.deletedHistory} istorijskih zapisa.`;
    loadOrders('',1);
  }catch(e){document.getElementById('orderManagementStatus').textContent='❌ '+e.message}
}

$('uploadForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=$('fileInput'),s=$('uploadStatus');if(!f?.files?.[0]){s.textContent='Molimo izaberite Excel fajl';s.className='error';return}s.textContent='⏳ Analiziram Excel i sinhronizujem...';s.className='';const fd=new FormData();fd.append('file',f.files[0]);try{const r=await fetch('/api/upload',{method:'POST',headers:headers(),body:fd});const d=await r.json();if(!r.ok)throw Error(d.error);s.className='success';s.innerHTML=`✅ Sinhronizovano: 🟢 ${d.updated} postojećih, 🔵 ${d.inserted} novih, 🔴 ${d.removed} uklonjeno. Istorija sačuvana.`;f.value='';await loadOrders('',1)}catch(e){s.textContent='❌ '+e.message;s.className='error'}});

$('createUserForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/users',{method:'POST',headers:headers(true),body:JSON.stringify({username:$('newUsername').value.trim(),company:$('newCompany').value.trim()})});$('userStatus').textContent=`✅ Korisnik ${d.user.username} kreiran`;$('userStatus').className='success';$('newUsername').value='';$('newCompany').value='';loadUsers()}catch(e){$('userStatus').textContent='❌ '+e.message;$('userStatus').className='error'}});
async function loadUsers(){try{const u=await api('/api/users',{headers:headers()});const x=$('usersList');if(x)x.innerHTML=u.map(a=>`<div class="user-item"><span>${esc(a.username)}</span><span>${esc(a.company)}</span><span>${esc(a.role)}</span></div>`).join('')||'Nema korisnika'}catch(e){console.error(e)}}
sendReportBtn?.addEventListener('click',async()=>{if(!confirm('📧 Pošalji dnevni izveštaj?'))return;try{alert((await api('/api/send-report',{method:'POST',headers:headers(true),body:JSON.stringify({date:new Date().toLocaleDateString('sr-RS')})})).message)}catch(e){alert('❌ '+e.message)}});

async function loadOrders(search='',page=1){try{const u=search?`/api/orders?search=${encodeURIComponent(search)}&page=${page}&limit=${LIMIT}`:`/api/orders?page=${page}&limit=${LIMIT}`;ordersContainer.innerHTML='<div class="loading">⏳ Učitavanje...</div>';const d=await api(u,{headers:headers()});orders=d.data||[];totalOrders=d.total||0;currentPage=d.page||1;totalPages=d.totalPages||1;if(orderCount)orderCount.textContent=`${totalOrders} naloga`;renderOrders();if(selectedOrderId&&!phaseModal?.classList.contains('hidden')){const o=orders.find(x=>String(x.id)===String(selectedOrderId));if(o)renderModal(o);else phaseModal.classList.add('hidden')}}catch(e){ordersContainer.innerHTML=`<div class="error">❌ ${esc(e.message)}</div>`}}
function renderOrders(){if(!orders.length){ordersContainer.innerHTML='<p style="text-align:center;padding:40px;color:#a0aec0">📭 Nema naloga za prikaz</p>';return}const admin=currentUser?.role==='admin';let h='<table><thead><tr>'+(admin?'<th>Firma</th><th>Šifra</th><th>Naziv</th><th>Nalog</th><th>Količina</th><th>Datum</th><th>Status</th>':'<th>Nalog</th><th>Naziv</th><th>Količina</th><th>Status</th>')+'</tr></thead><tbody>';orders.forEach((o,i)=>{const p=o.progress||[],c=p.filter(x=>x.status==='completed').length,pr=p.filter(x=>x.status==='problem').length,t=p.length;const st=t&&c===t?['✅ Završeno','status-completed']:pr?['⚠️ Problem','status-problem']:c?[`${c}/${t}`,'status-pending']:['U toku','status-pending'];h+=`<tr style="border-bottom:1px solid #e2e8f0;${i%2===0?'background:#fafafa':''}">`;if(admin)h+=`<td>${esc(o.company)}</td><td>${esc(o.code)}</td><td>${esc(o.name)}</td><td style="color:#667eea;font-weight:700;cursor:pointer" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td style="text-align:center">${o.quantity||0}</td><td>${esc(o.deliveryDate||'-')}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;else h+=`<td style="color:#667eea;font-weight:700;cursor:pointer" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td>${esc(o.name)}</td><td style="text-align:center">${o.quantity||0}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;h+='</tr>'});h+='</tbody></table>';if(totalPages>1)h+=`<div style="display:flex;justify-content:center;gap:12px;padding:14px"><button onclick="goToPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>◀</button><span>${currentPage} / ${totalPages}</span><button onclick="goToPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>▶</button></div>`;ordersContainer.innerHTML=h}
function goToPage(p){if(p<1||p>totalPages)return;loadOrders(searchInput?.value||'',p)}

function openOrder(id){const o=orders.find(x=>String(x.id)===String(id));if(!o)return;selectedOrderId=id;renderModal(o);phaseModal.classList.remove('hidden')}

// ============ RENDER MODAL – centriran status, datum ispod, bez "Istorija" ============
function renderModal(o){
  modalOrderNumber.textContent=o.orderNumber||'N/A';
  modalOrderInfo.innerHTML=`<p><b>Firma:</b> ${esc(o.company)}</p><p><b>Artikal:</b> ${esc(o.name)}</p><p><b>Šifra:</b> ${esc(o.code)}</p><p><b>Količina:</b> ${o.quantity||0}</p><p><b>Datum isporuke:</b> ${esc(o.deliveryDate||'-')}</p>`;
  let h='';
  (o.progress||[]).forEach(p=>{
    const emoji = p.status==='completed' ? '✅' : p.status==='problem' ? '⚠️' : '⬜';
    const label = p.status==='completed' ? 'URAĐENO' : p.status==='problem' ? 'PROBLEM' : 'NA ČEKANJU';
    // Uvek prikazuj datum, ako nema – "Nema datuma"
    const dateStr = p.updatedAt ? date(p.updatedAt) : 'Nema datuma';
    h+=`<div class="phase-card">
      <h4>Faza ${esc(p.phase)}</h4>
      <div style="text-align:center; padding:6px 0;">
        <div style="font-size:32px;">${emoji}</div>
        <div style="font-weight:bold; font-size:16px; margin-top:2px;">${label}</div>
        <div style="font-size:13px; color:#718096; margin-top:2px;">📅 ${dateStr}</div>
      </div>
      <div class="phase-buttons" style="justify-content:center; gap:8px; display:flex; flex-wrap:wrap; margin:8px 0;">
        <button onclick="updatePhase(${o.id},'${js(p.phase)}','completed')">✅ Urađeno</button>
        <button onclick="updatePhase(${o.id},'${js(p.phase)}','problem')">⚠️ Problem</button>
        <button onclick="updatePhase(${o.id},'${js(p.phase)}','pending')">⬜ Reset</button>
      </div>
      <textarea style="width:100%; min-height:60px; margin-top:4px;" onblur="saveComment(${o.id},'${js(p.phase)}',this.value)" placeholder="Komentar...">${esc(p.comment||'')}</textarea>
    </div>`;
  });
  phasesContainer.innerHTML=h||'Nema faza';
}

// ============ SAVE COMMENT ============
async function saveComment(id, phase, comment) {
  const o = orders.find(x => String(x.id) === String(id));
  const p = o?.progress.find(x => String(x.phase) === String(phase));
  if (!p) return;
  const oldComment = p.comment, oldUpdated = p.updatedAt;
  p.comment = comment;
  p.updatedAt = new Date().toISOString(); // privremeno za prikaz
  try {
    const res = await api('/api/update-phase', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ orderId: id, phase, comment })
    });
    if (res.updatedAt) p.updatedAt = res.updatedAt;
    renderModal(o);
  } catch (e) {
    p.comment = oldComment;
    p.updatedAt = oldUpdated;
    console.error(e);
  }
}

async function updatePhase(id,phase,status){const o=orders.find(x=>String(x.id)===String(id)),p=o?.progress.find(x=>String(x.phase)===String(phase));if(!p)return;const old={status:p.status,comment:p.comment,updatedAt:p.updatedAt};p.status=status;p.updatedAt=new Date().toISOString();renderOrders();renderModal(o);try{const d=await api('/api/update-phase',{method:'POST',headers:headers(true),body:JSON.stringify({orderId:id,phase,status,comment:p.comment||''})});p.updatedAt=d.updatedAt;renderOrders();renderModal(o)}catch(e){Object.assign(p,old);renderOrders();renderModal(o);alert('❌ '+e.message)}}

// ============ DATE function (samo datum) ============
function date(v) {
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('sr-RS', { day:'2-digit', month:'2-digit', year:'numeric' });
}

function esc(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML}
function js(v){return String(v??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
window.openOrder=openOrder;window.goToPage=goToPage;window.updatePhase=updatePhase;window.saveComment=saveComment;