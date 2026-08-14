// State
let currentUser = null;
let orders = [];
let selectedOrderId = null;
let currentPage = 1;
let totalPages = 1;
let totalOrders = 0;
const LIMIT = 100;

// DOM Elements
const companyDisplay = document.getElementById('companyDisplay');
const adminPanel = document.getElementById('adminPanel');
const ordersContainer = document.getElementById('ordersContainer');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const logoutBtn = document.getElementById('logoutBtn');
const sendReportBtn = document.getElementById('sendReportBtn');
const phaseModal = document.getElementById('phaseModal');
const modalOrderNumber = document.getElementById('modalOrderNumber');
const modalOrderInfo = document.getElementById('modalOrderInfo');
const phasesContainer = document.getElementById('phasesContainer');
const closeModal = document.querySelector('.close-modal');
const orderCount = document.getElementById('orderCount');

// Check authentication
const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');

if (!token || !userStr) {
    window.location.href = 'index.html';
}

currentUser = JSON.parse(userStr);
companyDisplay.textContent = currentUser.company;

// Show admin panel if admin
if (currentUser.role === 'admin') {
    adminPanel.classList.remove('hidden');
    loadUsers();
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    loadOrders();
});

searchBtn.addEventListener('click', () => {
    currentPage = 1;
    loadOrders(searchInput.value, 1);
});

searchInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        currentPage = 1;
        loadOrders(searchInput.value, 1);
    }
});

clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    currentPage = 1;
    loadOrders('', 1);
});

logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'index.html';
});

closeModal.addEventListener('click', () => {
    phaseModal.classList.add('hidden');
});

window.addEventListener('click', (e) => {
    if (e.target === phaseModal) {
        phaseModal.classList.add('hidden');
    }
});

// Upload form
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('fileInput');
    const statusDiv = document.getElementById('uploadStatus');
    
    if (!fileInput.files[0]) {
        statusDiv.textContent = 'Molimo izaberite fajl';
        statusDiv.className = 'error';
        return;
    }
    
    statusDiv.textContent = '⏳ Učitavanje...';
    statusDiv.className = '';
    
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    
    try {
        const startTime = Date.now();
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        const data = await response.json();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (response.ok) {
            statusDiv.textContent = `✅ Učitano ${data.count} naloga za ${elapsed}s`;
            statusDiv.className = 'success';
            fileInput.value = '';
            currentPage = 1;
            setTimeout(() => loadOrders('', 1), 500);
        } else {
            statusDiv.textContent = `❌ Greška: ${data.error}`;
            statusDiv.className = 'error';
        }
    } catch (error) {
        statusDiv.textContent = '❌ Greška pri upload-u';
        statusDiv.className = 'error';
        console.error('Upload error:', error);
    }
});

// Create user form
document.getElementById('createUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUsername').value;
    const company = document.getElementById('newCompany').value;
    const statusDiv = document.getElementById('userStatus');
    
    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ username, company })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            statusDiv.textContent = `✅ Korisnik ${username} kreiran`;
            statusDiv.className = 'success';
            document.getElementById('newUsername').value = '';
            document.getElementById('newCompany').value = '';
            loadUsers();
        } else {
            statusDiv.textContent = `❌ Greška: ${data.error}`;
            statusDiv.className = 'error';
        }
    } catch (error) {
        statusDiv.textContent = '❌ Greška pri kreiranju';
        statusDiv.className = 'error';
        console.error('Create user error:', error);
    }
});

// Send report
sendReportBtn.addEventListener('click', async () => {
    if (!confirm('📧 Pošalji dnevni izveštaj?')) return;
    
    try {
        const response = await fetch('/api/send-report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                date: new Date().toLocaleDateString('sr-RS')
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            alert('✅ Izveštaj poslat!');
        } else {
            alert(`❌ Greška: ${data.error}`);
        }
    } catch (error) {
        alert('❌ Greška pri slanju');
        console.error('Send report error:', error);
    }
});

// ============ GLAVNE FUNKCIJE ============

async function loadOrders(search = '', page = 1) {
    try {
        const url = search ? 
            `/api/orders?search=${encodeURIComponent(search)}&page=${page}&limit=${LIMIT}` :
            `/api/orders?page=${page}&limit=${LIMIT}`;
        
        ordersContainer.innerHTML = '<div class="loading">⏳ Učitavanje...</div>';
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                window.location.href = 'index.html';
                return;
            }
            throw new Error('Failed to load orders');
        }
        
        const result = await response.json();
        orders = result.data || [];
        totalOrders = result.total || 0;
        currentPage = result.page || 1;
        totalPages = result.totalPages || 1;
        
        if (orderCount) {
            orderCount.textContent = `${totalOrders} naloga`;
        }
        
        renderOrders(orders, {
            total: totalOrders,
            page: currentPage,
            totalPages: totalPages,
            limit: LIMIT
        });
        
    } catch (error) {
        console.error('❌ Load orders error:', error);
        ordersContainer.innerHTML = '<div class="error">❌ Greška pri učitavanju</div>';
    }
}

function renderOrders(ordersList, meta) {
    if (!ordersList || ordersList.length === 0) {
        ordersContainer.innerHTML = '<p style="text-align:center;padding:40px;color:#a0aec0;">📭 Nema naloga za prikaz</p>';
        return;
    }
    
    const isAdmin = currentUser && currentUser.role === 'admin';
    
    let html = `
        <table>
            <thead>
                <tr>
    `;
    
    if (isAdmin) {
        html += `
                    <th>Firma</th>
                    <th>Šifra</th>
                    <th>Naziv</th>
                    <th>Nalog</th>
                    <th style="text-align:center;">Količina</th>
                    <th>Datum</th>
                    <th style="text-align:center;">Status</th>
        `;
    } else {
        html += `
                    <th>Nalog</th>
                    <th>Naziv</th>
                    <th style="text-align:center;">Količina</th>
                    <th style="text-align:center;">Status</th>
        `;
    }
    
    html += `
                </tr>
            </thead>
            <tbody>
    `;
    
    for (let i = 0; i < ordersList.length; i++) {
        const order = ordersList[i];
        
        const phases = order.progress || order.phases || [];
        const totalPhases = phases.length;
        const completedPhases = phases.filter(p => p.status === 'completed').length || 0;
        const problemPhases = phases.filter(p => p.status === 'problem').length || 0;
        
        let statusText = 'U toku';
        let statusClass = 'status-pending';
        
        if (totalPhases > 0 && completedPhases === totalPhases) {
            statusText = '✅ Završeno';
            statusClass = 'status-completed';
        } else if (problemPhases > 0) {
            statusText = `⚠️ Problem`;
            statusClass = 'status-problem';
        } else if (completedPhases > 0) {
            statusText = `${completedPhases}/${totalPhases}`;
        }
        
        html += `<tr style="border-bottom:1px solid #e2e8f0;${i % 2 === 0 ? 'background:#fafafa;' : ''}">`;
        
        if (isAdmin) {
            html += `
                        <td style="padding:10px;font-size:13px;">${escapeHtml(order.company || '')}</td>
                        <td style="padding:10px;font-size:12px;">${escapeHtml(order.code || '')}</td>
                        <td style="padding:10px;">${escapeHtml(order.name || '')}</td>
                        <td style="padding:10px;color:#667eea;font-weight:600;cursor:pointer;" onclick="openOrder(${order.id})">${escapeHtml(order.orderNumber || '')}</td>
                        <td style="padding:10px;text-align:center;font-weight:600;">${order.quantity || 0}</td>
                        <td style="padding:10px;font-size:12px;">${order.deliveryDate || '-'}</td>
                        <td style="padding:10px;text-align:center;"><span class="status-badge ${statusClass}">${statusText}</span></td>
            `;
        } else {
            html += `
                        <td style="padding:12px 8px;color:#667eea;font-weight:600;cursor:pointer;font-size:16px;" onclick="openOrder(${order.id})">${escapeHtml(order.orderNumber || '')}</td>
                        <td style="padding:12px 8px;font-size:15px;">${escapeHtml(order.name || '')}</td>
                        <td style="padding:12px 8px;text-align:center;font-size:17px;font-weight:700;">${order.quantity || 0}</td>
                        <td style="padding:12px 8px;text-align:center;"><span class="status-badge ${statusClass}" style="font-size:13px;padding:4px 12px;">${statusText}</span></td>
            `;
        }
        
        html += `</tr>`;
    }
    
    html += `
            </tbody>
        </table>
    `;
    
    if (meta && meta.totalPages > 1) {
        html += `
            <div style="display:flex;justify-content:center;align-items:center;gap:12px;padding:14px;border-top:1px solid #e2e8f0;flex-wrap:wrap;">
                <button onclick="goToPage(${meta.page - 1})" 
                        style="padding:8px 20px;background:${meta.page <= 1 ? '#e2e8f0' : '#667eea'};color:${meta.page <= 1 ? '#a0aec0' : 'white'};border:none;border-radius:8px;font-weight:600;cursor:${meta.page <= 1 ? 'not-allowed' : 'pointer'};font-size:14px;" 
                        ${meta.page <= 1 ? 'disabled' : ''}>
                    ◀
                </button>
                <span style="color:#4a5568;font-weight:500;font-size:14px;">${meta.page} / ${meta.totalPages}</span>
                <button onclick="goToPage(${meta.page + 1})" 
                        style="padding:8px 20px;background:${meta.page >= meta.totalPages ? '#e2e8f0' : '#667eea'};color:${meta.page >= meta.totalPages ? '#a0aec0' : 'white'};border:none;border-radius:8px;font-weight:600;cursor:${meta.page >= meta.totalPages ? 'not-allowed' : 'pointer'};font-size:14px;" 
                        ${meta.page >= meta.totalPages ? 'disabled' : ''}>
                    ▶
                </button>
            </div>
        `;
    }
    
    ordersContainer.innerHTML = html;
}

function goToPage(page) {
    if (page < 1 || page > totalPages) return;
    const search = document.getElementById('searchInput').value || '';
    loadOrders(search, page);
    document.querySelector('.panel:last-child')?.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// ============ OPEN ORDER - SA SAKRIVANJEM FIRME ZA TUĐE NALOGE ============
function openOrder(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        console.error('Order not found:', orderId);
        return;
    }
    
    selectedOrderId = orderId;
    modalOrderNumber.textContent = order.orderNumber || order.nalog || 'N/A';
    
    // Proveri da li je admin ILI je nalog korisnikov
    const isAdmin = currentUser && currentUser.role === 'admin';
    const isOwnOrder = order.company === currentUser.company;
    
    let companyHtml = '';
    if (isAdmin || isOwnOrder) {
        // Admin i vlasnik naloga vide firmu
        companyHtml = `<p><strong>Firma:</strong> ${escapeHtml(order.company || order.firma || '')}</p>`;
    } else {
        // Tuđi nalog - sakrivamo firmu
        companyHtml = `<p style="display:none;"><strong>Firma:</strong> ${escapeHtml(order.company || order.firma || '')}</p>`;
    }
    
    modalOrderInfo.innerHTML = `
        ${companyHtml}
        <p><strong>Artikal:</strong> ${escapeHtml(order.name || order.naziv || '')}</p>
        <p><strong>Šifra:</strong> ${escapeHtml(order.code || order.sifra || '')}</p>
        <p><strong>Količina:</strong> ${order.quantity || order.pari || 0}</p>
        <p><strong>Datum isporuke:</strong> ${order.deliveryDate || order.datum_isporuke || '-'}</p>
    `;
    
    renderPhases(order);
    phaseModal.classList.remove('hidden');
}

function renderPhases(order) {
    const phases = order.progress || order.phases || [];
    
    if (phases.length === 0) {
        phasesContainer.innerHTML = '<p style="text-align:center;padding:20px;color:#a0aec0;">Nema faza</p>';
        return;
    }
    
    let html = '';
    phases.forEach(phase => {
        const statusEmoji = phase.status === 'completed' ? '✅' : 
                           phase.status === 'problem' ? '⚠️' : '⬜';
        
        html += `
            <div class="phase-card">
                <h4>Faza ${phase.phase}</h4>
                <div class="phase-status">
                    <span style="font-size:28px;">${statusEmoji}</span>
                    <div>${phase.status}</div>
                </div>
                <div class="phase-buttons">
                    <button onclick="updatePhase(${order.id}, '${phase.phase}', 'completed')">✅ Završi</button>
                    <button onclick="updatePhase(${order.id}, '${phase.phase}', 'problem')">⚠️ Problem</button>
                    <button onclick="updatePhase(${order.id}, '${phase.phase}', 'pending')">⬜ Reset</button>
                </div>
                <div class="phase-comment">
                    <textarea 
                        placeholder="Komentar..." 
                        onchange="updatePhaseComment(${order.id}, '${phase.phase}', this.value)"
                    >${phase.comment || ''}</textarea>
                </div>
            </div>
        `;
    });
    
    phasesContainer.innerHTML = html;
}

async function updatePhase(orderId, phase, status) {
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
        
        if (response.ok) {
            const search = document.getElementById('searchInput').value || '';
            await loadOrders(search, currentPage);
            const order = orders.find(o => o.id === orderId);
            if (order) {
                renderPhases(order);
            }
        } else {
            alert(`❌ Greška: ${data.error}`);
        }
    } catch (error) {
        alert('❌ Greška pri ažuriranju');
        console.error('Update phase error:', error);
    }
}

async function updatePhaseComment(orderId, phase, comment) {
    try {
        await fetch('/api/update-phase', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ orderId, phase, status: 'pending', comment })
        });
    } catch (error) {
        console.error('Update comment error:', error);
    }
}

async function loadUsers() {
    try {
        const response = await fetch('/api/users', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) return;
        
        const users = await response.json();
        const usersList = document.getElementById('usersList');
        
        let html = '';
        users.forEach(user => {
            html += `
                <div class="user-item">
                    <span>${escapeHtml(user.username)}</span>
                    <span style="color:#718096;">${escapeHtml(user.company)}</span>
                    <span style="color:#718096;font-size:12px;">${user.role}</span>
                </div>
            `;
        });
        
        usersList.innerHTML = html || '<p style="color:#a0aec0;text-align:center;padding:16px;">Nema korisnika</p>';
    } catch (error) {
        console.error('Load users error:', error);
    }
}