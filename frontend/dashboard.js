// ============ UPDATE PHASE ============
async function updatePhase(orderId, phase, status) {
    try {
        console.log(`🔄 Menjam fazu ${phase} na status ${status} za nalog ${orderId}`);
        
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
            console.log('✅ Faza ažurirana');
            
            // Pronađi nalog u orders nizu
            const orderIndex = orders.findIndex(o => o.id === orderId);
            if (orderIndex !== -1) {
                const order = orders[orderIndex];
                
                // Ako order nema progress, kreiraj ga
                if (!order.progress) {
                    order.progress = [];
                }
                
                // Pronađi fazu u progress-u
                const phaseData = order.progress.find(p => p.phase === phase);
                if (phaseData) {
                    // Ažuriraj postojeću fazu
                    phaseData.status = status;
                } else {
                    // Dodaj novu fazu ako ne postoji
                    order.progress.push({ phase, status, comment: '' });
                }
                
                // Osvježi prikaz faza
                renderPhases(order);
                
                // Osvježi tabelu
                renderOrders(orders, {
                    total: totalOrders,
                    page: currentPage,
                    totalPages: totalPages,
                    limit: LIMIT
                });
            }
            
        } else {
            alert(`❌ Greška: ${data.error}`);
        }
    } catch (error) {
        alert('❌ Greška pri ažuriranju');
        console.error('Update phase error:', error);
    }
}