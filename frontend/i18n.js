// ============================================================
// i18n.js — prevodi za Production Tracker
// Jezik: sr (srpski) i it (italijanski)
// ============================================================

const TRANSLATIONS = {
  sr: {
    // ===== NAVBAR =====
    nav_report: '📧 Izveštaj',
    nav_password: '🔑 Lozinka',
    nav_logout: 'Odjava',
    nav_tracker: '🏭 Tracker',

    // ===== KPI =====
    kpi_active: 'Aktivni nalozi',
    kpi_in_progress: 'U toku',
    kpi_late: 'Kašnjenja',
    kpi_done_today: 'Završeno danas',

    // ===== PANELI (klijent) =====
    panel_search: '🔍 Pretraga',
    panel_search_placeholder: 'Firma, šifra, nalog...',
    panel_orders: '📦 Nalozi',
    panel_my_report: '📊 Moj izveštaj',
    panel_my_report_download: '📥 Preuzmi Excel',
    panel_no_orders: '📭 Nema naloga za prikaz',
    panel_loading: '⏳ Učitavanje...',
    panel_worker_report: 'Izveštaj faze',
    panel_worker_report_download: 'Preuzmi Excel',

    // ===== TABELA =====
    th_order: 'Nalog',
    th_name: 'Naziv',
    th_quantity: 'Količina',
    th_status: 'Status',
    th_company: 'Firma',
    th_delivery: 'Datum',

    // ===== STATUSI =====
    status_ok: 'U redu',
    status_problem: 'Problem',
    status_repair: 'REPARACIJA',
    status_cancelled: 'ANULIRANO',
    status_in_progress: 'U toku',
    status_sent: 'Poslato',
    status_received: 'Primljeno',
    status_done_worker: 'Urađeno',
    status_late: 'Kasni',
    status_phase: 'U toku',

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
    btn_done: 'Urađeno',
    btn_problem: 'Problem',
    btn_none: 'Nema',
    btn_none_short: 'Nema',
    btn_reset: 'Reset',
    btn_confirm: 'Potvrdi',
    btn_cancel: 'Otkaži',
    btn_copy: 'Kopiraj tekst',
    btn_sent: 'Poslato',
    btn_sent_short: 'Poslato',
    btn_primljeno: 'Primljeno',
    btn_poslato: 'Poslato',
    btn_uradjeno: 'Urađeno',
    btn_stiglo: 'Stiglo',
    btn_all_ok: 'Sve u redu',
    btn_repair: 'Reparacija',
    btn_cancelled: 'Anulirano',
    btn_reset_password: 'Resetuj lozinku',
    btn_delete_user: 'Obriši korisnika',

    // ===== ROLE =====
    role_admin: 'Administrator',
    role_kontrola: 'Kontrola',
    role_user: 'Klijent',
    role_vez: 'Vez (radnik)',
    role_serigrafija: 'Serigrafija (radnik)',

    // ===== MODAL - INFO =====
    modal_company: 'Firma',
    modal_article: 'Artikal',
    modal_code: 'Šifra',
    modal_quantity: 'Količina',
    modal_delivery: 'Datum isporuke',

    // ===== PORUKE =====
    msg_session_expired: 'Sesija je istekla.',
    msg_first_resolve_phase: '⛔ Prvo rešite fazu',
    msg_waiting_kontrola: '⏳ Čeka potvrdu Kontrole',
    msg_waiting_client: '⏳ Čeka potvrdu klijenta',
    msg_waiting_client_send: '⏳ Čeka da klijent pošalje nalog',
    msg_confirmed: 'Potvrđeno',
    msg_closed: 'Zatvoreno',
    msg_deadline: 'Rok',
    msg_reminder_title: '⏰ Podsetnik — reparacije čiji je rok istekao',
    msg_late_days: 'kasni',
    msg_day: 'dan',
    msg_days: 'dana',
    msg_waiting_kontrola_confirm: 'čeka potvrdu Kontrole',
    msg_waiting_your_confirm: 'čeka Vašu potvrdu',
    msg_waiting_both: 'čeka potvrdu obe strane',
    msg_no_phases: 'Nema faza',
    msg_worker: 'Radio',
    msg_worker_working: '⏳ Radnik radi...',
    msg_sent_awaiting_return: '⏳ Poslato — čeka se povratak',
    msg_to_dept: 'za odeljenje',
    msg_awaiting_receive: 'čeka se prijem',
    msg_received_for_work: '📥 Nalog je stigao za obradu',
    msg_size_hint: 'Klikni na broj i upiši količinu (par).',
    msg_deadline_days: 'Rok za podsetnik (dana)',
    msg_enter_qty_or_note: 'Unesi bar jedan broj sa količinom, ili komentar.',
    msg_size_short: 'vel.',
    msg_pairs_short: 'pa.',
    msg_user_created: 'Korisnik kreiran:',
    msg_no_users: 'Nema korisnika',
    msg_all_companies: 'Sve firme',
    msg_reset_confirm: 'Generisati novu lozinku za "{user}"? Stara prestaje da važi.',
    msg_delete_confirm: 'Obrisati korisnika "{user}"? Ova akcija se ne može poništiti.',
    msg_send_report_confirm: '📧 Pošalji dnevni izveštaj?',
    msg_enter_current_password: 'Unesi TRENUTNU lozinku:',
    msg_enter_new_password: 'Unesi NOVU lozinku (bar 6 karaktera):',
    msg_repeat_new_password: 'Ponovi NOVU lozinku:',
    msg_password_mismatch: 'Nova lozinka i potvrda se ne poklapaju.',

    // ===== VREMENSKA LINIJA I PROBLEM MODAL =====
    msg_history: 'Istorija',
    msg_problem_title: 'Prijavi problem',
    msg_problem_hint: 'Opiši problem (opciono):',
    btn_confirm_problem: 'Prijavi problem',
    msg_problem_no_comment: 'Nisi uneo komentar. Prijaviti problem bez komentara?',

    // ===== PREUZIMANJE NALOGA =====
    msg_claimed_by: 'Klijent {claimer} je preuzeo nalog namenjen klijentu {original}',
    msg_claimed_by_short: 'Preuzeto od strane {claimer}',
    msg_claim_locked: '🔒 Nalog je zauzet',
    msg_claim_you_can_take: 'Možete preuzeti ovaj nalog klikom na Krojenje → Urađeno',

    // ===== OTPREMNICE =====
    msg_otpremnica_deleted: 'Otpremnica obrisana.',
    msg_otpremnica_reset_manual: 'Resetuj broj ručno.',

    // ===== OSTALO =====
    order_count_suffix: 'naloga',
    placeholder_comment: 'Komentar...',
    placeholder_note: 'Napomena...',
    lock_tooltip: 'Zaključano — obratite se administratoru',

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

    // ===== KPI =====
    kpi_active: 'Ordini attivi',
    kpi_in_progress: 'In corso',
    kpi_late: 'In ritardo',
    kpi_done_today: 'Completati oggi',

    // ===== PANELI (klijent) =====
    panel_search: '🔍 Ricerca',
    panel_search_placeholder: 'Azienda, codice, ordine...',
    panel_orders: '📦 Ordini',
    panel_my_report: '📊 Il mio rapporto',
    panel_my_report_download: '📥 Scarica Excel',
    panel_no_orders: '📭 Nessun ordine da mostrare',
    panel_loading: '⏳ Caricamento...',
    panel_worker_report: 'Rapporto fase',
    panel_worker_report_download: 'Scarica Excel',

    // ===== TABELA =====
    th_order: 'Ordine',
    th_name: 'Nome',
    th_quantity: 'Quantità',
    th_status: 'Stato',
    th_company: 'Azienda',
    th_delivery: 'Data',

    // ===== STATUSI =====
    status_ok: 'In ordine',
    status_problem: 'Problema',
    status_repair: 'RIPARAZIONE',
    status_cancelled: 'ANNULLATO',
    status_in_progress: 'In corso',
    status_sent: 'Inviato',
    status_received: 'Ricevuto',
    status_done_worker: 'Fatto',
    status_late: 'In ritardo',
    status_phase: 'In corso',

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
    btn_done: 'Fatto',
    btn_problem: 'Problema',
    btn_none: 'Nessuno',
    btn_none_short: 'Nessuno',
    btn_reset: 'Reset',
    btn_confirm: 'Conferma',
    btn_cancel: 'Annulla',
    btn_copy: 'Copia testo',
    btn_sent: 'Inviato',
    btn_sent_short: 'Inviato',
    btn_primljeno: 'Ricevuto',
    btn_poslato: 'Inviato',
    btn_uradjeno: 'Fatto',
    btn_stiglo: 'Arrivato',
    btn_all_ok: 'Tutto OK',
    btn_repair: 'Riparazione',
    btn_cancelled: 'Annullato',
    btn_reset_password: 'Reimposta password',
    btn_delete_user: 'Elimina utente',

    // ===== ROLE =====
    role_admin: 'Amministratore',
    role_kontrola: 'Controllo',
    role_user: 'Cliente',
    role_vez: 'Ricamo (operaio)',
    role_serigrafija: 'Serigrafia (operaio)',

    // ===== MODAL - INFO =====
    modal_company: 'Azienda',
    modal_article: 'Articolo',
    modal_code: 'Codice',
    modal_quantity: 'Quantità',
    modal_delivery: 'Data di consegna',
    // ===== PORUKE =====
    msg_session_expired: 'Sessione scaduta.',
    msg_first_resolve_phase: '⛔ Prima risolvi la fase',
    msg_waiting_kontrola: '⏳ In attesa di conferma dal Controllo',
    msg_waiting_client: '⏳ In attesa di conferma dal cliente',
    msg_waiting_client_send: '⏳ In attesa che il cliente invii l\'ordine',
    msg_confirmed: 'Confermato',
    msg_closed: 'Chiuso',
    msg_deadline: 'Scadenza',
    msg_reminder_title: '⏰ Promemoria — riparazioni scadute',
    msg_late_days: 'in ritardo di',
    msg_day: 'giorno',
    msg_days: 'giorni',
    msg_waiting_kontrola_confirm: 'in attesa di conferma dal Controllo',
    msg_waiting_your_confirm: 'in attesa della tua conferma',
    msg_waiting_both: 'in attesa di conferma da entrambe le parti',
    msg_no_phases: 'Nessuna fase',
    msg_worker: 'Ha lavorato',
    msg_worker_working: '⏳ L\'operaio sta lavorando...',
    msg_sent_awaiting_return: '⏳ Inviato — in attesa del ritorno',
    msg_to_dept: 'al reparto',
    msg_awaiting_receive: 'in attesa di ricezione',
    msg_received_for_work: '📥 Ordine ricevuto per la lavorazione',
    msg_size_hint: 'Clicca sul numero e inserisci la quantità (paia).',
    msg_deadline_days: 'Scadenza per il promemoria (giorni)',
    msg_enter_qty_or_note: 'Inserisci almeno un numero con quantità, o un commento.',
    msg_size_short: 'mis.',
    msg_pairs_short: 'pa.',
    msg_user_created: 'Utente creato:',
    msg_no_users: 'Nessun utente',
    msg_all_companies: 'Tutte le aziende',
    msg_reset_confirm: 'Generare una nuova password per "{user}"? La vecchia smetterà di funzionare.',
    msg_delete_confirm: 'Eliminare l\'utente "{user}"? Questa azione non può essere annullata.',
    msg_send_report_confirm: '📧 Inviare il rapporto giornaliero?',
    msg_enter_current_password: 'Inserisci la password ATTUALE:',
    msg_enter_new_password: 'Inserisci la NUOVA password (almeno 6 caratteri):',
    msg_repeat_new_password: 'Ripeti la NUOVA password:',
    msg_password_mismatch: 'La nuova password e la conferma non corrispondono.',

    // ===== CRONOLOGIA E MODAL PROBLEMA =====
    msg_history: 'Cronologia',
    msg_problem_title: 'Segnala problema',
    msg_problem_hint: 'Descrivi il problema (opzionale):',
    btn_confirm_problem: 'Segnala problema',
    msg_problem_no_comment: 'Nessun commento inserito. Segnalare il problema senza commento?',

    // ===== PRESA ORDINE =====
    msg_claimed_by: 'Il cliente {claimer} ha preso l\'ordine destinato al cliente {original}',
    msg_claimed_by_short: 'Preso da {claimer}',
    msg_claim_locked: '🔒 Ordine occupato',
    msg_claim_you_can_take: 'Puoi prendere questo ordine cliccando su Taglio → Fatto',

    // ===== DDT / OTPREMNICE =====
    msg_otpremnica_deleted: 'DDT eliminato.',
    msg_otpremnica_reset_manual: 'Reimposta il numero manualmente.',

    // ===== OSTALO =====
    order_count_suffix: 'ordini',
    placeholder_comment: 'Commento...',
    placeholder_note: 'Nota...',
    lock_tooltip: 'Bloccato — contatta l\'amministratore',

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
// ============================================================
function t(key) {
  const lang = getCurrentLang();
  return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS['sr'][key] || key;
}

// ============================================================
// Funkcija za zamenu placeholdera u tekstu
// ============================================================
function tFormat(key, vars) {
  let text = t(key);
  if (vars) {
    Object.keys(vars).forEach(k => {
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
  }
  return text;
}

// ============================================================
// Funkcija za promenu jezika
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

// ============================================================
// Prevedi dinamičke delove (KPI, tabela, modal)
// Poziva se iz lang-switcher.js posle promene jezika
// ============================================================
function retranslateDynamic() {
  if (typeof orders !== 'undefined' && Array.isArray(orders)) {
    if (typeof renderKPI === 'function') renderKPI(orders);
    if (typeof renderOrders === 'function') renderOrders();
    if (typeof selectedOrderId !== 'undefined' && selectedOrderId
        && typeof renderModal === 'function') {
      const o = orders.find(x => String(x.id) === String(selectedOrderId));
      if (o) renderModal(o);
    }
  }
}

// Automatski prevedi stranicu kada se DOM učita
document.addEventListener('DOMContentLoaded', translatePage);