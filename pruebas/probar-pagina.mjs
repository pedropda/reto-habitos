// Prueba de punta a punta: la página real en un navegador (tamaño celular)
// contra el schema.sql real en un Postgres local. Solo se simula el cliente
// de Supabase (auth + transporte); las reglas las corre el SQL de verdad.
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const RAIZ = process.argv[2];
const CAPTURAS = process.argv[3];
mkdirSync(CAPTURAS, { recursive: true });

let ok = 0, mal = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log('  ok  ', nombre); } else { mal++; console.log('  FALLA', nombre, extra); }
};

// ---- Postgres local con auth simulado ----
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
await db.exec(readFileSync(join(RAIZ, 'supabase/schema.sql'), 'utf8'));

const TIPOS = { p_acciones: 'text[]', p_dias: 'int', p_acepta: 'boolean', p_aparece: 'boolean', p_cumplio: 'boolean', p_ayer: 'boolean' };
let cola = Promise.resolve();
const enSerie = fn => (cola = cola.then(fn, fn));
async function backend(op, uid, a, b) {
  return enSerie(async () => {
    try {
      if (op === 'signup') {
        const id = randomUUID();
        await db.query(`insert into auth.users values ($1)`, [id]);
        return { data: id, error: null };
      }
      await db.exec(`reset role; set test.uid = '${uid || ''}'; set role ${uid ? 'authenticated' : 'anon'};`);
      if (op === 'rpc') {
        const claves = Object.keys(b || {});
        const args = claves.map((k, i) => `${k} => $${i + 1}::${TIPOS[k] || 'text'}`).join(', ');
        const r = await db.query(`select public.${a}(${args}) as r`, claves.map(k => b[k]));
        return { data: r.rows[0].r, error: null };
      }
      if (op === 'select') {
        const r = await db.query(`select ${b.cols} from public.${a} order by ${b.orden}`);
        return { data: r.rows, error: null };
      }
      return { data: null, error: { message: 'op desconocida' } };
    } catch (e) {
      return { data: null, error: { message: e.message } };
    } finally {
      await db.exec(`reset role; set test.uid = '';`);
    }
  });
}
const admin = sql => enSerie(() => db.exec(sql));

// ---- Servidor estático ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const servidor = createServer((req, res) => {
  let ruta = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (ruta.endsWith('/')) ruta += 'index.html';
  try {
    const cuerpo = readFileSync(join(RAIZ, ruta));
    res.writeHead(200, { 'content-type': MIME[extname(ruta)] || 'application/octet-stream' });
    res.end(cuerpo);
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise(r => servidor.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;

// ---- Cliente de Supabase simulado (se sirve en lugar del CDN) ----
const STUB = `
window.supabase = { createClient: function () {
  var uid = function () { try { return localStorage.getItem('fake.uid') || ''; } catch (e) { return ''; } };
  return {
    auth: {
      getSession: async function () { return { data: { session: uid() ? { user: { id: uid() } } : null }, error: null }; },
      signInAnonymously: async function () {
        var r = await window.__db('signup', '', null, null);
        if (r.error) return { data: null, error: r.error };
        localStorage.setItem('fake.uid', r.data);
        return { data: { user: { id: r.data } }, error: null };
      },
      signOut: async function () { localStorage.removeItem('fake.uid'); return { error: null }; }
    },
    rpc: function (nombre, args) { return window.__db('rpc', uid(), nombre, args || {}); },
    from: function (tabla) { return { select: function (cols) { return { order: function (orden) {
      return window.__db('select', uid(), tabla, { cols: cols, orden: orden }); } }; } }; }
  };
} };`;
const CONFIG = `window.RETO_CONFIG = { supabaseUrl: 'https://prueba.supabase.co', supabaseKey: 'sb_publishable_prueba',
  responsable: '', correoContacto: '', regionServidor: '' };`;

const navegador = await chromium.launch({ channel: 'chrome', headless: true });
// esquema = tema del sistema del celular simulado: 'light' (claro) o 'dark' (oscuro)
async function nuevoCelular(conConfig = true, esquema = 'light') {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-MX', colorScheme: esquema });
  await ctx.exposeFunction('__db', backend);
  await ctx.route('**/cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
  if (conConfig) await ctx.route('**/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: CONFIG }));
  const pagina = await ctx.newPage();
  const errores = [];
  pagina.on('pageerror', e => errores.push(e.message));
  pagina.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
  return { ctx, pagina, errores };
}
const visible = (p, id) => p.locator('#' + id).isVisible();
// El alias ya no se escribe: para las pruebas se fija directo en el campo
const pon = (pag, alias) => pag.evaluate(a => { document.getElementById('alias').value = a; }, alias);
const foto = (p, nombre) => p.screenshot({ path: join(CAPTURAS, nombre + '.png'), fullPage: true });

// ===== 0. Sin configurar y sin enlace =====
{
  const { pagina, ctx } = await nuevoCelular(false);
  await pagina.goto(BASE + '/?c=PRUEBA');
  check('sin config.js lleno avisa que falta configurar', (await pagina.textContent('#sistema-titulo')).includes('Falta configurar'));
  await ctx.close();
  const b = await nuevoCelular();
  await b.pagina.goto(BASE + '/');
  await b.pagina.waitForSelector('#v-aviso-sistema:not([hidden])');
  check('sin enlace de invitación no deja entrar', (await b.pagina.textContent('#sistema-titulo')).includes('enlace de invitación'));
  await b.ctx.close();
}

// ===== 1. Participante A: flujo completo =====
const A = await nuevoCelular();
const p = A.pagina;
await p.goto(BASE + '/?c=prueba');
await p.waitForSelector('#v-alta:not([hidden])');
check('historia 1: abre la pantalla de alta', await visible(p, 'v-alta'));
check('las dos casillas llegan sin marcar', !(await p.isChecked('#acepta')) && !(await p.isChecked('#aparece')));
await foto(p, '1-alta');

const inicial = await p.inputValue('#alias');
check('el alias llega asignado al azar, sin espacios (animal y dos cifras)', /^[A-Z][a-z]{2,16}\d{2}$/.test(inicial), inicial);
check('el alias no se puede escribir', await p.locator('#alias').evaluate(e => e.readOnly));
await p.tap('#btn-generar');
const generado = await p.inputValue('#alias');
check('«Otro» sortea un alias distinto', /^[A-Z][a-z]{2,16}\d{2}$/.test(generado) && generado !== inicial, generado);
await pon(p, 'Colibri22');
await p.tap('#btn-alta');
check('sin aceptar el aviso no entra', (await p.textContent('#error-alta')).includes('aceptar el aviso'));
const antes = (await db.query(`select count(*)::int n from auth.users`)).rows[0].n;
check('nada sale del celular antes de aceptar (no se creó sesión)', antes === 0);

await p.check('#acepta');
await p.check('#aparece');
await p.tap('#btn-alta');
await p.waitForSelector('#v-acciones:not([hidden])');
check('historia 2: pasa a elegir micro-acciones', await visible(p, 'v-acciones'));
await p.waitForSelector('#lista-catalogo .opcion');
check('catálogo con 10 acciones en 4 categorías, con emoji', (await p.locator('#lista-catalogo .opcion').count()) === 10 && (await p.locator('#lista-catalogo .categoria').count()) === 4 && (await p.locator('#lista-catalogo .emoji', { hasText: '•' }).count()) === 0 && (await p.locator('#lista-catalogo .emoji').count()) === 10);
check('el aviso completo va plegado y las casillas siguen a la vista', (await p.locator('details.aviso').count()) === 1 && !(await p.locator('details.aviso').getAttribute('open')));
check('sin elegir no se puede continuar', await p.isDisabled('#btn-acciones'));
await p.locator('#lista-catalogo .opcion', { hasText: 'Caminar' }).tap();
await p.locator('#lista-catalogo .opcion', { hasText: 'vasos de agua' }).tap();
check('con 2 elegidas, las demás se bloquean', await p.locator('#lista-catalogo .opcion', { hasText: 'Estirar' }).isDisabled());
await foto(p, '2-acciones');
await p.tap('#btn-acciones');

check('historia 3: pantalla de hueco y días', await visible(p, 'v-hueco'));
check('sin franja ni días no se guarda', await p.isDisabled('#btn-hueco'));
await p.locator('#opciones-franja .opcion', { hasText: 'Hora de la comida' }).tap();
await p.locator('#opciones-dias .opcion', { hasText: '4' }).tap();
await foto(p, '3-hueco');
await p.tap('#btn-hueco');
await p.waitForSelector('#v-hoy:not([hidden])');
check('historia 4: llega al registro diario', await visible(p, 'v-hoy'));
check('2 tarjetas: una con hueco y otra sin hueco',
  (await p.locator('.accion').count()) === 2 && (await p.locator('.hueco.sin').count()) === 1
  && (await p.locator('.hueco:not(.sin)').textContent()).includes('hora de la comida'));
check('saludo con el alias', (await p.textContent('#saludo')) === 'Colibri22');

// registrar hoy
const t0 = Date.now();
await p.locator('.accion').nth(0).locator('button.check').tap();
await p.waitForFunction(() => document.getElementById('semana-texto').textContent.startsWith('1 de 4'));
check('un solo toque marca la acción y actualiza la semana', (await p.textContent('#semana-texto')) === '1 de 4 días · 25 % de tu meta', await p.textContent('#semana-texto'));
check('el toque responde en menos de 1 s', Date.now() - t0 < 1000);
await p.locator('.accion').nth(1).locator('button.check').tap();
await p.waitForFunction(() => document.querySelectorAll('.accion button.check[aria-pressed="true"]').length === 2);
await p.locator('.accion').nth(1).locator('button.check').tap();
await p.waitForFunction(() => document.querySelectorAll('.accion button.check[aria-pressed="true"]').length === 1);
check('otro toque desmarca: queda una cumplida y una no', (await p.locator('.accion').nth(0).locator('button.check').getAttribute('aria-pressed')) === 'true'
  && (await p.locator('.accion').nth(1).locator('button.check').getAttribute('aria-pressed')) === 'false');
check('las tarjetas llevan emoji y color de su categoría', (await p.locator('.accion .emoji').count()) === 2 && (await p.locator('.accion[class*="cat-"]').count()) === 2);
await foto(p, '4-registro');

// ayer
await p.tap('#tab-ayer');
check('ayer empieza sin marcar', (await p.locator('button.check[aria-pressed="true"]').count()) === 0);
await p.locator('.accion').nth(1).locator('button.check').tap();
const esLunes = (await db.query(`select extract(isodow from public.hoy_cdmx())::int d`)).rows[0].d === 1;
const esperado = esLunes ? '1 de 4' : '2 de 4';
await p.waitForFunction(e => document.getElementById('semana-texto').textContent.startsWith(e), esperado);
check('registrar ayer cuenta en la semana que le toca', true);
const filasBD = (await db.query(`select fecha::text, accion_id, cumplio from public.registros order by fecha, accion_id`)).rows;
check('en la base quedan 3 registros: 2 de hoy y 1 de ayer', filasBD.length === 3, JSON.stringify(filasBD));

// mover franja
await p.locator('#cambiar-franja .opcion', { hasText: 'Al llegar a casa' }).tap();
await p.waitForTimeout(300);
await p.tap('#tab-hoy');
check('mover la franja se refleja en la tarjeta', (await p.locator('.hueco:not(.sin)').textContent()).includes('al llegar a casa'));
check('y queda guardada en la base', (await db.query(`select franja from public.participantes`)).rows[0].franja === 'llegar_casa');

// tabla: sin liga -> apagada -> encendida
await p.tap('#nav-tabla');
await p.waitForFunction(() => document.getElementById('tabla-mensaje').textContent.includes('no tienes liga'));
check('historia 5: sin liga, lo explica', true);
await admin(`update public.participantes set liga_id = (select id from public.ligas limit 1)`);
await p.tap('#nav-tabla');
await p.waitForFunction(() => document.getElementById('tabla-mensaje').textContent.includes('no está encendida'));
check('historia 6: tabla apagada por defecto', (await p.locator('#tabla-filas li').count()) === 0);
await admin(`update public.ligas set tabla_encendida = true`);
await p.tap('#nav-tabla');
await p.waitForSelector('#tabla-filas li');
const fila = await p.locator('#tabla-filas li').first().textContent();
check('tabla encendida: alias y % de la meta propia', fila.includes('Colibri22 (tú)') && fila.includes(esLunes ? '25 %' : '50 %'), fila);
check('la tabla no menciona acciones', !/Caminar|agua/i.test(await p.textContent('#v-tabla')));

// volver a entrar sin el enlace
await p.goto(BASE + '/');
await p.waitForSelector('#v-hoy:not([hidden])');
check('al volver sin enlace entra directo al registro (mismo celular)', await visible(p, 'v-hoy'));
check('y conserva lo marcado hoy', (await p.locator('.accion').nth(0).locator('button.check').getAttribute('aria-pressed')) === 'true');

// ===== 2. Participante B: alias repetido, 1 acción, no aparece =====
const B = await nuevoCelular();
const q = B.pagina;
await q.goto(BASE + '/?c=PRUEBA');
await q.waitForSelector('#v-alta:not([hidden])');
await pon(q, 'colibri22');
await q.check('#acepta');
await q.tap('#btn-alta');
await q.waitForSelector('#v-acciones:not([hidden])');
const aliasB = await q.textContent('#saludo');
check('alias repetido: la página sortea otro sola y entra', /^[A-Z][a-z]{2,16}\d{2}$/.test(aliasB) && aliasB.toLowerCase() !== 'colibri22', aliasB);
check('el reintento reusa la misma sesión', (await db.query(`select count(*)::int n from auth.users`)).rows[0].n === 2);
await q.waitForSelector('#lista-catalogo .opcion');
await q.locator('#lista-catalogo .opcion', { hasText: 'Estirar' }).tap();
check('con 1 acción el botón lo dice', (await q.textContent('#btn-acciones')) === 'Continuar con 1 acción');
// recargar a medio camino: debe volver al paso 2, no al alta
await q.reload();
await q.waitForSelector('#v-acciones:not([hidden])');
check('si recarga a medio camino, retoma en el paso 2', await visible(q, 'v-acciones'));
await q.waitForSelector('#lista-catalogo .opcion');
await q.locator('#lista-catalogo .opcion', { hasText: 'Estirar' }).tap();
await q.tap('#btn-acciones');
await q.locator('#opciones-franja .opcion', { hasText: 'Antes de clase' }).tap();
await q.locator('#opciones-dias .opcion', { hasText: '2' }).tap();
await q.tap('#btn-hueco');
await q.waitForSelector('#v-hoy:not([hidden])');
check('con 1 acción: una tarjeta y lleva hueco', (await q.locator('.accion').count()) === 1 && (await q.locator('.hueco.sin').count()) === 0);
await admin(`update public.participantes set liga_id = (select id from public.ligas limit 1)`);
await q.tap('#nav-tabla');
await q.waitForSelector('#tabla-filas li');
check('B no aceptó aparecer: ve la tabla, pero no sale en ella',
  (await q.locator('#tabla-filas li').count()) === 1 && (await q.textContent('#tabla-mensaje')).includes('no apareces'));
await foto(q, '5-tabla');

// ===== Iteración 2 (historias 7 a 11) =====
// Historia 8: mi semana y racha (A marcó sí hoy y ayer)
await p.goto(BASE + '/');
await p.waitForSelector('#v-hoy:not([hidden])');
check('historia 8: mi semana muestra 7 días', (await p.locator('#semana-dias .dia').count()) === 7);
check('historia 8: hoy aparece como cumplido', (await p.locator('#semana-dias .dia.si').count()) >= 1);
check('historia 8: la racha se ve arriba con su contador', (await p.textContent('#racha-chip')).includes('2'));
check('historia 8: racha de 2 días con aviso del comodín', (await p.textContent('#semana-racha')).startsWith('Racha: 2 días'), await p.textContent('#semana-racha'));
await foto(p, '6-registro-v02');
await p.tap('#nav-tabla');
await p.waitForSelector('#tabla-filas li');
const detalleA = await p.locator('#tabla-filas li .detalle').first().textContent();
check('historia 8: la tabla muestra días cumplidos y racha', /días? cumplidos?/.test(detalleA) && detalleA.includes('racha de 2 días'), detalleA);
check('historia 11: con 2 personas no se muestra la meta del grupo', !(await visible(p, 'tabla-grupo')));

// Historia 7: B cambia su decisión de aparecer
await q.tap('#nav-datos');
check('historia 7: «Mis datos» muestra alias y plan', (await q.textContent('#datos-alias')) === aliasB && (await q.textContent('#datos-plan')).includes('2 días por semana'));
check('la casilla refleja que B no aparece', !(await q.isChecked('#datos-aparece')));
await q.check('#datos-aparece');
await q.waitForFunction(() => !document.getElementById('toast').hidden);
await q.tap('#nav-tabla');
await q.waitForFunction(() => document.querySelectorAll('#tabla-filas li').length === 2);
check('historia 7: al aceptar, B aparece en la tabla', (await q.textContent('#v-tabla')).includes(aliasB + ' (tú)'));
await foto(q, '7-tabla-v02');
await q.tap('#nav-datos');
await q.uncheck('#datos-aparece');
await q.waitForTimeout(400);
await p.tap('#nav-hoy'); await p.tap('#nav-tabla');
await p.waitForSelector('#tabla-filas li');
await p.waitForTimeout(300);
check('historia 7: al ocultarse, A ya no ve a B', (await p.locator('#tabla-filas li').count()) === 1);

// Historia 11: meta colectiva con 5 personas en la cohorte
await admin(`
  insert into auth.users select ('00000000-0000-0000-0000-00000000000' || n)::uuid from generate_series(1, 3) n;
  insert into public.participantes (id, cohorte, alias, consentimiento_en, accion_a, accion_con_hueco, franja, dias_comprometidos, plan_en)
  select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'PRUEBA', 'Extra ' || n, now(), 'agua', 'agua', 'comida', 3, now() from generate_series(1, 3) n;`);
await p.tap('#nav-hoy'); await p.tap('#nav-tabla');
await p.waitForSelector('#tabla-grupo:not([hidden])');
check('historia 11: con 5 personas aparece la meta del grupo, sin nombres', /El grupo lleva \d+ % de su meta/.test(await p.textContent('#grupo-texto')) && !(await p.textContent('#tabla-grupo')).includes('Extra'));

// Historia 9: salir y borrar mis datos
await q.tap('#nav-datos');
await foto(q, '8-mis-datos');
await q.tap('#btn-borrar');
check('historia 9: pide confirmar antes de borrar', await visible(q, 'confirmar-borrado'));
await q.tap('#btn-borrar-no');
check('cancelar no borra nada', !(await visible(q, 'confirmar-borrado')) && (await db.query(`select count(*)::int n from public.participantes where alias = '${aliasB}'`)).rows[0].n === 1);
await q.tap('#btn-borrar');
await q.tap('#btn-borrar-si');
await q.waitForSelector('#v-aviso-sistema:not([hidden])');
check('historia 9: confirma que los datos se borraron', (await q.textContent('#sistema-titulo')) === 'Tus datos se borraron');
const resto = (await db.query(`select (select count(*) from public.participantes where alias = '${aliasB}')::int p, (select count(*) from public.registros r join public.participantes x on x.id = r.participante_id where x.alias = '${aliasB}')::int r`)).rows[0];
check('historia 9: en la base ya no queda nada de B', resto.p === 0 && resto.r === 0);
await q.goto(BASE + '/');
await q.waitForSelector('#v-aviso-sistema:not([hidden])');
check('historia 9: al volver ya no tiene sesión ni enlace guardado', (await q.textContent('#sistema-titulo')).includes('enlace de invitación'));

// ===== 3. Enlace inválido =====
const C = await nuevoCelular();
await C.pagina.goto(BASE + '/?c=NOEXISTE');
await C.pagina.waitForSelector('#v-alta:not([hidden])');
await pon(C.pagina, 'Tlacuache');
await C.pagina.check('#acepta');
await C.pagina.tap('#btn-alta');
await C.pagina.waitForSelector('#error-alta:not([hidden])');
check('enlace con código inválido: no da de alta', (await C.pagina.textContent('#error-alta')).includes('enlace de invitación no es válido')
  && (await db.query(`select count(*)::int n from public.participantes where alias = 'Tlacuache'`)).rows[0].n === 0);

// ===== 4. Alta con un alias generado =====
const D = await nuevoCelular();
await D.pagina.goto(BASE + '/?c=PRUEBA');
await D.pagina.waitForSelector('#v-alta:not([hidden])');
await D.pagina.tap('#btn-generar');
const aliasD = await D.pagina.inputValue('#alias');
await D.pagina.check('#acepta');
await D.pagina.tap('#btn-alta');
await D.pagina.waitForSelector('#v-acciones:not([hidden])');
check('el alias generado se acepta en el alta', (await db.query(`select count(*)::int n from public.participantes where alias = $1`, [aliasD])).rows[0].n === 1, aliasD);

// ===== 5. Versión 0.3: marca «Racha», ícono de la pestaña y tema claro/oscuro =====
const tema = pag => pag.evaluate(() => document.documentElement.getAttribute('data-tema'));
// Contraste WCAG entre el color del texto y el fondo real que tiene detrás
const contraste = (pag, selector) => pag.evaluate(sel => {
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const rgb = t => (t.match(/[\d.]+/g) || []).map(Number);
  const el = document.querySelector(sel);
  const texto = rgb(getComputedStyle(el).color).slice(0, 3);
  let fondo = null;
  for (let n = el; n && !fondo; n = n.parentElement) {
    const c = rgb(getComputedStyle(n).backgroundColor);
    if (c.length === 3 || (c.length === 4 && c[3] >= 0.9)) fondo = c.slice(0, 3);
  }
  if (!fondo) fondo = rgb(getComputedStyle(document.body).backgroundColor).slice(0, 3);
  const a = lum(texto), b = lum(fondo);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, selector);
const LEGIBLES = ['#semana-texto', '#fecha-dia', '.accion h3', '.accion .detalle', '.accion .hueco:not(.sin)', '#semana-racha', '.navegacion button.activo', '.navegacion button:not(.activo)', '#cambiar-franja .opcion[aria-checked="true"]', '.marca'];
async function revisarContraste(pag, nombre) {
  const bajos = [];
  for (const sel of LEGIBLES) {
    if (!(await pag.locator(sel).count())) continue;
    const c = await contraste(pag, sel);
    if (c < 4.5) bajos.push(sel + ' ' + c.toFixed(2));
  }
  check('tema ' + nombre + ': el texto del registro se lee (contraste de 4.5 o más)', bajos.length === 0, bajos.join(' | '));
}

await p.goto(BASE + '/');
await p.waitForSelector('#v-hoy:not([hidden])');
check('v0.3: la pestaña del navegador dice «Racha»', (await p.title()) === 'Racha');
check('v0.3: la marca se ve arriba, con logo', (await p.textContent('.marca')).trim() === 'Racha' && (await p.locator('.marca svg').count()) === 1);
const iconos = await p.evaluate(async () => {
  const ligas = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map(l => l.href);
  const estados = await Promise.all(ligas.map(u => fetch(u).then(r => r.status)));
  return { n: ligas.length, todosOk: estados.every(e => e === 200) };
});
check('v0.3: ícono de la pestaña (SVG y PNG), ícono para iPhone y manifiesto se sirven', iconos.n === 4 && iconos.todosOk, JSON.stringify(iconos));
const manifiesto = JSON.parse(readFileSync(join(RAIZ, 'site.webmanifest'), 'utf8'));
check('v0.3: el manifiesto lleva el nombre y los íconos existen', manifiesto.name === 'Racha' && manifiesto.icons.every(i => { try { readFileSync(join(RAIZ, i.src)); return true; } catch { return false; } }));

check('tema: con el celular en claro, la página abre en claro', (await tema(p)) === 'claro');
await revisarContraste(p, 'claro');
await foto(p, '9-registro-claro');
await p.tap('#btn-tema');
check('tema: el botón de arriba cambia a oscuro', (await tema(p)) === 'oscuro');
check('tema: el color de la barra del navegador cambia con el tema', (await p.getAttribute('meta[name="theme-color"]', 'content')) === '#101412');
await revisarContraste(p, 'oscuro');
await p.reload();
await p.waitForSelector('#v-hoy:not([hidden])');
check('tema: la elección se recuerda al volver a abrir', (await tema(p)) === 'oscuro');
await foto(p, '10-registro-oscuro');
await p.tap('#nav-datos');
await p.waitForSelector('#v-datos:not([hidden])');
check('tema: «Mis datos» ofrece Automático, Claro y Oscuro, y marca el actual',
  (await p.locator('#opciones-tema .opcion').count()) === 3
  && (await p.locator('#opciones-tema .opcion[aria-checked="true"]').textContent()) === 'Oscuro');
await p.locator('#opciones-tema .opcion', { hasText: 'Automático' }).tap();
check('tema: «Automático» vuelve a seguir al celular', (await tema(p)) === 'claro'
  && (await p.evaluate(() => localStorage.getItem('racha.tema'))) === null);
await foto(p, '11-mis-datos-claro');
await p.tap('#nav-tabla');
await p.waitForSelector('#tabla-filas li');
await foto(p, '12-tabla-claro');
check('tema: cambiar de tema no toca la sesión ni el enlace guardado',
  (await p.evaluate(() => localStorage.getItem('reto.codigo'))) === 'PRUEBA' && (await p.textContent('#saludo')) === 'Colibri22');

// En una pantalla de computadora la página queda en una columna centrada, con la barra de abajo del mismo ancho
await p.setViewportSize({ width: 1280, height: 800 });
await p.tap('#nav-hoy');
await p.waitForSelector('#v-hoy:not([hidden])');
const anchos = await p.evaluate(() => ({ nav: document.getElementById('navegacion').getBoundingClientRect().width, main: document.querySelector('main').getBoundingClientRect().width }));
check('en computadora: columna centrada y barra de navegación del mismo ancho', anchos.nav <= 522 && anchos.main <= 522, JSON.stringify(anchos));
await p.screenshot({ path: join(CAPTURAS, '16-escritorio-claro.png') });
await p.setViewportSize({ width: 390, height: 844 });

// Celular con el sistema en oscuro: alta completa en oscuro, y a 360 px no se desborda
const E = await nuevoCelular(true, 'dark');
await E.pagina.setViewportSize({ width: 360, height: 740 });
await E.pagina.goto(BASE + '/?c=PRUEBA');
await E.pagina.waitForSelector('#v-alta:not([hidden])');
check('tema: con el celular en oscuro, la página abre en oscuro', (await tema(E.pagina)) === 'oscuro');
const sinDesborde = pag => pag.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
check('a 360 px de ancho el alta no se desborda', await sinDesborde(E.pagina));
await foto(E.pagina, '13-alta-oscuro');
await E.pagina.tap('#btn-tema');
check('tema: desde el alta también se puede cambiar a claro', (await tema(E.pagina)) === 'claro');
await foto(E.pagina, '14-alta-claro');
await E.pagina.check('#acepta');
await E.pagina.tap('#btn-alta');
await E.pagina.waitForSelector('#lista-catalogo .opcion');
check('a 360 px el catálogo no se desborda', await sinDesborde(E.pagina));
const bajosCat = [];
for (const sel of ['.categoria', '.accion-opcion .nombre', '.accion-opcion .min', '#btn-acciones', '.paso']) {
  const c = await contraste(E.pagina, sel);
  if (c < 4.5) bajosCat.push(sel + ' ' + c.toFixed(2));
}
check('tema claro: el catálogo se lee (contraste de 4.5 o más)', bajosCat.length === 0, bajosCat.join(' | '));
await foto(E.pagina, '15-acciones-claro');
await E.pagina.goto(BASE + '/aviso.html');
check('el aviso de privacidad lleva la marca y respeta el tema elegido', (await E.pagina.title()).includes('Racha') && (await tema(E.pagina)) === 'claro');

const todos = [...A.errores, ...B.errores, ...C.errores, ...D.errores, ...E.errores];
check('sin errores de JavaScript en consola', todos.length === 0, JSON.stringify(todos));

await navegador.close();
servidor.close();
console.log(`\n${ok} pruebas pasaron, ${mal} fallaron`);
process.exit(mal ? 1 : 0);
