// Reto de hábitos · versión 0.2 (iteraciones 1 y 2, historias 1 a 11)
// Página estática: toda la lógica de reglas vive en supabase/schema.sql.
(function () {
  'use strict';

  var cfg = window.RETO_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  var FRANJAS = [
    { id: 'antes_trabajo', nombre: 'Antes del trabajo' },
    { id: 'comida',        nombre: 'Hora de la comida' },
    { id: 'antes_clase',   nombre: 'Antes de clase' },
    { id: 'llegar_casa',   nombre: 'Al llegar a casa' }
  ];
  var CATEGORIAS = { movimiento: 'Movimiento', sueno: 'Descanso', alimentacion: 'Alimentación', bienestar: 'Bienestar' };

  var ERRORES = {
    sin_sesion: 'No se pudo iniciar tu sesión. Revisa tu conexión e inténtalo de nuevo.',
    falta_consentimiento: 'Para participar necesitas aceptar el aviso de privacidad.',
    codigo_invalido: 'El enlace de invitación no es válido o ya cerró. Pide el enlace a quien te invitó.',
    alias_invalido: 'El alias debe tener de 3 a 20 caracteres: letras, números, espacios, guion o guion bajo.',
    alias_ocupado: 'Ese alias ya está en uso en tu grupo. Prueba con otro.',
    cohorte_llena: 'El grupo ya está completo. Avisa a quien te invitó.',
    ya_tiene_alta: 'Ya tenías un alias en este celular.',
    acciones_invalidas: 'Elige 1 o 2 acciones del catálogo.',
    franja_invalida: 'Elige un hueco del día.',
    dias_invalidos: 'Elige cuántos días a la semana te comprometes.',
    plan_ya_guardado: 'Tu plan ya estaba guardado.',
    accion_invalida: 'Esa acción no es parte de tu plan.',
    sin_plan: 'Primero elige tus acciones y tu hueco.',
    sin_alta: 'Primero elige tu alias.',
    valor_invalido: 'No se pudo guardar tu decisión. Inténtalo de nuevo.'
  };

  var sb = null;
  var codigo = '';
  var estado = null;       // respuesta de mi_estado()
  var catalogo = [];
  var elegidas = [];       // ids de acciones elegidas en el paso 2
  var franjaElegida = null;
  var diasElegidos = null;
  var verAyer = false;

  // ---------- utilidades ----------

  function guardarLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
  function leerLocal(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function mensajeDe(error) {
    var texto = (error && error.message) || '';
    for (var clave in ERRORES) {
      if (texto.indexOf(clave) !== -1) return ERRORES[clave];
    }
    if (/anonymous sign-?ins are disabled/i.test(texto)) {
      return 'La página todavía no acepta altas (falta activar el acceso anónimo en Supabase).';
    }
    if (/rate limit|too many/i.test(texto)) {
      return 'Hay muchas altas desde esta red en este momento. Inténtalo de nuevo en unos minutos o usa tus datos móviles.';
    }
    if (/failed to fetch|network/i.test(texto)) {
      return 'No hay conexión. Revisa tu internet e inténtalo de nuevo.';
    }
    return 'Algo salió mal. Inténtalo de nuevo.';
  }

  function claveDe(error) {
    var texto = (error && error.message) || '';
    for (var clave in ERRORES) { if (texto.indexOf(clave) !== -1) return clave; }
    return '';
  }

  var VISTAS = ['v-cargando', 'v-aviso-sistema', 'v-alta', 'v-acciones', 'v-hueco', 'v-hoy', 'v-tabla', 'v-datos'];
  function mostrar(id) {
    VISTAS.forEach(function (v) { $(v).hidden = v !== id; });
    var conNav = id === 'v-hoy' || id === 'v-tabla' || id === 'v-datos';
    $('navegacion').hidden = !conNav;
    $('nav-hoy').classList.toggle('activo', id === 'v-hoy');
    $('nav-tabla').classList.toggle('activo', id === 'v-tabla');
    $('nav-datos').classList.toggle('activo', id === 'v-datos');
    window.scrollTo(0, 0);
  }

  function detener(titulo, texto) {
    $('sistema-titulo').textContent = titulo;
    $('sistema-texto').textContent = texto;
    mostrar('v-aviso-sistema');
  }

  function ponerError(id, texto) {
    var el = $(id);
    el.textContent = texto || '';
    el.hidden = !texto;
  }

  var relojToast = null;
  function toast(texto) {
    var el = $('toast');
    el.textContent = texto;
    el.hidden = false;
    clearTimeout(relojToast);
    relojToast = setTimeout(function () { el.hidden = true; }, 3500);
  }

  function crear(etiqueta, clase, texto) {
    var el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto !== undefined) el.textContent = texto;
    return el;
  }

  function nombreFranja(id) {
    var f = FRANJAS.filter(function (x) { return x.id === id; })[0];
    return f ? f.nombre : '';
  }

  function fechaLarga(iso) {
    // iso = AAAA-MM-DD (fecha de la Ciudad de México que manda el servidor)
    var d = new Date(iso + 'T12:00:00Z');
    return new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
  }

  async function rpc(nombre, args) {
    var r = await sb.rpc(nombre, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  // ---------- arranque ----------

  async function iniciar() {
    // Textos del aviso que dependen de la configuración
    document.querySelectorAll('[data-cfg]').forEach(function (el) {
      el.textContent = cfg[el.getAttribute('data-cfg')] || '[por definir]';
    });

    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
      detener('Falta configurar la página',
        'Quien administra el proyecto debe poner la URL y la llave publicable de Supabase en js/config.js.');
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

    var deUrl = new URLSearchParams(location.search).get('c');
    if (deUrl) guardarLocal('reto.codigo', deUrl.trim().toUpperCase());
    codigo = leerLocal('reto.codigo') || (deUrl || '').trim().toUpperCase();

    try {
      var s = await sb.auth.getSession();
      if (s.data && s.data.session) {
        await refrescarYRutear();
        return;
      }
    } catch (e) { /* sin sesión: sigue al alta */ }

    if (!codigo) {
      detener('Necesitas tu enlace de invitación',
        'Abre la página con el enlace que te mandó el equipo. Si ya te habías registrado, usa el mismo celular y navegador de la primera vez.');
      return;
    }
    mostrar('v-alta');
  }

  async function refrescarYRutear() {
    try {
      estado = await rpc('mi_estado');
    } catch (e) {
      detener('No pudimos cargar tus datos', mensajeDe(e));
      return;
    }
    if (!estado.alta) {
      if (!codigo) {
        detener('Necesitas tu enlace de invitación', 'Abre la página con el enlace que te mandó el equipo.');
        return;
      }
      mostrar('v-alta');
      return;
    }
    $('saludo').textContent = estado.alias;
    $('saludo').hidden = false;
    if (!estado.tiene_plan) {
      await abrirAcciones();
      return;
    }
    pintarHoy();
    mostrar('v-hoy');
  }

  // ---------- historia 1: alta ----------

  // Alias al azar: un animal y dos cifras. No identifica a nadie y evita
  // que alguien use su nombre. Sin acentos, para que siempre pase la validación.
  var ANIMALES = ['Ajolote', 'Quetzal', 'Jaguar', 'Tlacuache', 'Cenzontle', 'Ocelote', 'Coyote', 'Tortuga',
    'Mapache', 'Venado', 'Nutria', 'Zorro', 'Lince', 'Puma', 'Iguana', 'Armadillo', 'Mariposa', 'Lobo',
    'Garza', 'Erizo', 'Foca', 'Gaviota', 'Liebre', 'Castor'];
  function aliasAlAzar() {
    var animal = ANIMALES[Math.floor(Math.random() * ANIMALES.length)];
    return animal + ' ' + (10 + Math.floor(Math.random() * 90));
  }
  function generarAlias() {
    var campo = $('alias');
    var nuevo = aliasAlAzar();
    if (nuevo === campo.value) nuevo = aliasAlAzar();
    campo.value = nuevo;
    ponerError('error-alta', '');
  }

  async function enviarAlta(ev) {
    ev.preventDefault();
    ponerError('error-alta', '');
    var alias = $('alias').value.replace(/\s+/g, ' ').trim();
    if (alias.length < 3 || alias.length > 20) {
      ponerError('error-alta', ERRORES.alias_invalido);
      return;
    }
    if (!$('acepta').checked) {
      ponerError('error-alta', ERRORES.falta_consentimiento);
      return;
    }
    var boton = $('btn-alta');
    boton.disabled = true;
    boton.textContent = 'Entrando…';
    try {
      // Nada sale del celular antes de aceptar: la sesión se crea hasta aquí.
      var s = await sb.auth.getSession();
      if (!(s.data && s.data.session)) {
        var r = await sb.auth.signInAnonymously();
        if (r.error) throw r.error;
      }
      try {
        await rpc('alta', { p_codigo: codigo, p_alias: alias, p_acepta: true, p_aparece: $('aparece').checked });
      } catch (e) {
        if (claveDe(e) !== 'ya_tiene_alta') throw e;
      }
      await refrescarYRutear();
    } catch (e) {
      ponerError('error-alta', mensajeDe(e));
    } finally {
      boton.disabled = false;
      boton.textContent = 'Entrar';
    }
  }

  // ---------- historia 2: micro-acciones ----------

  async function abrirAcciones() {
    mostrar('v-acciones');
    if (!catalogo.length) {
      var r = await sb.from('catalogo').select('id,categoria,nombre,minutos,emoji').order('orden');
      if (r.error) {
        ponerError('error-acciones', mensajeDe(r.error));
        return;
      }
      catalogo = r.data || [];
    }
    pintarCatalogo();
  }

  function pintarCatalogo() {
    var caja = $('lista-catalogo');
    caja.textContent = '';
    Object.keys(CATEGORIAS).forEach(function (cat) {
      var deCat = catalogo.filter(function (a) { return a.categoria === cat; });
      if (!deCat.length) return;
      caja.appendChild(crear('p', 'categoria', CATEGORIAS[cat]));
      deCat.forEach(function (a) {
        var b = crear('button', 'opcion accion-opcion cat-' + cat);
        b.type = 'button';
        b.setAttribute('role', 'checkbox');
        var marcada = elegidas.indexOf(a.id) !== -1;
        b.setAttribute('aria-checked', marcada ? 'true' : 'false');
        b.disabled = !marcada && elegidas.length >= 2;
        b.appendChild(crear('span', 'emoji', a.emoji || '•'));
        b.appendChild(crear('span', 'nombre', a.nombre));
        if (a.minutos) b.appendChild(crear('span', 'min', a.minutos + ' min'));
        b.addEventListener('click', function () {
          var i = elegidas.indexOf(a.id);
          if (i === -1) elegidas.push(a.id); else elegidas.splice(i, 1);
          pintarCatalogo();
        });
        caja.appendChild(b);
      });
    });
    var boton = $('btn-acciones');
    boton.disabled = elegidas.length < 1;
    boton.textContent = elegidas.length === 1 ? 'Continuar con 1 acción' : 'Continuar';
  }

  // ---------- historia 3: hueco y días ----------

  function pintarOpciones(cajaId, opciones, actual, alElegir) {
    var caja = $(cajaId);
    caja.textContent = '';
    opciones.forEach(function (o) {
      var b = crear('button', 'opcion', o.nombre);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', o.id === actual ? 'true' : 'false');
      b.addEventListener('click', function () { alElegir(o.id); });
      caja.appendChild(b);
    });
  }

  function pintarHueco() {
    pintarOpciones('opciones-franja', FRANJAS, franjaElegida, function (id) { franjaElegida = id; pintarHueco(); });
    var dias = [1, 2, 3, 4, 5, 6, 7].map(function (n) { return { id: n, nombre: String(n) }; });
    pintarOpciones('opciones-dias', dias, diasElegidos, function (n) { diasElegidos = n; pintarHueco(); });
    $('btn-hueco').disabled = !(franjaElegida && diasElegidos);
  }

  async function guardarPlan() {
    ponerError('error-hueco', '');
    var boton = $('btn-hueco');
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    try {
      try {
        await rpc('guardar_plan', { p_acciones: elegidas, p_franja: franjaElegida, p_dias: diasElegidos });
      } catch (e) {
        if (claveDe(e) !== 'plan_ya_guardado') throw e;
      }
      await refrescarYRutear();
      if (estado && estado.tiene_plan && estado.acciones.length === 2) {
        toast('Listo. El sorteo decidió cuál de tus acciones lleva hueco.');
      }
    } catch (e) {
      ponerError('error-hueco', mensajeDe(e));
    } finally {
      boton.textContent = 'Guardar mi plan';
      boton.disabled = !(franjaElegida && diasElegidos);
    }
  }

  // ---------- historia 4: registro diario ----------

  function registroDe(fecha, accion) {
    var r = (estado.registros || []).filter(function (x) { return x.fecha === fecha && x.accion === accion; })[0];
    return r ? r.cumplio : null;
  }

  function pintarHoy() {
    var fecha = verAyer ? estado.ayer : estado.hoy;
    $('tab-hoy').classList.toggle('activo', !verAyer);
    $('tab-ayer').classList.toggle('activo', verAyer);
    $('tab-hoy').setAttribute('aria-selected', String(!verAyer));
    $('tab-ayer').setAttribute('aria-selected', String(verAyer));
    $('fecha-dia').textContent = fechaLarga(fecha);

    var caja = $('lista-registro');
    caja.textContent = '';
    estado.acciones.forEach(function (a) {
      var valor = registroDe(fecha, a.id);
      var tarjeta = crear('div', 'tarjeta accion cat-' + (a.categoria || 'movimiento') + (valor === true ? ' hecha' : ''));
      tarjeta.appendChild(crear('span', 'emoji', a.emoji || '•'));

      var cuerpo = crear('div', 'cuerpo');
      cuerpo.appendChild(crear('h3', '', a.nombre));
      var detalle = crear('p', 'detalle');
      if (a.minutos) detalle.appendChild(crear('span', '', a.minutos + ' min · '));
      if (a.id === estado.accion_con_hueco) {
        detalle.appendChild(crear('span', 'hueco', 'Tu hueco: ' + nombreFranja(estado.franja).toLowerCase()));
      } else {
        detalle.appendChild(crear('span', 'hueco sin', 'Sin hueco fijo: cuando puedas'));
      }
      cuerpo.appendChild(detalle);
      tarjeta.appendChild(cuerpo);

      // Un solo toque: marca como cumplida; otro toque la desmarca
      var b = crear('button', 'check', valor === true ? '✓' : '');
      b.type = 'button';
      b.setAttribute('aria-pressed', valor === true ? 'true' : 'false');
      b.setAttribute('aria-label', (valor === true ? 'Desmarcar: ' : 'Marcar como cumplida: ') + a.nombre);
      b.addEventListener('click', function () { marcar(a.id, valor !== true); });
      tarjeta.appendChild(b);
      caja.appendChild(tarjeta);
    });

    var cum = estado.dias_cumplidos_semana || 0;
    var meta = estado.dias_comprometidos || 0;
    $('semana-texto').textContent = cum + ' de ' + meta + (meta === 1 ? ' día' : ' días') + ' · ' + (estado.pct_semana || 0) + ' % de tu meta';
    $('semana-barra').style.width = Math.min(100, estado.pct_semana || 0) + '%';
    pintarSemana();

    pintarOpciones('cambiar-franja', FRANJAS, estado.franja, moverFranja);
  }

  // Historia 8: mi semana (lunes a domingo) y mi racha
  var LETRAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  var NOMBRE_ESTADO = { si: 'cumplido', no: 'no cumplido', pendiente: 'pendiente', futuro: 'por venir', antes: 'antes de entrar' };
  function pintarSemana() {
    var caja = $('semana-dias');
    caja.textContent = '';
    (estado.semana || []).forEach(function (d, i) {
      var dia = crear('div', 'dia ' + d.estado);
      var simbolo = d.estado === 'si' ? '✓' : (d.estado === 'no' ? '–' : '');
      dia.appendChild(crear('span', 'punto', simbolo));
      dia.appendChild(crear('span', '', LETRAS[i]));
      dia.setAttribute('aria-label', fechaLarga(d.fecha) + ': ' + NOMBRE_ESTADO[d.estado]);
      caja.appendChild(dia);
    });
    caja.hidden = !(estado.semana && estado.semana.length);
    var r = estado.racha;
    var texto = '';
    if (typeof r === 'number') {
      texto = r === 0 ? 'Todavía no tienes racha. Empieza hoy.'
        : 'Racha: ' + r + (r === 1 ? ' día' : ' días') + '. Tienes un comodín por semana: un día fallado no la rompe.';
    }
    $('semana-racha').textContent = texto;
    var chip = $('racha-chip');
    chip.hidden = !(typeof r === 'number' && r > 0);
    chip.textContent = '🔥 ' + r;
    chip.setAttribute('aria-label', 'Racha de ' + r + (r === 1 ? ' día' : ' días'));
  }

  async function marcar(accion, cumplio) {
    var fecha = verAyer ? estado.ayer : estado.hoy;
    var eraAyer = verAyer;
    var antes = JSON.parse(JSON.stringify(estado.registros || []));
    // Respuesta inmediata: se pinta primero y se guarda después
    estado.registros = antes.filter(function (x) { return !(x.fecha === fecha && x.accion === accion); });
    estado.registros.push({ fecha: fecha, accion: accion, cumplio: cumplio });
    pintarHoy();
    try {
      await rpc('registrar', { p_accion: accion, p_cumplio: cumplio, p_ayer: eraAyer });
      estado = await rpc('mi_estado');
      pintarHoy();
    } catch (e) {
      estado.registros = antes;
      pintarHoy();
      toast('No se guardó. ' + mensajeDe(e));
    }
  }

  async function moverFranja(id) {
    if (id === estado.franja) return;
    var antes = estado.franja;
    estado.franja = id;
    pintarHoy();
    try {
      await rpc('cambiar_franja', { p_franja: id });
      toast('Hueco movido a: ' + nombreFranja(id).toLowerCase());
    } catch (e) {
      estado.franja = antes;
      pintarHoy();
      toast('No se guardó. ' + mensajeDe(e));
    }
  }

  // ---------- historia 5: tabla de la liga ----------

  async function abrirTabla() {
    mostrar('v-tabla');
    var filas = $('tabla-filas');
    filas.textContent = '';
    $('tabla-pie').hidden = true;
    $('tabla-grupo').hidden = true;
    $('tabla-titulo').textContent = 'Tabla de tu liga';
    $('tabla-mensaje').textContent = 'Cargando…';
    var t;
    try {
      t = await rpc('tabla_liga');
    } catch (e) {
      $('tabla-mensaje').textContent = mensajeDe(e);
      return;
    }
    if (t.estado === 'sin_liga') {
      $('tabla-mensaje').textContent = 'Todavía no tienes liga. El equipo las sortea antes de que arranque el reto. Mientras tanto, tu registro ya cuenta.';
      return;
    }
    $('tabla-titulo').textContent = t.liga;
    if (t.estado === 'apagada') {
      $('tabla-mensaje').textContent = 'La tabla de tu liga todavía no está encendida. Tu registro diario sigue contando.';
      return;
    }
    var mensaje = 'Semana del ' + fechaLarga(t.lunes).replace(/^\S+\s/, '') + '.';
    if (!t.yo_aparezco) mensaje += ' Tú no apareces porque así lo elegiste; lo puedes cambiar en «Mis datos».';
    if (!t.filas.length) mensaje += ' Nadie de tu liga ha aceptado aparecer todavía.';
    $('tabla-mensaje').textContent = mensaje;
    // Historia 11: meta colectiva, sin lista de últimos lugares
    if (t.grupo) {
      $('grupo-texto').textContent = 'El grupo lleva ' + t.grupo.pct + ' % de su meta de la semana';
      $('grupo-barra').style.width = Math.min(100, t.grupo.pct) + '%';
      $('tabla-grupo').hidden = false;
    }
    t.filas.forEach(function (f) {
      var li = crear('li', f.soy_yo ? 'yo' : '');
      var renglon = crear('div', 'renglon');
      renglon.appendChild(crear('span', 'alias', f.alias + (f.soy_yo ? ' (tú)' : '')));
      renglon.appendChild(crear('span', 'pct', f.pct + ' %'));
      li.appendChild(renglon);
      var barra = crear('div', 'barra-avance');
      var relleno = crear('div');
      relleno.style.width = Math.min(100, f.pct) + '%';
      barra.appendChild(relleno);
      li.appendChild(barra);
      if (typeof f.dias === 'number') {
        li.appendChild(crear('p', 'detalle', f.dias + (f.dias === 1 ? ' día cumplido' : ' días cumplidos')
          + ' · racha de ' + f.racha + (f.racha === 1 ? ' día' : ' días')));
      }
      filas.appendChild(li);
    });
    $('tabla-pie').hidden = false;
  }

  // ---------- historias 7 y 9: mis datos ----------

  function abrirDatos() {
    $('datos-alias').textContent = estado.alias;
    var nombres = estado.acciones.map(function (a) { return a.nombre; }).join(' y ');
    var meta = estado.dias_comprometidos;
    $('datos-plan').textContent = nombres + '. Te comprometiste a ' + meta + (meta === 1 ? ' día' : ' días') + ' por semana.';
    $('datos-aparece').checked = !!estado.aparece_en_tabla;
    $('confirmar-borrado').hidden = true;
    $('btn-borrar').hidden = false;
    mostrar('v-datos');
  }

  async function cambiarAparece() {
    var casilla = $('datos-aparece');
    var nuevo = casilla.checked;
    casilla.disabled = true;
    try {
      await rpc('cambiar_aparece', { p_aparece: nuevo });
      estado.aparece_en_tabla = nuevo;
      toast(nuevo ? 'Listo: ahora apareces en la tabla de tu liga.' : 'Listo: ya no apareces en la tabla.');
    } catch (e) {
      casilla.checked = !nuevo;
      toast('No se guardó. ' + mensajeDe(e));
    } finally {
      casilla.disabled = false;
    }
  }

  async function borrarTodo() {
    var boton = $('btn-borrar-si');
    boton.disabled = true;
    boton.textContent = 'Borrando…';
    try {
      await rpc('borrar_mis_datos');
    } catch (e) {
      boton.disabled = false;
      boton.textContent = 'Sí, borrar todo';
      toast('No se pudo borrar. ' + mensajeDe(e));
      return;
    }
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* el usuario ya no existe */ }
    try { localStorage.removeItem('reto.codigo'); } catch (e) { /* sin almacenamiento */ }
    estado = null;
    $('saludo').hidden = true;
    detener('Tus datos se borraron',
      'Se borraron tu alias, tu plan y todos tus registros. Gracias por participar. Si quieres volver, necesitas de nuevo el enlace de invitación.');
  }

  // ---------- eventos ----------

  $('form-alta').addEventListener('submit', enviarAlta);
  $('btn-generar').addEventListener('click', generarAlias);
  $('btn-acciones').addEventListener('click', function () { pintarHueco(); mostrar('v-hueco'); });
  $('btn-hueco-atras').addEventListener('click', function () { mostrar('v-acciones'); });
  $('btn-hueco').addEventListener('click', guardarPlan);
  $('tab-hoy').addEventListener('click', function () { verAyer = false; pintarHoy(); });
  $('tab-ayer').addEventListener('click', function () { verAyer = true; pintarHoy(); });
  $('nav-tabla').addEventListener('click', abrirTabla);
  $('nav-datos').addEventListener('click', abrirDatos);
  $('datos-aparece').addEventListener('change', cambiarAparece);
  $('btn-borrar').addEventListener('click', function () { $('confirmar-borrado').hidden = false; $('btn-borrar').hidden = true; });
  $('btn-borrar-no').addEventListener('click', function () { $('confirmar-borrado').hidden = true; $('btn-borrar').hidden = false; });
  $('btn-borrar-si').addEventListener('click', borrarTodo);
  $('nav-hoy').addEventListener('click', async function () {
    mostrar('v-hoy');
    try { estado = await rpc('mi_estado'); pintarHoy(); } catch (e) { /* se queda con lo que había */ }
  });
  // Al volver a la pestaña (por ejemplo al día siguiente), refresca la fecha
  document.addEventListener('visibilitychange', async function () {
    if (document.visibilityState !== 'visible' || !sb || !estado || !estado.tiene_plan) return;
    try {
      var nuevo = await rpc('mi_estado');
      if (nuevo.hoy !== estado.hoy) verAyer = false;
      estado = nuevo;
      if (!$('v-hoy').hidden) pintarHoy();
    } catch (e) { /* sin conexión: no pasa nada */ }
  });

  iniciar();
})();
