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

      // Kratka vizuelna potvrda pre reload-a
      flags.forEach(f => f.classList.remove('active'));
      flag.classList.add('active');

      setLang(lang);

      // Reload da bi se sve prevelo (statički + dinamički renderovani delovi)
      location.reload();
    });
  });
});