// ============================================================
// lang-switcher.js — zastavice za izbor jezika
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const switcher = document.getElementById('langSwitcher');
  if (!switcher) return;

  const flags = switcher.querySelectorAll('.lang-flag');
  const current = getCurrentLang();

  // Postavi aktivnu zastavicu
  flags.forEach(flag => {
    flag.classList.toggle('active', flag.dataset.lang === current);
    flag.addEventListener('click', () => {
      const lang = flag.dataset.lang;
      if (lang === getCurrentLang()) return;
      setLang(lang);
      // Ponovo učitaj stranicu da bi se sve prevelo
      location.reload();
    });
  });
});