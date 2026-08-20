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

function addAdminControls(){if(!adminPanel||$('orderManagementPanel'))return;const p=document.createElement('div');p.id='orderManagementPanel';p.className='admin-section';p.innerHTML=`<h3>🗂️ Upravljanje nalozima</h3><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"><button id="deleteActiveOrdersBtn" class="btn-tag btn-tag--problem" style="padding:10px 16px;font-size:13px">🗑️ Obriši aktivne naloge</button><button id="deleteAllHistoryBtn" class="btn-tag btn-tag--reset" style="padding:10px 16px;font-size:13px">🧹 Obriši sve + istoriju</button></div><div id="orderManagementStatus"></div>`;adminPanel.appendChild(p);$('deleteActiveOrdersBtn').onclick=clearActive;$('deleteAllHistoryBtn').onclick=clearAll;

  const h=document.createElement('div');h.id='historyExportPanel';h.className='admin-section';
  h.innerHTML=`<h3>📊 Istorija aktivnosti (Excel izveštaj)</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
      <select id="historyCompany" style="padding:10px;border:2px solid var(--line);border-radius:6px;flex:1;min-width:150px;font-family:var(--font-body);background:var(--card)">
        <option value="">Sve firme</option>
      </select>
      <input type="date" id="historyDateFrom" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
      <input type="date" id="historyDateTo" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
      <button id="exportHistoryBtn" class="btn-success" style="padding:10px 16px">📥 Preuzmi Excel</button>
    </div>
    <div id="historyExportStatus"></div>`;
  adminPanel.appendChild(h);
  $('exportHistoryBtn').onclick=exportHistory;
}

async function exportHistory(){
  const status=$('historyExportStatus');
  const company=$('historyCompany')?.value||'';
  const dateFrom=$('historyDateFrom')?.value||'';
  const dateTo=$('historyDateTo')?.value||'';
  status.textContent='⏳ Generišem Excel...';status.className='';
  try{
    const params=new URLSearchParams();
    if(company)params.append('company',company);
    if(dateFrom)params.append('dateFrom',dateFrom);
    if(dateTo)params.append('dateTo',dateTo);
    const r=await fetch(`/api/history/export?${params.toString()}`,{headers:headers()});
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||`HTTP ${r.status}`)}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`istorija_${company||'sve-firme'}_${dateFrom||'x'}_${dateTo||'x'}.xlsx`;
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
    status.textContent='✅ Fajl preuzet';status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

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
async function loadUsers(){try{const u=await api('/api/users',{headers:headers()});const x=$('usersList');if(x)x.innerHTML=u.map(a=>`<div class="user-item"><span>${esc(a.username)}</span><span>${esc(a.company)}</span><span>${esc(a.role)}</span>${a.role!=='admin'?`<span class="clickable" style="color:var(--red);font-weight:700" onclick="deleteUser(${a.id},'${js(a.username)}')" title="Obriši korisnika">🗑️</span>`:'<span></span>'}</div>`).join('')||'Nema korisnika';const sel=$('historyCompany');if(sel){const companies=[...new Set(u.map(a=>a.company).filter(Boolean))].sort();sel.innerHTML='<option value="">Sve firme</option>'+companies.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}}catch(e){console.error(e)}}

async function deleteUser(id,username){
  if(!confirm(`Obrisati korisnika "${username}"? Ova akcija se ne može poništiti.`))return;
  try{
    const d=await api(`/api/users/${id}`,{method:'DELETE',headers:headers()});
    $('userStatus').textContent='✅ '+d.message;$('userStatus').className='success';
    loadUsers();
  }catch(e){$('userStatus').textContent='❌ '+e.message;$('userStatus').className='error'}
}
sendReportBtn?.addEventListener('click',async()=>{if(!confirm('📧 Pošalji dnevni izveštaj?'))return;try{alert((await api('/api/send-report',{method:'POST',headers:headers(true),body:JSON.stringify({date:new Date().toLocaleDateString('sr-RS')})})).message)}catch(e){alert('❌ '+e.message)}});

async function loadOrders(search='',page=1){try{const u=search?`/api/orders?search=${encodeURIComponent(search)}&page=${page}&limit=${LIMIT}`:`/api/orders?page=${page}&limit=${LIMIT}`;ordersContainer.innerHTML='<div class="loading">⏳ Učitavanje...</div>';const d=await api(u,{headers:headers()});orders=d.data||[];totalOrders=d.total||0;currentPage=d.page||1;totalPages=d.totalPages||1;if(orderCount)orderCount.textContent=`${totalOrders} naloga`;renderOrders();if(selectedOrderId&&!phaseModal?.classList.contains('hidden')){const o=orders.find(x=>String(x.id)===String(selectedOrderId));if(o)renderModal(o);else phaseModal.classList.add('hidden')}}catch(e){ordersContainer.innerHTML=`<div class="error">❌ ${esc(e.message)}</div>`}}
function renderOrders(){if(!orders.length){ordersContainer.innerHTML='<p style="text-align:center;padding:40px;color:var(--muted)">📭 Nema naloga za prikaz</p>';return}const admin=currentUser?.role==='admin';let h='<table><thead><tr>'+(admin?'<th>Firma</th><th>Šifra</th><th>Naziv</th><th>Nalog</th><th>Količina</th><th>Datum</th><th>Status</th>':'<th>Nalog</th><th>Naziv</th><th>Količina</th><th>Status</th>')+'</tr></thead><tbody>';orders.forEach((o,i)=>{const p=o.progress||[],c=p.filter(x=>x.status==='completed').length,pr=p.filter(x=>x.status==='problem').length,t=p.length;const st=t&&c===t?['✅ Završeno','status-completed']:pr?['⚠️ Problem','status-problem']:c?[`${c}/${t}`,'status-pending']:['U toku','status-pending'];h+=`<tr style="${i%2===0?'background:var(--paper)':''}">`;if(admin)h+=`<td>${esc(o.company)}</td><td class="clickable" style="cursor:default;font-weight:600">${esc(o.code)}</td><td>${esc(o.name)}</td><td class="clickable" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td style="text-align:center">${o.quantity||0}</td><td>${esc(o.deliveryDate||'-')}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;else h+=`<td class="clickable" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td>${esc(o.name)}</td><td style="text-align:center">${o.quantity||0}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;h+='</tr>'});h+='</tbody></table>';if(totalPages>1)h+=`<div class="pagination"><button onclick="goToPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>◀</button><span>${currentPage} / ${totalPages}</span><button onclick="goToPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>▶</button></div>`;ordersContainer.innerHTML=h}
function goToPage(p){if(p<1||p>totalPages)return;loadOrders(searchInput?.value||'',p)}

function openOrder(id){const o=orders.find(x=>String(x.id)===String(id));if(!o)return;selectedOrderId=id;renderModal(o);phaseModal.classList.remove('hidden')}

// ============ NAZIVI FAZA ============
const PHASE_LABELS={'100':'Krojenje','200':'Serigrafija','300':'Vez','400':'Šivenje','500':'Poslato'};
function phaseLabel(p){return PHASE_LABELS[String(p)]||`Faza ${p}`}

// ============ IKONICE FAZA (medaljoni na "prošivenoj" liniji) ============
const PHASE_ICONS={'100':'✂️','200':'🖨️','300':'🧵','400':'🪡','500':'📦'};
function phaseIcon(p){return PHASE_ICONS[String(p)]||'●'}

// ============ ZAKLJUČAVANJE PO DANU (isto pravilo kao na serveru) ============
// - Ako faza nikad nije dirana ILI je zadnji put dirana DANAS -> otvorena za klijenta.
// - Ako je zadnja izmena bila ranijeg dana:
//     - status 'problem' -> jedino dozvoljeno dugme "Urađeno" (ostalo zaključano)
//     - svaki drugi status -> potpuno zaključano
function isSameLocalDay(iso){
  if(!iso) return false;
  const d=new Date(iso), n=new Date();
  return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
}
function phaseLockState(p){
  if(currentUser?.role==='admin') return {locked:false, onlyCompleteAllowed:false};
  const hasActivity=(p.status && p.status!=='pending') || (p.comment && p.comment.trim()!=='');
  if(!hasActivity) return {locked:false, onlyCompleteAllowed:false};
  if(isSameLocalDay(p.updatedAt)) return {locked:false, onlyCompleteAllowed:false};
  if(p.status==='problem') return {locked:true, onlyCompleteAllowed:true};
  return {locked:true, onlyCompleteAllowed:false};
}

// ============ RENDER MODAL – prošivena linija kroz faze, zaključavanje po danu, Napomena ============
function renderModal(o){
  modalOrderNumber.textContent=o.orderNumber||'N/A';
  const isAdmin=currentUser?.role==='admin';
  const isOwnCompany=o.company===currentUser?.company;
  const firmaLine=(isAdmin||isOwnCompany)?`<p><b>Firma:</b> ${esc(o.company)}</p>`:'';
  modalOrderInfo.innerHTML=`${firmaLine}<p><b>Artikal:</b> ${esc(o.name)}</p><p><b>Šifra:</b> ${esc(o.code)}</p><p><b>Količina:</b> ${o.quantity||0}</p><p><b>Datum isporuke:</b> ${esc(o.deliveryDate||'-')}</p>`;

  const progress=o.progress||[];
  const phases=progress.filter(p=>p.phase!=='NAPOMENA');
  const napomena=progress.find(p=>p.phase==='NAPOMENA');

  let h='<div class="phase-timeline">';
  phases.forEach(p=>{
    const stateClass = p.status==='completed' ? 'phase-row--completed' : p.status==='problem' ? 'phase-row--problem' : '';
    const label = p.status==='completed' ? 'URAĐENO' : p.status==='problem' ? 'PROBLEM' : 'NA ČEKANJU';
    const hasActivity = (p.status && p.status!=='pending') || (p.comment && p.comment.trim()!=='');
    const dateStr = hasActivity && p.updatedAt ? date(p.updatedAt) : null;
    // Trajni datum "Problem prijavljen ..." - ostaje vidljiv i posle prelaska na Urađeno
    const problemDateStr = p.lastProblemAt && p.status!=='problem' ? date(p.lastProblemAt) : null;
    const lock=phaseLockState(p);

    let actionsHtml='';
    if(lock.locked && !lock.onlyCompleteAllowed){
      actionsHtml=`<div class="phase-actions"><span class="phase-state" style="background:var(--paper)">🔒 Zaključano — obratite se administratoru</span></div>`;
    } else if(lock.locked && lock.onlyCompleteAllowed){
      actionsHtml=`<div class="phase-actions">
          <button class="btn-tag btn-tag--done" onclick="updatePhase(${o.id},'${js(p.phase)}','completed')">✅ Urađeno</button>
        </div>`;
    } else {
      actionsHtml=`<div class="phase-actions">
          <button class="btn-tag btn-tag--done" onclick="updatePhase(${o.id},'${js(p.phase)}','completed')">✅ Urađeno</button>
          <button class="btn-tag btn-tag--problem" onclick="updatePhase(${o.id},'${js(p.phase)}','problem')">⚠️ Problem</button>
          ${isAdmin ? `<button class="btn-tag btn-tag--reset" onclick="updatePhase(${o.id},'${js(p.phase)}','pending')">⬜ Reset</button>` : ''}
        </div>`;
    }

    const noteHtml = lock.locked
      ? (p.comment ? `<div class="phase-note" style="background:var(--paper);cursor:default">${esc(p.comment)}</div>` : '')
      : `<textarea class="phase-note" onblur="saveComment(${o.id},'${js(p.phase)}',this.value)" placeholder="Komentar...">${esc(p.comment||'')}</textarea>`;

    h+=`<div class="phase-row ${stateClass}">
      <div class="phase-spine">
        <div class="phase-medallion">${phaseIcon(p.phase)}</div>
        <div class="phase-connector"></div>
      </div>
      <div class="phase-content">
        <div class="phase-head">
          <span class="phase-name">${esc(phaseLabel(p.phase))}</span>
          <span class="phase-state">${label}</span>
          ${dateStr ? `<span class="phase-date">📅 ${dateStr}</span>` : ''}
        </div>
        ${problemDateStr ? `<div class="phase-date" style="margin-top:-4px;margin-bottom:6px">⚠️ Problem prijavljen ${problemDateStr}</div>` : ''}
        ${actionsHtml}
        ${noteHtml}
      </div>
    </div>`;
  });
  h+='</div>';

  // ============ NAPOMENA (opšte polje, van faza, ista logika zaključavanja) ============
  const nLock = napomena ? phaseLockState(napomena) : {locked:false};
  const nComment = napomena?.comment || '';
  const nDate = napomena?.updatedAt && (nComment.trim()!=='') ? date(napomena.updatedAt) : null;
  h+=`<div class="phase-row" style="margin-top:6px">
      <div class="phase-spine">
        <div class="phase-medallion">📝</div>
      </div>
      <div class="phase-content" style="border-bottom:none">
        <div class="phase-head">
          <span class="phase-name">Napomena</span>
          ${nDate ? `<span class="phase-date">📅 ${nDate}</span>` : ''}
        </div>
        ${nLock.locked
          ? (nComment ? `<div class="phase-note" style="background:var(--paper);cursor:default;margin-top:8px">${esc(nComment)}</div><div class="phase-date" style="margin-top:6px">🔒 Zaključano — obratite se administratoru</div>` : `<div class="phase-date" style="margin-top:8px">🔒 Zaključano — obratite se administratoru</div>`)
          : `<textarea class="phase-note" style="margin-top:8px" onblur="saveComment(${o.id},'NAPOMENA',this.value)" placeholder="Napomena...">${esc(nComment)}</textarea>`}
      </div>
    </div>`;

  phasesContainer.innerHTML=phases.length ? h : 'Nema faza';
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
window.openOrder=openOrder;window.goToPage=goToPage;window.updatePhase=updatePhase;window.saveComment=saveComment;window.deleteUser=deleteUser;