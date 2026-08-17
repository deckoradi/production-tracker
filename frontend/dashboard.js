// ============ MINIMALNA RADNA VERZIJA ============
console.log('🔥 MINIMALNA VERZIJA UČITANA!');

// State
let orders = [];
const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');

if (!token || !userStr) {
    window.location.href = 'index.html';
}

const currentUser = JSON.parse(userStr);
document.getElementById('companyDisplay').textContent = currentUser.company;

// Admin panel
if (currentUser.role === 'admin') {
    document.getElementById('adminPanel').classList.remove('hidden');
}

// ============ UČITAVANJE NALOGA ============
async function loadOrders() {
    try {
        console.log('📡 Učitavam naloge...');
        const response = await fetch('/api/orders?limit=100', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        orders = data.data || [];
        console.log('📦 Učitano:', orders.length);
        
        let html = `<table><thead><tr><th>Nalog</th><th>Naziv</th><th>Količina</th><th>Status</th></tr></thead><tbody>`;
        orders.forEach(o => {
            const phases = o.progress || [];
            const done = phases.filter(p => p.status === 'completed').length;
            const total = phases.length;
            html += `<tr><td onclick="openOrder(${o.id})" style="color:#667eea;cursor:pointer;">${o.order_number}</td>
                     <td>${o.name}</td><td>${o.quantity}</td>
                     <td>${done}/${total}</td></tr>`;
        });
        html += `</tbody></table>`;
        document.getElementById('ordersContainer').innerHTML = html;
    } catch(e) {
        console.error('❌ Greška:', e);
    }
}

// ============ OTVARANJE NALOGA ============
function openOrder(orderId) {
    console.log('🔍 Otvaram nalog:', orderId);
    const order = orders.find(o => o.id === orderId);
    if (!order) { alert('Nalog nije pronađen'); return; }
    
    const phases = order.progress || [];
    let html = `<h3>Nalog: ${order.order_number}</h3>
                <p><strong>Artikal:</strong> ${order.name}</p>
                <p><strong>Količina:</strong> ${order.quantity}</p>
                <hr>`;
    
    phases.forEach(p => {
        const emoji = p.status === 'completed' ? '✅' : p.status === 'problem' ? '⚠️' : '⬜';
        html += `<div style="border:1px solid #ddd;padding:10px;margin:5px;border-radius:5px;">
                    <h4>Faza ${p.phase} ${emoji}</h4>
                    <button onclick="updatePhase(${order.id}, '${p.phase}', 'completed')" style="background:#48bb78;color:white;border:none;padding:5px 10px;border-radius:5px;">✅ Završi</button>
                    <button onclick="updatePhase(${order.id}, '${p.phase}', 'problem')" style="background:#fc8181;color:white;border:none;padding:5px 10px;border-radius:5px;">⚠️ Problem</button>
                    <button onclick="updatePhase(${order.id}, '${p.phase}', 'pending')" style="background:#e2e8f0;border:none;padding:5px 10px;border-radius:5px;">⬜ Reset</button>
                    <br><input type="text" placeholder="Komentar..." onchange="updateComment(${order.id}, '${p.phase}', this.value)" style="width:100%;margin-top:5px;padding:5px;" value="${p.comment || ''}">
                </div>`;
    });
    
    document.getElementById('modalOrderNumber').textContent = order.order_number;
    document.getElementById('modalOrderInfo').innerHTML = `<p>Firma: ${order.company}</p>`;
    document.getElementById('phasesContainer').innerHTML = html;
    document.getElementById('phaseModal').classList.remove('hidden');
}

// ============ AŽURIRANJE FAZE ============
async function updatePhase(orderId, phase, status) {
    console.log(`🔄 Menjam ${phase} na ${status}`);
    try {
        const response = await fetch('/api/update-phase', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ orderId, phase, status })
        });
        const data = await response.json();
        console.log('✅ Odgovor:', data);
        
        // Osvježi prikaz
        await loadOrders();
        const order = orders.find(o => o.id === orderId);
        if (order) openOrder(orderId);
    } catch(e) {
        console.error('❌ Greška:', e);
        alert('Greška: ' + e.message);
    }
}

// ============ KOMENTAR ============
async function updateComment(orderId, phase, comment) {
    console.log(`💬 Komentar: ${comment}`);
    try {
        await fetch('/api/update-phase', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ orderId, phase, status: 'pending', comment })
        });
    } catch(e) {
        console.error('❌ Greška:', e);
    }
}

// ============ DUGMAD ============
document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = 'index.html';
});

document.getElementById('closeModal').addEventListener('click', () => {
    document.getElementById('phaseModal').classList.add('hidden');
});

// ============ POKRENI ============
loadOrders();

console.log('✅ Aplikacija pokrenuta!');