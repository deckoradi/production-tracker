// ============================================================
// i18n.js — prevodi za Production Tracker
// Jezik: sr (srpski) i it (italijanski)
// Koristi se samo za deo koji vidi KLIJENT (user)
// ============================================================

const TRANSLATIONS = {
  sr: {
    // ===== NAVBAR =====
    nav_report: '📧 Izveštaj',
    nav_password: '🔑 Lozinka',
    nav_logout: 'Odjava',
    nav_tracker: '🏭 Tracker',

    // ===== PANELI (klijent) =====
    panel_search: '🔍 Pretraga',
    panel_search_placeholder: 'Firma, šifra, nalog...',
    panel_orders: '📦 Nalozi',
    panel_my_report: '📊 Moj izveštaj',
    panel_my_report_download: '📥 Preuzmi Excel',
    panel_no_orders: '📭 Nema naloga za prikaz',
    panel_loading: '⏳ Učitavanje...',

    // ===== TABELA =====
    th_order: 'Nalog',
    th_name: 'Naziv',
    th_quantity: 'Količina',
    th_status: 'Status',

    // ===== STATUSI =====
    status_ok: '✅ U redu',
    status_problem: '⚠️ Problem',
    status_repair: '🔧 REPARACIJA',
    status_cancelled: '❌ ANULIRANO',
    status_in_progress: 'U toku',

    // ===== FAZE =====
    phase_100: 'Krojenje',
    phase_200: 'Serigrafija',
    phase_300: 'Vez',
    phase_400: 'Šivenje',
    phase_500: 'Poslato',
    phase_note: 'Napomena',
    phase_repair: 'Reparacija',
    phase_reception: 'Prijem',

    // ===== DUGMIĆI U MODALU =====
    btn_done: '✅ Urađeno',
    btn_problem: '⚠️ Problem',
    btn_none: '🚫 Nema',
    btn_reset: '⬜ Reset',
    btn_confirm: '✅ Potvrdi',
    btn_cancel: 'Otkaži',
    btn_copy: '📋 Kopiraj tekst',

    // ===== PORUKE =====
    msg_session_expired: 'Sesija je istekla.',
    msg_first_resolve_phase: '⛔ Prvo rešite fazu',
    msg_waiting_kontrola: '⏳ Čeka potvrdu Kontrole',
    msg_waiting_client: '⏳ Čeka potvrdu klijenta',
    msg_confirmed: '✅ Potvrđeno',
    msg_closed: '✅ Zatvoreno',
    msg_deadline: 'Rok',
    msg_reminder_title: '⏰ Podsetnik — reparacije čiji je rok istekao',
    msg_late_days: 'kasni',
    msg_day: 'dan',
    msg_days: 'dana',
    msg_waiting_kontrola_confirm: 'čeka potvrdu Kontrole',
    msg_waiting_your_confirm: 'čeka Vašu potvrdu',
    msg_waiting_both: 'čeka potvrdu obe strane',

    // ===== EXPORT =====
    export_generating: '⏳ Generišem Excel...',
    export_done: '✅ Fajl preuzet',
    export_error: '❌ Greška',
  },

  it: {
    // ===== NAVBAR =====
    nav_report: '📧 Rapporto',
    nav_password: '🔑 Password',
    nav_logout: 'Disconnetti',
    nav_tracker: '🏭 Tracker',

    // ===== PANELI (klijent) =====
    panel_search: '🔍 Ricerca',
    panel_search_placeholder: 'Azienda, codice, ordine...',
    panel_orders: '📦 Ordini',
    panel_my_report: '📊 Il mio rapporto',
    panel_my_report_download: '📥 Scarica Excel',
    panel_no_orders: '📭 Nessun ordine da mostrare',
    panel_loading: '⏳ Caricamento...',

    // ===== TABELA =====
    th_order: 'Ordine',
    th_name: 'Nome',
    th_quantity: 'Quantità',
    th_status: 'Stato',

    // ===== STATUSI =====
    status_ok: '✅ In ordine',
    status_problem: '⚠️ Problema',
    status_repair: '🔧 RIPARAZIONE',
    status_cancelled: '❌ ANNULLATO',
    status_in_progress: 'In corso',

    // ===== FAZE =====
    phase_100: 'Taglio',
    phase_200: 'Serigrafia',
    phase_300: 'Ricamo',
    phase_400: 'Cucitura',
    phase_500: 'Spedito',
    phase_note: 'Nota',
    phase_repair: 'Riparazione',
    phase_reception: 'Ricezione',

    // ===== DUGMIĆI U MODALU =====
    btn_done: '✅ Fatto',
    btn_problem: '⚠️ Problema',
    btn_none: '🚫 Nessuno',
    btn_reset: '⬜ Reset',
    btn_confirm: '✅ Conferma',
    btn_cancel: 'Annulla',
    btn_copy: '📋 Copia testo',

    // ===== PORUKE =====
    msg_session_expired: 'Sessione scaduta.',
    msg_first_resolve_phase: '⛔ Prima risolvi la fase',
    msg_waiting_kontrola: '⏳ In attesa di conferma dal Controllo',
    msg_waiting_client: '⏳ In attesa di conferma dal cliente',
    msg_confirmed: '✅ Confermato',
    msg_closed: '✅ Chiuso',
    msg_deadline: 'Scadenza',
    msg_reminder_title: '⏰ Promemoria — riparazioni scadute',
    msg_late_days: 'in ritardo di',
    msg_day: 'giorno',
    msg_days: 'giorni',
    msg_waiting_kontrola_confirm: 'in attesa di conferma dal Controllo',
    msg_waiting_your_confirm: 'in attesa della tua conferma',
    msg_waiting_both: 'in attesa di conferma da entrambe le parti',

    // ===== EXPORT =====
    export_generating: '⏳ Generazione Excel...',
    export_done: '✅ File scaricato',
    export_error: '❌ Errore',
  }
};

// ============================================================
// Trenutni jezik (iz localStorage ili podrazumevano 'sr')
// ============================================================
function getCurrentLang() {
  return localStorage.getItem('lang') || 'sr';
}

// ============================================================
// Glavna funkcija za prevođenje
// Koristi se kao: t('nav_logout') -> 'Odjava' ili 'Disconnetti'
// ============================================================
function t(key) {
  const lang = getCurrentLang();
  return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS['sr'][key] || key;
}

// ============================================================
// Funkcija za promenu jezika (poziva se iz lang-switcher.js)
// ============================================================
function setLang(lang) {
  if (lang !== 'sr' && lang !== 'it') return;
  localStorage.setItem('lang', lang);
}

// ============================================================
// Prevedi sve elemente sa data-i18n atributom
// ============================================================
function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
}

// Automatski prevedi stranicu kada se DOM učita
document.addEventListener('DOMContentLoaded', translatePage);