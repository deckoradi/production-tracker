document.addEventListener('DOMContentLoaded', function() {
    console.log('🔵 Script loaded!');
    
    const form = document.getElementById('loginForm');
    if (!form) {
        console.error('❌ Login form not found!');
        return;
    }

    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        console.log('🔵 Login button clicked!');
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');
        
        errorDiv.textContent = '';
        
        // KORISTI RELATIVNU PUTANJU ZA RENDER
        const url = '/api/login';
        console.log('📡 Saljem na:', url);
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });
            
            console.log('📊 Status odgovora:', response.status);
            const data = await response.json();
            console.log('📦 Odgovor:', data);
            
            if (response.ok) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                console.log('✅ Login uspešan! Preusmeravam na dashboard...');
                window.location.href = 'dashboard.html';
            } else {
                errorDiv.textContent = data.error || 'Pogrešno korisničko ime ili lozinka';
                console.log('❌ Login neuspešan:', data.error);
            }
        } catch (error) {
            console.error('❌ Fetch greska:', error);
            errorDiv.textContent = 'Greška pri povezivanju sa serverom: ' + error.message;
        }
    });
});