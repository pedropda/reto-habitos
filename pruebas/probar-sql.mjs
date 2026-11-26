// Prueba del schema.sql en un Postgres local (PGlite) con un auth simulado.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schema = readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
let ok = 0, mal = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log('  ok  ', nombre); }
  else { mal++; console.log('  FALLA', nombre, extra); }
};
const falla = async (nombre, sql, esperado) => {
  try { await db.exec(sql); check(nombre, false, '(no falló)'); }
  catch (e) { check(nombre, e.message.includes(esperado), '→ ' + e.message); }
};

// --- Simulación mínima de Supabase ---
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
await db.exec(schema);
await db.exec(schema); // se puede correr dos veces
check('el schema corre dos veces sin error', true);

const U = n => `00000000-0000-0000-0000-00000000000${n}`;
for (let i = 1; i <= 5; i++) await db.exec(`insert into auth.users values ('${U(i)}')`);
const como = async n => db.exec(`reset role; set test.uid = '${n ? U(n) : ''}'; set role authenticated;`);
const admin = async () => db.exec(`reset role; set test.uid = '';`);
const rpc = async sql => (await db.query(`select ${sql} as r`)).rows[0].r;

// --- Historia 1: alta ---
await como(1);
check('mi_estado sin alta', (await rpc('public.mi_estado()')).alta === false);
await falla('alta sin consentimiento', `select public.alta('PRUEBA','Lobo', false, false)`, 'falta_consentimiento');
await falla('alta con código malo', `select public.alta('NOEXISTE','Lobo', true, false)`, 'codigo_invalido');
await falla('alias muy corto', `select public.alta('PRUEBA','ab', true, false)`, 'alias_invalido');
await falla('alias con símbolos', `select public.alta('PRUEBA','a@b.com', true, false)`, 'alias_invalido');
await db.exec(`select public.alta('prueba','  Lobo  Gris ', true, true)`);
let e = await rpc('public.mi_estado()');
check('alta guarda alias limpio', e.alta && e.alias === 'Lobo Gris' && e.tiene_plan === false, JSON.stringify(e));
await falla('no hay doble alta', `select public.alta('PRUEBA','Otro', true, false)`, 'ya_tiene_alta');
await como(2);
await falla('alias ocupado (sin importar mayúsculas)', `select public.alta('PRUEBA','lobo gris', true, false)`, 'alias_ocupado');
await db.exec(`select public.alta('PRUEBA','Ñandú_7', true, false)`);
check('alias con ñ y acento', (await rpc('public.mi_estado()')).alias === 'Ñandú_7');
await admin();
const c = (await db.query(`select consentimiento_en, aparece_en_tabla from public.participantes where id='${U(1)}'`)).rows[0];
check('se guarda fecha y hora del consentimiento', c.consentimiento_en instanceof Date && c.aparece_en_tabla === true);

// --- Sin sesión / anónimo sin entrar ---
await db.exec(`reset role; set test.uid=''; set role anon;`);
await falla('anon no puede llamar funciones', `select public.mi_estado()`, 'permission denied');
await falla('anon no lee participantes', `select * from public.participantes`, 'permission denied');

// --- Historias 2 y 3: plan ---
await como(1);
await falla('registrar sin plan', `select public.registrar('caminar', true)`, 'sin_plan');
await falla('3 acciones', `select public.guardar_plan(array['caminar','agua','estirar'],'comida',4)`, 'acciones_invalidas');
await falla('acción repetida', `select public.guardar_plan(array['caminar','caminar'],'comida',4)`, 'acciones_invalidas');
await falla('acción fuera del catálogo', `select public.guardar_plan(array['caminar','dormir12h'],'comida',4)`, 'acciones_invalidas');
await falla('franja inválida', `select public.guardar_plan(array['caminar','agua'],'madrugada',4)`, 'franja_invalida');
await falla('días inválidos', `select public.guardar_plan(array['caminar','agua'],'comida',8)`, 'dias_invalidos');
await db.exec(`select public.guardar_plan(array['caminar','agua'],'comida',4)`);
e = await rpc('public.mi_estado()');
check('plan con 2 acciones y sorteo', e.tiene_plan && e.acciones.length === 2 && ['caminar', 'agua'].includes(e.accion_con_hueco)
  && e.acciones[0].id === e.accion_con_hueco && e.dias_comprometidos === 4, JSON.stringify(e));
await falla('el plan no se guarda dos veces', `select public.guardar_plan(array['estirar'],'comida',4)`, 'plan_ya_guardado');
await db.exec(`select public.cambiar_franja('llegar_casa')`);
check('mover la franja', (await rpc('public.mi_estado()')).franja === 'llegar_casa');
await como(2);
await db.exec(`select public.guardar_plan(array['estirar'],'antes_clase',2)`);
e = await rpc('public.mi_estado()');
check('plan con 1 acción: esa lleva hueco', e.acciones.length === 1 && e.accion_con_hueco === 'estirar');

// --- Historia 4: registro ---
await como(1);
await falla('acción que no es mía', `select public.registrar('estirar', true)`, 'accion_invalida');
await db.exec(`select public.registrar('caminar', true); select public.registrar('agua', false);`);
await db.exec(`select public.registrar('agua', true, true);`); // ayer
await db.exec(`select public.registrar('caminar', false);`);   // corrige hoy
e = await rpc('public.mi_estado()');
const hoyReg = e.registros.filter(r => r.fecha === e.hoy), ayerReg = e.registros.filter(r => r.fecha === e.ayer);
check('registros de hoy y ayer, con corrección', hoyReg.length === 2 && hoyReg.every(r => r.cumplio === false)
  && ayerReg.length === 1 && ayerReg[0].cumplio === true, JSON.stringify(e.registros));
const cdmx = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
check('"hoy" es la fecha de la Ciudad de México', e.hoy === cdmx, `${e.hoy} vs ${cdmx}`);
check('lunes es lunes', new Date(e.lunes + 'T12:00:00Z').getUTCDay() === 1, e.lunes);

// --- RLS: cada quien solo lee lo suyo y nadie escribe directo ---
let filas = (await db.query(`select participante_id from public.registros`)).rows;
check('solo veo mis registros', filas.length === 3 && filas.every(f => f.participante_id === U(1)));
filas = (await db.query(`select alias from public.participantes`)).rows;
check('solo veo mi fila de participante', filas.length === 1 && filas[0].alias === 'Lobo Gris');
await falla('no puedo insertar registros directo', `insert into public.registros values ('${U(1)}','2026-01-01','caminar',true)`, 'permission denied');
await falla('no puedo cambiar mi liga', `update public.participantes set liga_id = 1`, 'permission denied');
await falla('no puedo leer cohortes', `select * from public.cohortes`, 'permission denied');
await falla('no puedo leer ligas', `select * from public.ligas`, 'permission denied');
check('sí leo el catálogo (10 acciones)', (await db.query(`select * from public.catalogo`)).rows.length === 10);

// --- Historias 5 y 6: tabla e interruptor ---
check('sin liga', (await rpc('public.tabla_liga()')).estado === 'sin_liga');
await admin();
await db.exec(`update public.participantes set liga_id = (select id from public.ligas limit 1)`);
await como(1);
check('tabla apagada por defecto', (await rpc('public.tabla_liga()')).estado === 'apagada');
await admin();
await db.exec(`update public.ligas set tabla_encendida = true`);
// datos fijos para el %: 3 días cumplidos de 4 esta semana para el usuario 1
await db.exec(`
  delete from public.registros;
  insert into public.registros (participante_id, fecha, accion_id, cumplio)
  select '${U(1)}', date_trunc('week', public.hoy_cdmx()::timestamp)::date + d, a, d < 3
  from generate_series(0, 3) d, unnest(array['caminar','agua']) a;
  insert into public.registros values ('${U(1)}', date_trunc('week', public.hoy_cdmx()::timestamp)::date - 1, 'caminar', true);
  insert into public.registros values ('${U(2)}', date_trunc('week', public.hoy_cdmx()::timestamp)::date, 'estirar', true);
`);
await como(1);
let t = await rpc('public.tabla_liga()');
check('tabla encendida: solo quien aceptó aparecer, con % propio', t.estado === 'encendida' && t.filas.length === 1
  && t.filas[0].alias === 'Lobo Gris' && t.filas[0].pct === 75 && t.filas[0].soy_yo, JSON.stringify(t));
check('la tabla no dice qué acción es', !JSON.stringify(t).match(/caminar|agua|estirar/));
e = await rpc('public.mi_estado()');
check('mi semana: 3 de 4 = 75 % (la semana pasada no cuenta)', e.dias_cumplidos_semana === 3 && e.pct_semana === 75);
await como(2);
t = await rpc('public.tabla_liga()');
check('quien no aparece ve la tabla pero no sale en ella', t.filas.length === 1 && !t.yo_aparezco && !t.filas[0].soy_yo);
await admin();
await db.exec(`update public.participantes set aparece_en_tabla = true where id='${U(2)}';
  insert into public.registros values ('${U(2)}', date_trunc('week', public.hoy_cdmx()::timestamp)::date + 1, 'estirar', true);
  insert into public.registros values ('${U(2)}', date_trunc('week', public.hoy_cdmx()::timestamp)::date + 2, 'estirar', true);`);
await como(2);
t = await rpc('public.tabla_liga()');
check('tope de 100 % y orden por % de la meta propia', t.filas[0].alias === 'Ñandú_7' && t.filas[0].pct === 100 && t.filas[1].pct === 75, JSON.stringify(t.filas));

// ================= Iteración 2 (historias 7 a 11) =================
await admin();
const lunesISO = (await db.query(`select date_trunc('week', public.hoy_cdmx()::timestamp)::date::text l, extract(isodow from public.hoy_cdmx())::int d`)).rows[0];
const dow = lunesISO.d; // 1 = lunes ... 7 = domingo
await admin();
await db.exec(`update public.participantes set plan_en = now() - interval '30 days'; delete from public.registros;`);
const pon = async (n, offs) => { for (const o of offs) await db.exec(`insert into public.registros values ('${U(n)}', public.hoy_cdmx() - ${o}, '${n === 1 ? 'caminar' : 'estirar'}', true)`); };

// Historia 8: racha con comodín
await pon(1, [0, 1, 3]);
await como(1);
e = await rpc('public.mi_estado()');
check('racha: hoy, ayer y antier fallado con comodín = 3', e.racha === 3, 'racha ' + e.racha);
await admin(); await db.exec(`delete from public.registros`); await pon(1, [1, 2]);
await como(1);
check('racha: hoy sin registrar todavía no rompe la racha', (await rpc('public.mi_estado()')).racha === 2);
await admin(); await db.exec(`delete from public.registros`); await pon(1, [0, 3]);
await como(1);
// hoy-1 y hoy-2 fallados: si caen en la misma semana solo hay un comodín
const mismaSemana = dow !== 2; // martes: hoy-1 es lunes y hoy-2 es domingo de la semana pasada
e = await rpc('public.mi_estado()');
check('racha: dos fallas en la misma semana la rompen (un comodín por semana)', e.racha === (mismaSemana ? 1 : 2), `racha ${e.racha}, dow ${dow}`);
await admin(); await db.exec(`delete from public.registros`);
await como(1);
check('racha sin registros = 0', (await rpc('public.mi_estado()')).racha === 0);
await falla('la página no puede llamar racha() de otra persona', `select public.racha('${U(2)}')`, 'permission denied');

// Historia 8: mi semana
await admin(); await pon(1, [0]);
await como(1);
e = await rpc('public.mi_estado()');
check('mi semana trae 7 días, de lunes a domingo', e.semana.length === 7 && e.semana[0].fecha === lunesISO.l, JSON.stringify(e.semana));
check('mi semana: hoy en "si" y los días que faltan en "futuro"', e.semana[dow - 1].estado === 'si' && e.semana.slice(dow).every(x => x.estado === 'futuro'));
check('mi semana: días pasados sin registro en "no"', e.semana.slice(0, dow - 1).every(x => x.estado === 'no'));
await admin(); await db.exec(`delete from public.registros`);
await como(1);
check('mi semana: hoy sin registrar en "pendiente"', (await rpc('public.mi_estado()')).semana[dow - 1].estado === 'pendiente');

// Historia 7: cambiar la decisión de aparecer
await admin(); await pon(1, [0]); await pon(2, [0]);
await como(1);
await db.exec(`select public.cambiar_aparece(false)`);
t = await rpc('public.tabla_liga()');
check('historia 7: al ocultarme dejo de salir en la tabla', !t.yo_aparezco && t.filas.every(f => !f.soy_yo) && t.filas.length === 1);
await db.exec(`select public.cambiar_aparece(true)`);
t = await rpc('public.tabla_liga()');
check('historia 7: al volver a aceptar, aparezco de nuevo', t.yo_aparezco && t.filas.length === 2);
const yo = t.filas.find(f => f.soy_yo);
check('historia 8: la tabla trae días cumplidos y racha', yo.dias === 1 && yo.racha === 1 && yo.pct === 25, JSON.stringify(yo));
check('la tabla sigue sin decir qué acción es', !JSON.stringify(t).match(/caminar|agua|estirar/));

// Historia 11: meta colectiva
check('meta colectiva oculta con menos de 5 personas', t.grupo === null);
await admin();
for (const n of [3, 4, 5]) {
  await db.exec(`insert into public.participantes (id, cohorte, alias, consentimiento_en, accion_a, accion_con_hueco, franja, dias_comprometidos, plan_en)
    values ('${U(n)}', 'PRUEBA', 'Extra ${n}', now(), 'agua', 'agua', 'comida', 2, now() - interval '30 days')`);
}
await db.exec(`insert into public.registros values ('${U(3)}', public.hoy_cdmx(), 'agua', true)`);
await como(1);
t = await rpc('public.tabla_liga()');
// comprometidos: 4 + 2 + 2 + 2 + 2 = 12; cumplidos: 1 + 1 + 1 = 3 -> 25 %
check('meta colectiva con 5 personas: % del grupo, sin nombres', t.grupo && t.grupo.participantes === 5 && t.grupo.pct === 25, JSON.stringify(t.grupo));

// Historia 10: indicadores agregados sin alias
await falla('la página no puede pedir los indicadores', `select * from public.indicadores('PRUEBA')`, 'permission denied');
await admin();
await db.exec(`update public.participantes set es_equipo = true where id in ('${U(1)}', '${U(2)}')`);
const ind = (await db.query(`select * from public.indicadores('prueba') where semana = date_trunc('week', public.hoy_cdmx()::timestamp)::date order by grupo`)).rows;
check('indicadores: equipo aparte de externos', ind.length === 2 && ind[0].grupo === 'equipo' && ind[1].grupo === 'externos', JSON.stringify(ind));
check('indicadores de la semana: externos 3 personas, 1 con registro, 1 de 6 días = 17 %',
  ind[1].participantes === 3 && ind[1].con_registro === 1 && ind[1].dias_comprometidos === 6 && ind[1].dias_cumplidos === 1 && ind[1].pct_cumplimiento === 17, JSON.stringify(ind[1]));
check('indicadores sin alias', !Object.keys(ind[0]).includes('alias') && !JSON.stringify(ind).includes('Lobo'));
const semanasInd = (await db.query(`select count(distinct semana)::int n from public.indicadores('PRUEBA')`)).rows[0].n;
check('indicadores: un renglón por semana desde el arranque', semanasInd >= 4, 'semanas ' + semanasInd);
await db.exec(`update public.participantes set es_equipo = false`);

// Historia 9: salir y borrar mis datos
await como(5);
await db.exec(`select public.borrar_mis_datos()`);
check('historia 9: tras borrar, ya no tengo alta', (await rpc('public.mi_estado()')).alta === false);
await admin();
const rastro = (await db.query(`select (select count(*) from auth.users where id='${U(5)}')::int u, (select count(*) from public.participantes where id='${U(5)}')::int p`)).rows[0];
check('historia 9: se borra el usuario y su fila', rastro.u === 0 && rastro.p === 0);
await db.exec(`delete from auth.users where id in ('${U(3)}', '${U(4)}'); insert into auth.users values ('${U(3)}')`);

// --- Cupo y cohorte cerrada ---
await admin();
await db.exec(`update public.cohortes set cupo = 2`);
await como(3);
await falla('cohorte llena', `select public.alta('PRUEBA','Tercero', true, false)`, 'cohorte_llena');
await admin();
await db.exec(`update public.cohortes set cupo = 40, abierta = false`);
await como(3);
await falla('cohorte cerrada', `select public.alta('PRUEBA','Tercero', true, false)`, 'codigo_invalido');

// --- Borrado en cascada (lo usará "salir y borrar", iteración 2) ---
await admin();
await db.exec(`delete from auth.users where id='${U(1)}'`);
const quedan = (await db.query(`select count(*)::int n from public.registros where participante_id='${U(1)}'`)).rows[0].n;
check('borrar al usuario borra sus registros', quedan === 0);

console.log(`\n${ok} pruebas pasaron, ${mal} fallaron`);
process.exit(mal ? 1 : 0);
