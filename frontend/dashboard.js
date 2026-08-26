// PRODUCTION TRACKER - orders.js
let currentUser=null,orders=[],selectedOrderId=null,currentPage=1,totalPages=1,totalOrders=0;
const LIMIT=100;
const $=id=>document.getElementById(id);
const token=localStorage.getItem('token'),userStr=localStorage.getItem('user');
if(!token||!userStr){location.href='index.html'}else{try{currentUser=JSON.parse(userStr)}catch(e){localStorage.clear();location.href='index.html'}}
const companyDisplay=$('companyDisplay'),adminPanel=$('adminPanel'),ordersContainer=$('ordersContainer'),searchInput=$('searchInput'),searchBtn=$('searchBtn'),clearSearchBtn=$('clearSearchBtn'),logoutBtn=$('logoutBtn'),sendReportBtn=$('sendReportBtn'),changePasswordBtn=$('changePasswordBtn'),phaseModal=$('phaseModal'),modalOrderNumber=$('modalOrderNumber'),modalOrderInfo=$('modalOrderInfo'),phasesContainer=$('phasesContainer'),closeModal=document.querySelector('.close-modal'),orderCount=$('orderCount');
if(companyDisplay)companyDisplay.textContent=currentUser?.company||'';
const headers=json=>{const h={Authorization:`Bearer ${token}`};if(json)h['Content-Type']='application/json';return h};
async function api(url,opt={}){const r=await fetch(url,opt);let d={};try{d=await r.json()}catch(_){}if(r.status===401){localStorage.clear();location.href='index.html';throw Error('Sesija je istekla.')}if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d}

document.addEventListener('DOMContentLoaded',()=>{if(currentUser?.role==='admin'){adminPanel?.classList.remove('hidden');addAdminControls();loadUsers()}addClientExportControls();if(currentUser?.role==='kontrola'){addKontrolaControls()}loadOrders();checkReminders()});

// ============ PODSETNICI (reparacije čiji je rok istekao) ============
async function checkReminders(){
  try{
    const d=await api('/api/reminders',{headers:headers()});
    const list=d.reminders||[];
    if(list.length===0)return;
    showRemindersModal(list);
  }catch(e){console.error('Reminders error:',e.message)}
}

function showRemindersModal(list){
  let div=$('remindersModal');
  if(!div){
    div=document.createElement('div');
    div.id='remindersModal';div.className='modal';
    document.body.appendChild(div);
  }
  const rows=list.map(r=>{
    const days=Math.floor((Date.now()-new Date(r.deadlineDate).getTime())/86400000);
    const waitLabel=r.waitingOn==='kontrola'?'čeka potvrdu Kontrole':r.waitingOn==='klijent'?'čeka Vašu potvrdu':'čeka potvrdu obe strane';
    return `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer" onclick="closeRemindersModal();openOrder(${r.orderId})">
      <b>Nalog #${esc(r.orderNumber)}</b>${r.name?` — ${esc(r.name)}`:''}<br>
      <span style="color:var(--muted);font-size:13px">${esc(r.company)} — kasni ${days} ${days===1?'dan':'dana'} — ${waitLabel}</span>
    </div>`;
  }).join('');
  div.innerHTML=`<div class="modal-content" style="max-width:520px">
    <span class="close-modal" onclick="closeRemindersModal()">&times;</span>
    <h2 style="font-size:18px">⏰ Podsetnik — reparacije čiji je rok istekao</h2>
    <div style="margin-top:12px;max-height:60vh;overflow-y:auto">${rows}</div>
  </div>`;
  div.classList.remove('hidden');
}
function closeRemindersModal(){$('remindersModal')?.classList.add('hidden')}
let searchDebounce=null;
searchInput?.addEventListener('input',()=>{clearTimeout(searchDebounce);searchDebounce=setTimeout(()=>loadOrders(searchInput.value,1),300)});
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

// ============ EXPORT ZA KLIJENTA (iskljucivo njegova firma + njegove licne aktivnosti) ============
function addClientExportControls(){
  if(currentUser?.role==='admin')return;
  if($('clientExportPanel'))return;
  const div=document.createElement('div');div.id='clientExportPanel';div.className='panel';
  div.innerHTML=`<div class="panel-header"><h2>📊 Moj izveštaj</h2></div>
    <div class="panel-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="date" id="myDateFrom" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <input type="date" id="myDateTo" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <button id="myExportBtn" class="btn-success">📥 Preuzmi Excel</button>
      </div>
      <div id="myExportStatus" style="margin-top:8px"></div>
    </div>`;
  adminPanel?.insertAdjacentElement('afterend',div);
  $('myExportBtn').onclick=exportMyHistory;
}
async function exportMyHistory(){
  const status=$('myExportStatus');
  const dateFrom=$('myDateFrom')?.value||'';
  const dateTo=$('myDateTo')?.value||'';
  status.textContent='⏳ Generišem Excel...';status.className='';
  try{
    const params=new URLSearchParams();
    if(dateFrom)params.append('dateFrom',dateFrom);
    if(dateTo)params.append('dateTo',dateTo);
    const r=await fetch(`/api/history/export?${params.toString()}`,{headers:headers()});
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||`HTTP ${r.status}`)}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`moja_istorija_${dateFrom||'x'}_${dateTo||'x'}.xlsx`;
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
    status.textContent='✅ Fajl preuzet';status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

// ============ KONTROLA - PANEL SA ŠABLONOM ZA MAIL (Prijem, po firmi/danu) ============
async function addKontrolaControls(){
  if($('kontrolaPanel'))return;
  const div=document.createElement('div');div.id='kontrolaPanel';div.className='panel';
  div.innerHTML=`<div class="panel-header"><h2>📋 Šablon za Prijem (mail)</h2></div>
    <div class="panel-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="prijemTplCompany" style="padding:10px;border:2px solid var(--line);border-radius:6px;flex:1;min-width:150px;font-family:var(--font-body);background:var(--card)">
          <option value="">Izaberi firmu...</option>
        </select>
        <input type="date" id="prijemTplDate" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <button id="prijemTplGenBtn" class="btn-success">📋 Generiši</button>
      </div>
      <textarea id="prijemTplResult" class="phase-note" readonly style="margin-top:10px;min-height:180px;font-family:var(--font-mono);font-size:12.5px" placeholder="Ovde će se pojaviti tekst spreman za copy-paste u mail..."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button id="prijemTplCopyBtn" class="btn-secondary">📋 Kopiraj tekst</button>
      </div>
      <div id="prijemTplStatus" style="margin-top:8px"></div>
    </div>`;
  const anchor=$('clientExportPanel')||adminPanel;
  anchor?.insertAdjacentElement('afterend',div);

  const dateInput=$('prijemTplDate');
  if(dateInput)dateInput.value=new Date().toISOString().slice(0,10);

  try{
    const companies=await api('/api/companies',{headers:headers()});
    const sel=$('prijemTplCompany');
    if(sel)sel.innerHTML='<option value="">Izaberi firmu...</option>'+companies.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }catch(e){console.error(e)}

  $('prijemTplGenBtn').onclick=generatePrijemTemplate;
  $('prijemTplCopyBtn').onclick=copyPrijemTemplate;
}

async function generatePrijemTemplate(){
  const status=$('prijemTplStatus');
  const company=$('prijemTplCompany')?.value||'';
  const date=$('prijemTplDate')?.value||'';
  if(!company){status.textContent='❌ Izaberi firmu.';status.className='error';return}
  status.textContent='⏳ Generišem...';status.className='';
  try{
    const params=new URLSearchParams();
    params.append('company',company);
    if(date)params.append('date',date);
    const d=await api(`/api/prijem-template?${params.toString()}`,{headers:headers()});
    $('prijemTplResult').value=d.text||'';
    status.textContent='✅ Spremno - kopiraj i zalepi u mail';status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

async function copyPrijemTemplate(){
  const ta=$('prijemTplResult');
  const status=$('prijemTplStatus');
  if(!ta?.value){status.textContent='❌ Nema teksta za kopiranje - prvo generiši.';status.className='error';return}
  try{
    await navigator.clipboard.writeText(ta.value);
    status.textContent='✅ Tekst kopiran u clipboard';status.className='success';
  }catch(e){
    ta.select();document.execCommand('copy');
    status.textContent='✅ Tekst kopiran (fallback)';status.className='success';
  }
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

$('createUserForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/users',{method:'POST',headers:headers(true),body:JSON.stringify({username:$('newUsername').value.trim(),company:$('newCompany').value.trim(),role:$('newRole')?.value||'user'})});$('userStatus').textContent=`✅ Korisnik ${d.user.username} kreiran (${d.user.role==='kontrola'?'Kontrola':'Klijent'})`;$('userStatus').className='success';$('newUsername').value='';$('newCompany').value='';loadUsers();alert(`✅ Korisnik "${d.user.username}" kreiran.\n\n🔑 Lozinka: ${d.password}\n\nZapiši je i prosledi korisniku - prikazuje se samo ovaj put!`)}catch(e){$('userStatus').textContent='❌ '+e.message;$('userStatus').className='error'}});
async function loadUsers(){try{const u=await api('/api/users',{headers:headers()});const x=$('usersList');if(x)x.innerHTML=u.map(a=>`<div class="user-item" style="grid-template-columns:1fr 1fr auto auto auto"><span>${esc(a.username)}</span><span>${esc(a.company)}</span><span>${esc(a.role)}</span><span class="clickable" style="color:var(--denim);font-weight:700" onclick="resetPassword(${a.id},'${js(a.username)}')" title="Resetuj lozinku">🔑</span>${a.role!=='admin'?`<span class="clickable" style="color:var(--red);font-weight:700" onclick="deleteUser(${a.id},'${js(a.username)}')" title="Obriši korisnika">🗑️</span>`:'<span></span>'}</div>`).join('')||'Nema korisnika';const sel=$('historyCompany');if(sel){const companies=[...new Set(u.map(a=>a.company).filter(Boolean))].sort();sel.innerHTML='<option value="">Sve firme</option>'+companies.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}}catch(e){console.error(e)}}

async function resetPassword(id,username){
  if(!confirm(`Generisati novu lozinku za "${username}"? Stara prestaje da važi.`))return;
  try{
    const d=await api(`/api/users/${id}/reset-password`,{method:'POST',headers:headers()});
    $('userStatus').textContent='✅ '+d.message;$('userStatus').className='success';
    alert(`🔑 Nova lozinka za "${username}": ${d.password}\n\nZapiši je i prosledi korisniku - prikazuje se samo ovaj put!`);
  }catch(e){$('userStatus').textContent='❌ '+e.message;$('userStatus').className='error'}
}

async function deleteUser(id,username){
  if(!confirm(`Obrisati korisnika "${username}"? Ova akcija se ne može poništiti.`))return;
  try{
    const d=await api(`/api/users/${id}`,{method:'DELETE',headers:headers()});
    $('userStatus').textContent='✅ '+d.message;$('userStatus').className='success';
    loadUsers();
  }catch(e){$('userStatus').textContent='❌ '+e.message;$('userStatus').className='error'}
}
sendReportBtn?.addEventListener('click',async()=>{if(!confirm('📧 Pošalji dnevni izveštaj?'))return;try{alert((await api('/api/send-report',{method:'POST',headers:headers(true),body:JSON.stringify({date:new Date().toLocaleDateString('sr-RS')})})).message)}catch(e){alert('❌ '+e.message)}});

changePasswordBtn?.addEventListener('click',async()=>{
  const currentPassword=prompt('Unesi TRENUTNU lozinku:');
  if(!currentPassword)return;
  const newPassword=prompt('Unesi NOVU lozinku (bar 6 karaktera):');
  if(!newPassword)return;
  const confirmPassword=prompt('Ponovi NOVU lozinku:');
  if(newPassword!==confirmPassword){alert('❌ Nova lozinka i potvrda se ne poklapaju.');return}
  try{
    const d=await api('/api/change-password',{method:'POST',headers:headers(true),body:JSON.stringify({currentPassword,newPassword})});
    alert(d.message);
  }catch(e){alert('❌ '+e.message)}
});

async function loadOrders(search='',page=1){try{const u=search?`/api/orders?search=${encodeURIComponent(search)}&page=${page}&limit=${LIMIT}`:`/api/orders?page=${page}&limit=${LIMIT}`;ordersContainer.innerHTML='<div class="loading">⏳ Učitavanje...</div>';const d=await api(u,{headers:headers()});orders=d.data||[];totalOrders=d.total||0;currentPage=d.page||1;totalPages=d.totalPages||1;if(orderCount)orderCount.textContent=`${totalOrders} naloga`;renderOrders();if(selectedOrderId&&!phaseModal?.classList.contains('hidden')){const o=orders.find(x=>String(x.id)===String(selectedOrderId));if(o)renderModal(o);else phaseModal.classList.add('hidden')}}catch(e){ordersContainer.innerHTML=`<div class="error">❌ ${esc(e.message)}</div>`}}
// ============ STATUS NALOGA (glavna lista) ============
function computeOrderStatus(o){
  const knownPhases=['100','200','300','400','500'];
  const p=o.progress||[];
  const findRow=ph=>p.find(x=>String(x.phase)===ph);

  // 1) Prijem/Reparacija/Anulirano ima prioritet dok je otvoreno
  if(o.prijem && o.prijem.status==='problem'){
    let parsed={};
    try{parsed=JSON.parse(o.prijem.comment||'{}')}catch(_){}
    if(parsed.outcome==='anulirano'){
      return ['❌ ANULIRANO','status-problem'];
    }
    if(parsed.outcome==='reparacija'){
      const rep=o.reparacija;
      if(!rep || !rep.kontrolaConfirmedAt){
        return ['🔧 REPARACIJA','status-problem'];
      }
      // rep.kontrolaConfirmedAt postoji -> reparacija zatvorena, nastavi na normalnu proveru ispod
    }
  }

  // 2) Problem u bilo kojoj od prvih 5 faza
  const hasProblem=knownPhases.some(ph=>{const r=findRow(ph);return r && r.status==='problem'});
  if(hasProblem)return ['⚠️ Problem','status-problem'];

  // 3) Svih 5 faza završeno (Serigrafija/Vez "Nema" se računa kao završeno)
  const doneCount=knownPhases.filter(ph=>{const r=findRow(ph);return r && (r.status==='completed'||r.status==='nema')}).length;
  if(doneCount===knownPhases.length)return ['✅ U redu','status-completed'];

  // 4) U toku
  return doneCount>0?[`${doneCount}/${knownPhases.length}`,'status-pending']:['U toku','status-pending'];
}

function renderOrders(){if(!orders.length){ordersContainer.innerHTML='<p style="text-align:center;padding:40px;color:var(--muted)">📭 Nema naloga za prikaz</p>';return}const admin=currentUser?.role==='admin'||currentUser?.role==='kontrola';let h='<table><thead><tr>'+(admin?'<th>Firma</th><th>Šifra</th><th>Naziv</th><th>Nalog</th><th>Količina</th><th>Datum</th><th>Status</th>':'<th>Nalog</th><th>Naziv</th><th>Količina</th><th>Status</th>')+'</tr></thead><tbody>';orders.forEach((o,i)=>{const st=computeOrderStatus(o);h+=`<tr style="${i%2===0?'background:var(--paper)':''}">`;if(admin)h+=`<td>${esc(o.company)}</td><td class="clickable" style="cursor:default;font-weight:600">${esc(o.code)}</td><td>${esc(o.name)}</td><td class="clickable" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td style="text-align:center">${o.quantity||0}</td><td>${esc(o.deliveryDate||'-')}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;else h+=`<td class="clickable" onclick="openOrder(${o.id})">${esc(o.orderNumber)}</td><td>${esc(o.name)}</td><td style="text-align:center">${o.quantity||0}</td><td><span class="status-badge ${st[1]}">${st[0]}</span></td>`;h+='</tr>'});h+='</tbody></table>';if(totalPages>1)h+=`<div class="pagination"><button onclick="goToPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>◀</button><span>${currentPage} / ${totalPages}</span><button onclick="goToPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>▶</button></div>`;ordersContainer.innerHTML=h}
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
  // "Nema" se zaključava po ISTOJ logici kao i ostale faze (ne trajno/odmah) - vidi ispod.
  const hasActivity=(p.status && p.status!=='pending') || (p.comment && p.comment.trim()!=='');
  if(!hasActivity) return {locked:false, onlyCompleteAllowed:false};
  if(isSameLocalDay(p.updatedAt)) return {locked:false, onlyCompleteAllowed:false};
  if(p.status==='problem') return {locked:true, onlyCompleteAllowed:true};
  return {locked:true, onlyCompleteAllowed:false};
}

// ============ RENDER MODAL – prošivena linija kroz faze, zaključavanje po danu, Napomena, Prijem ============
function renderModal(o){
  modalOrderNumber.textContent=o.orderNumber||'N/A';
  const isAdmin=currentUser?.role==='admin';
  const isKontrola=currentUser?.role==='kontrola';
  const isPrivileged=isAdmin||isKontrola;
  const isOwnCompany=o.company===currentUser?.company;
  const firmaLine=(isPrivileged||isOwnCompany)?`<p><b>Firma:</b> ${esc(o.company)}</p>`:'';
  modalOrderInfo.innerHTML=`${firmaLine}<p><b>Artikal:</b> ${esc(o.name)}</p><p><b>Šifra:</b> ${esc(o.code)}</p><p><b>Količina:</b> ${o.quantity||0}</p><p><b>Datum isporuke:</b> ${esc(o.deliveryDate||'-')}</p>`;

  const progress=o.progress||[];
  const phases=progress.filter(p=>p.phase!=='NAPOMENA' && p.phase!=='PRIJEM');
  const napomena=progress.find(p=>p.phase==='NAPOMENA');
  const prijem=progress.find(p=>p.phase==='PRIJEM');

  // ============ NALOG JE RADIO NEKO IZ DRUGE FIRME (samo Kontrola/Admin vide) ============
  // Klijent može da nađe i obradi tuđi nalog (npr. preko pretrage). Ovde to prikazujemo
  // Kontroli/Adminu: nalog je NAMENJEN firmi X, ali je poslednju izmenu uradio korisnik iz firme Y.
  if(isPrivileged){
    const foreignEdits=phases
      .filter(p=>p.updatedByCompany && p.updatedByCompany!==o.company && (p.status && p.status!=='pending' || (p.comment&&p.comment.trim()!=='')))
      .sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));
    if(foreignEdits.length){
      const last=foreignEdits[0];
      modalOrderInfo.innerHTML+=`<p style="background:#FFF3CD;border:1px solid #FFE69C;border-radius:6px;padding:8px 10px;margin-top:8px">
        ⚠️ <b>Nalog je namenjen firmi "${esc(o.company)}"</b>, ali ga je poslednji radio: <b>${esc(last.updatedBy||'?')}</b> (firma "${esc(last.updatedByCompany)}") — faza ${esc(phaseLabel(last.phase))}${last.updatedAt?`, ${date(last.updatedAt)}`:''}.
      </p>`;
    }
  }

  let h='<div class="phase-timeline">';
  const knownOrder=['100','200','300','400','500'];
  const findPhaseRow=ph=>phases.find(x=>String(x.phase)===ph);
  phases.forEach(p=>{
    const stateClass = p.status==='completed' ? 'phase-row--completed' : p.status==='problem' ? 'phase-row--problem' : '';
    const hasActivity = (p.status && p.status!=='pending') || (p.comment && p.comment.trim()!=='');
    const dateStr = hasActivity && p.updatedAt ? date(p.updatedAt) : null;
    const comment = (p.comment||'').trim();
    const lock = isKontrola ? {locked:true, onlyCompleteAllowed:false} : phaseLockState(p);

    // Redosled faza (samo klijent) - ne može da obeleži fazu dok prethodne nisu rešene (Urađeno/Nema)
    let sequenceBlockedOn=null;
    if(!isPrivileged){
      const idx=knownOrder.indexOf(String(p.phase));
      if(idx>0){
        for(let i=0;i<idx;i++){
          const priorRow=findPhaseRow(knownOrder[i]);
          const priorStatus=priorRow?.status;
          if(!priorRow || priorStatus==='pending' || priorStatus==='problem'){
            sequenceBlockedOn=knownOrder[i];
            break;
          }
        }
      }
    }

    // Bedž: samo ikonica + datum (bez reči "Urađeno"/"Problem"). Za Problem: ikonica+datum+tekst u jednoj liniji.
    let badge='';
    if(p.status==='completed'){
      badge=`<span class="phase-state">✅${dateStr?` ${dateStr}`:''}</span>`;
    } else if(p.status==='problem'){
      badge=`<span class="phase-state">⚠️${dateStr?` ${dateStr}`:''}${comment?` — ${esc(comment)}`:''}</span>`;
    } else if(p.status==='nema'){
      badge=`<span class="phase-state">🚫 Nema${dateStr?` ${dateStr}`:''}</span>`;
    }
    // Dugme "Nema" - samo za Serigrafiju (200) i Vez (300), za artikle koji tu operaciju nemaju
    const showNemaBtn = (p.phase==='200' || p.phase==='300');
    // Trajna istorija "Problem" (ostaje vidljivo i posle prelaska na Urađeno), sa tekstom koji ga je pratio
    const problemDateStr = p.lastProblemAt && p.status!=='problem' ? date(p.lastProblemAt) : null;
    const problemComment = (p.lastProblemComment||'').trim();
    const problemLine = problemDateStr ? `<div class="phase-date" style="margin-top:-4px;margin-bottom:6px">⚠️ ${problemDateStr}${problemComment?` — ${esc(problemComment)}`:''}</div>` : '';
    // Ova faza je radio neko iz druge firme od firme kojoj nalog pripada (vidljivo Kontroli/Adminu)
    const foreignLine = (isPrivileged && p.updatedByCompany && p.updatedByCompany!==o.company)
      ? `<div class="phase-date" style="margin-top:-4px;margin-bottom:6px;color:#9C6B00">👤 Radio: ${esc(p.updatedBy||'?')} (firma "${esc(p.updatedByCompany)}")</div>`
      : '';

    let bodyHtml='';
    if(sequenceBlockedOn){
      bodyHtml=`<div class="phase-date" style="color:var(--muted)">⛔ Prvo rešite fazu "${esc(phaseLabel(sequenceBlockedOn))}"</div>`;
    } else if(lock.locked){
      // Zaključano: kompaktan prikaz, katanac je već u naslovnoj liniji (bez teksta).
      const lockedExtra = (p.status==='completed' && comment) ? `<div class="phase-date" style="margin-top:2px">${esc(comment)}</div>` : '';
      bodyHtml=`${lockedExtra}
        ${lock.onlyCompleteAllowed
          ? `<div class="phase-actions"><button class="btn-tag btn-tag--done" onclick="updatePhase(${o.id},'${js(p.phase)}','completed')">✅ Urađeno</button></div>`
          : ''}`;
    } else {
      bodyHtml=`<div class="phase-actions">
          <button class="btn-tag btn-tag--done" onclick="updatePhase(${o.id},'${js(p.phase)}','completed')">✅ Urađeno</button>
          <button class="btn-tag btn-tag--problem" onclick="updatePhase(${o.id},'${js(p.phase)}','problem')">⚠️ Problem</button>
          ${showNemaBtn ? `<button class="btn-tag btn-tag--reset" onclick="updatePhase(${o.id},'${js(p.phase)}','nema')">🚫 Nema</button>` : ''}
          ${isAdmin ? `<button class="btn-tag btn-tag--reset" onclick="updatePhase(${o.id},'${js(p.phase)}','pending')">⬜ Reset</button>` : ''}
        </div>
        <textarea class="phase-note" onblur="saveComment(${o.id},'${js(p.phase)}',this.value)" placeholder="Komentar...">${esc(p.comment||'')}</textarea>`;
    }

    const lockIcon = (lock.locked && !lock.onlyCompleteAllowed) ? `<span class="phase-lock" title="Zaključano — obratite se administratoru">🔒</span>` : '';

    h+=`<div class="phase-row ${stateClass}">
      <div class="phase-spine">
        <div class="phase-medallion">${phaseIcon(p.phase)}</div>
        <div class="phase-connector"></div>
      </div>
      <div class="phase-content">
        <div class="phase-head">
          <span class="phase-name">${esc(phaseLabel(p.phase))}</span>
          ${badge}
          ${lockIcon}
        </div>
        ${problemLine}
        ${foreignLine}
        ${bodyHtml}
      </div>
    </div>`;
  });
  h+='</div>';

  // ============ NAPOMENA (opšte polje, van faza, ista logika zaključavanja) ============
  const nLock = napomena ? (isKontrola ? {locked:true, onlyCompleteAllowed:false} : phaseLockState(napomena)) : {locked:false};
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
          ${nLock.locked ? `<span class="phase-lock" title="Zaključano — obratite se administratoru">🔒</span>` : ''}
        </div>
        ${(isPrivileged && napomena?.updatedByCompany && napomena.updatedByCompany!==o.company) ? `<div class="phase-date" style="margin-top:-4px;margin-bottom:6px;color:#9C6B00">👤 Radio: ${esc(napomena.updatedBy||'?')} (firma "${esc(napomena.updatedByCompany)}")</div>` : ''}
        ${nLock.locked
          ? (nComment ? `<div class="phase-date" style="margin-top:2px">${esc(nComment)}</div>` : '')
          : `<textarea class="phase-note" style="margin-top:8px" onblur="saveComment(${o.id},'NAPOMENA',this.value)" placeholder="Napomena...">${esc(nComment)}</textarea>`}
      </div>
    </div>`;

  // ============ REPARACIJA - poseban blok SAMO za klijenta (nema pristup kartici Prijem) ============
  const rep=o.reparacija;
  if(!isPrivileged && rep){
    const items=formatPrijemItems(rep.items);
    const clientDone=!!rep.clientConfirmedAt;
    const kontrolaDone=!!rep.kontrolaConfirmedAt;
    let repBody;
    if(kontrolaDone){
      repBody=`<div class="phase-date">✅ Zatvoreno ${date(rep.kontrolaConfirmedAt)}</div>`;
    } else if(clientDone){
      repBody=`<div class="phase-date" style="margin-bottom:4px">✅ Potvrđeno: ${esc(rep.clientConfirmedBy||'?')} — ${date(rep.clientConfirmedAt)}</div>
        <div class="phase-date" style="color:var(--muted)">⏳ Čeka potvrdu Kontrole</div>`;
    } else {
      repBody=`<div class="phase-date" style="margin-bottom:6px">🔧 ${date(rep.createdAt)}${items?` — ${esc(items)}`:''}${rep.note?` — ${esc(rep.note)}`:''}</div>
        <div class="phase-actions"><button class="btn-tag btn-tag--done" onclick="confirmReparacijaClient(${rep.id})">✅ Urađeno</button></div>`;
    }
    h+=`<div class="phase-row" style="margin-top:6px">
      <div class="phase-spine">
        <div class="phase-medallion">🔧</div>
      </div>
      <div class="phase-content" style="border-bottom:none">
        <div class="phase-head">
          <span class="phase-name">Reparacija</span>
          ${!kontrolaDone ? `<span class="phase-date">Rok: ${rep.deadlineDate?date(rep.deadlineDate):'-'}</span>` : ''}
        </div>
        ${repBody}
      </div>
    </div>`;
  }

  // ============ PRIJEM (samo admin i Kontrola) - reparacija tok je integrisan direktno ovde, bez posebne kartice ============
  if(isPrivileged && prijem){
    const pLock = isAdmin ? {locked:false,onlyCompleteAllowed:false} : phaseLockState(prijem);
    let pBadge='';
    let pBody='';
    let pParsed=null;
    if(prijem.status==='completed'){
      const d = prijem.updatedAt ? date(prijem.updatedAt) : null;
      pBadge = `<span class="phase-state">✅${d?` ${d}`:''}</span>`;
    } else if(prijem.status==='problem'){
      pParsed = parsePrijemData(prijem.comment);
      const d = prijem.updatedAt ? date(prijem.updatedAt) : null;
      const icon = pParsed.outcome==='anulirano' ? '❌ ANULIRANO' : '🔧 REPARACIJA';
      const items = formatPrijemItems(pParsed.items);
      pBadge = `<span class="phase-state">${icon}${d?` ${d}`:''}${items?` — ${esc(items)}`:''}${pParsed.note?` — ${esc(pParsed.note)}`:''}</span>`;
    }
    const pLockIcon = (pLock.locked && !pLock.onlyCompleteAllowed) ? `<span class="phase-lock" title="Zaključano — obratite se administratoru">🔒</span>` : '';

    if(pLock.locked && !pLock.onlyCompleteAllowed){
      pBody = '';
    } else if(pLock.locked && pLock.onlyCompleteAllowed){
      pBody = `<div class="phase-actions"><button class="btn-tag btn-tag--done" onclick="submitPrijemOk(${o.id})">✅ Sve u redu</button></div>`;
    } else {
      pBody = `<div class="phase-actions" id="prijemActions-${o.id}">
          <button class="btn-tag btn-tag--done" onclick="submitPrijemOk(${o.id})">✅ Sve u redu</button>
          <button class="btn-tag btn-tag--problem" onclick="togglePrijemChoice(${o.id})">⚠️ Problem</button>
        </div>
        <div id="prijemChoice-${o.id}" class="hidden" style="margin:6px 0">
          <div class="phase-actions">
            <button class="btn-tag btn-tag--problem" onclick="openSizeModal(${o.id},'reparacija')">🔧 Reparacija</button>
            <button class="btn-tag btn-tag--problem" onclick="openSizeModal(${o.id},'anulirano')">❌ Anulirano</button>
          </div>
        </div>`;
    }

    // Reparacija - kompletna logika toka (klijent urađeno -> kontrola sve u redu) prikazana direktno ispod Prijema
    let repSection='';
    if(pParsed && pParsed.outcome==='reparacija' && rep){
      if(rep.kontrolaConfirmedAt){
        repSection=`<div class="phase-date" style="margin-top:8px">✅ Potvrđeno ${date(rep.kontrolaConfirmedAt)}</div>`;
      } else if(rep.clientConfirmedAt){
        repSection=`<div class="phase-date" style="margin-top:8px">${date(rep.clientConfirmedAt)} — ${esc(rep.clientConfirmedBy||'')}</div>
          <div class="phase-actions"><button class="btn-tag btn-tag--done" onclick="confirmReparacijaKontrola(${rep.id})">✅ Sve u redu</button></div>`;
      } else {
        repSection=`<div class="phase-date" style="margin-top:8px;color:var(--muted)">⏳ Čeka potvrdu klijenta (rok: ${rep.deadlineDate?date(rep.deadlineDate):'-'})</div>`;
      }
    }

    h+=`<div class="phase-row" style="margin-top:6px">
      <div class="phase-spine">
        <div class="phase-medallion">📥</div>
      </div>
      <div class="phase-content" style="border-bottom:none">
        <div class="phase-head">
          <span class="phase-name">Prijem</span>
          ${pBadge}
          ${pLockIcon}
        </div>
        ${pBody}
        ${repSection}
      </div>
    </div>`;
  }

  phasesContainer.innerHTML=phases.length ? h : 'Nema faza';
}

// ============ REPARACIJA - potvrde ============
async function confirmReparacijaClient(repId){
  try{
    await api(`/api/reparacija/${repId}/client-confirm`,{method:'POST',headers:headers(true)});
    await loadOrders(searchInput?.value||'',currentPage);
  }catch(e){alert('❌ '+e.message)}
}
async function confirmReparacijaKontrola(repId){
  try{
    await api(`/api/reparacija/${repId}/kontrola-confirm`,{method:'POST',headers:headers(true)});
    await loadOrders(searchInput?.value||'',currentPage);
  }catch(e){alert('❌ '+e.message)}
}

function parsePrijemData(comment){
  try{ return JSON.parse(comment||'{}') }catch(_){ return {} }
}

function togglePrijemChoice(id){
  const el=$(`prijemChoice-${id}`);
  el?.classList.toggle('hidden');
}

async function submitPrijemOk(id){
  const o=orders.find(x=>String(x.id)===String(id));
  const p=o?.progress.find(x=>x.phase==='PRIJEM');
  if(!p)return;
  const old={status:p.status,comment:p.comment,updatedAt:p.updatedAt};
  p.status='completed';p.comment='';p.updatedAt=new Date().toISOString();
  renderModal(o);
  try{
    const d=await api('/api/update-phase',{method:'POST',headers:headers(true),body:JSON.stringify({orderId:id,phase:'PRIJEM',status:'completed',comment:''})});
    p.updatedAt=d.updatedAt;renderModal(o);
  }catch(e){Object.assign(p,old);renderModal(o);alert('❌ '+e.message)}
}

// ============ SIZE MODAL (Reparacija / Anulirano) - kućice 18-46, klik i upiši, uvek "par" ============
const SIZE_RANGE=Array.from({length:46-18+1},(_,i)=>18+i);
let sizeModalOrderId=null, sizeModalOutcome=null;

function ensureSizeModal(){
  if($('sizeModal'))return;
  const div=document.createElement('div');
  div.id='sizeModal';div.className='modal hidden';
  div.innerHTML=`<div class="modal-content" style="max-width:460px">
    <span class="close-modal" onclick="closeSizeModal()">&times;</span>
    <h2 id="sizeModalTitle" style="font-size:18px"></h2>
    <p style="color:var(--muted);font-size:13px;margin-top:8px">Klikni na broj i upiši količinu (par).</p>
    <div id="sizeGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:8px;margin:10px 0"></div>
    <textarea id="sizeNote" class="phase-note" placeholder="Komentar..." style="margin-top:6px"></textarea>
    <div id="sizeDeadlineWrap" class="hidden" style="margin-top:10px">
      <label style="font-size:13px;color:var(--muted)">Rok za podsetnik (dana):</label>
      <input type="number" id="sizeDeadlineDays" min="1" value="7" style="width:70px;margin-left:8px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;text-align:center">
    </div>
    <div class="phase-actions" style="margin-top:12px">
      <button class="btn-tag btn-tag--done" onclick="confirmSizeModal()">✅ Potvrdi</button>
      <button class="btn-tag btn-tag--reset" onclick="closeSizeModal()">Otkaži</button>
    </div>
  </div>`;
  document.body.appendChild(div);
  const grid=$('sizeGrid');
  grid.innerHTML=SIZE_RANGE.map(s=>`
    <div style="text-align:center">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${s}</div>
      <input type="number" min="0" data-size="${s}" class="sizeQtyInput" style="width:100%;padding:6px 4px;border:1px solid var(--line);border-radius:6px;text-align:center;font-size:13px">
    </div>`).join('');
}

function openSizeModal(orderId,outcome){
  ensureSizeModal();
  sizeModalOrderId=orderId;sizeModalOutcome=outcome;
  $('sizeModalTitle').textContent = outcome==='anulirano' ? '❌ Anulirano' : '🔧 Reparacija';
  document.querySelectorAll('.sizeQtyInput').forEach(inp=>inp.value='');
  $('sizeNote').value='';
  const deadlineWrap=$('sizeDeadlineWrap');
  if(outcome==='reparacija'){deadlineWrap.classList.remove('hidden');$('sizeDeadlineDays').value='7'}
  else{deadlineWrap.classList.add('hidden')}
  $('sizeModal').classList.remove('hidden');
}
function closeSizeModal(){$('sizeModal')?.classList.add('hidden');sizeModalOrderId=null;sizeModalOutcome=null}

// Format kao "vel.18 - 2 pa." - koristi se u modulu, Excelu i mail sablonu
function formatPrijemItems(items){
  return (items||[]).map(it=>`vel.${it.size} - ${it.qty} pa.`).join(', ');
}

async function confirmSizeModal(){
  const id=sizeModalOrderId, outcome=sizeModalOutcome;
  if(!id||!outcome)return;
  const items=[...document.querySelectorAll('.sizeQtyInput')]
    .map(inp=>({size:parseInt(inp.dataset.size),qty:parseInt(inp.value)}))
    .filter(it=>it.qty>0);
  const note=$('sizeNote').value.trim();
  if(items.length===0 && !note){alert('Unesi bar jedan broj sa količinom, ili komentar.');return}

  const deadlineDays=outcome==='reparacija' ? (parseInt($('sizeDeadlineDays').value)||7) : undefined;
  const payload=JSON.stringify({outcome,unit:'par',items,note});
  const o=orders.find(x=>String(x.id)===String(id));
  const p=o?.progress.find(x=>x.phase==='PRIJEM');
  if(!p){closeSizeModal();return}
  const old={status:p.status,comment:p.comment,updatedAt:p.updatedAt};
  p.status='problem';p.comment=payload;p.updatedAt=new Date().toISOString();
  closeSizeModal();
  renderModal(o);
  try{
    const body={orderId:id,phase:'PRIJEM',status:'problem',comment:payload};
    if(deadlineDays)body.deadlineDays=deadlineDays;
    const d=await api('/api/update-phase',{method:'POST',headers:headers(true),body:JSON.stringify(body)});
    p.updatedAt=d.updatedAt;
    await loadOrders(searchInput?.value||'',currentPage);
  }catch(e){Object.assign(p,old);renderModal(o);alert('❌ '+e.message)}
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
window.openOrder=openOrder;window.goToPage=goToPage;window.updatePhase=updatePhase;window.saveComment=saveComment;window.deleteUser=deleteUser;window.resetPassword=resetPassword;