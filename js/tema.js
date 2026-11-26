// Racha · tema claro u oscuro. Se carga en el <head>, antes de pintar,
// para que la página no parpadee con el tema equivocado.
// Preferencia guardada en este navegador: 'auto' (sigue al sistema), 'claro' u 'oscuro'.
(function () {
  'use strict';
  var CLAVE = 'racha.tema';
  var COLOR_BARRA = { claro: '#f3f6f2', oscuro: '#101412' };
  var sistema = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function leer() {
    try {
      var v = localStorage.getItem(CLAVE);
      return v === 'claro' || v === 'oscuro' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  function resuelto(pref) {
    if (pref === 'claro' || pref === 'oscuro') return pref;
    return sistema && sistema.matches ? 'claro' : 'oscuro';
  }
  function aplicar() {
    var tema = resuelto(leer());
    document.documentElement.setAttribute('data-tema', tema);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLOR_BARRA[tema]);
    return tema;
  }
  function poner(pref) {
    try {
      if (pref === 'claro' || pref === 'oscuro') localStorage.setItem(CLAVE, pref);
      else localStorage.removeItem(CLAVE);
    } catch (e) { /* sin almacenamiento: vale solo para esta visita */ }
    var tema = resuelto(pref);
    document.documentElement.setAttribute('data-tema', tema);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLOR_BARRA[tema]);
    return tema;
  }

  aplicar();
  if (sistema) {
    var alCambiar = function () { if (leer() === 'auto') aplicar(); };
    if (sistema.addEventListener) sistema.addEventListener('change', alCambiar);
    else if (sistema.addListener) sistema.addListener(alCambiar);
  }
  document.addEventListener('DOMContentLoaded', aplicar);

  window.RachaTema = {
    leer: leer,                                  // 'auto' | 'claro' | 'oscuro'
    actual: function () { return resuelto(leer()); },
    poner: poner
  };
})();
