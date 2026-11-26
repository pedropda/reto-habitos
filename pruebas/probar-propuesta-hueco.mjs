// Prueba de la PROPUESTA supabase/propuesta-sorteo-hueco.sql (no aplicada en Supabase).
// Corre schema.sql + la propuesta en un Postgres local y revisa el sorteo nuevo.
// Uso: node probar-propuesta-hueco.mjs ../supabase/schema.sql ../supabase/propuesta-sorteo-hueco.sql
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const schema = readFileSync(process.argv[2], 'utf8');
const propuesta = readFileSync(process.argv[3], 'utf8');
const db = new PGlite();
let ok = 0, mal = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log('  ok  ', nombre); } else { mal++; console.log('  FALLA', nombre, extra); }
};

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
await db.exec(propuesta);
await db.exec(propuesta);
check('la propuesta corre dos veces sin error sobre schema.sql', true);
await db.exec(`update public.cohortes set cupo = 1000 where codigo = 'PRUEBA'`).catch(() => {});

let n = 0;
// Da de alta a una persona nueva, guarda su plan y devuelve su estado
async function persona(acciones, franja = 'antes_clase') {
  const id = randomUUID();
  await db.exec(`reset role; set test.uid = '';`);
  await db.exec(`insert into auth.users values ('${id}')`);
  await db.exec(`set test.uid = '${id}'; set role authenticated;`);
  await db.exec(`select public.alta('PRUEBA', 'Persona${++n}', true, false)`);
  await db.query(`select public.guardar_plan($1::text[], $2, 5)`, [acciones, franja]);
  const r = (await db.query(`select public.mi_estado() as r`)).rows[0].r;
  await db.exec(`reset role; set test.uid = '';`);
  return r;
}
const cuenta = async (acciones, veces) => {
  const c = {};
  for (let i = 0; i < veces; i++) { const e = await persona(acciones); c[e.accion_con_hueco] = (c[e.accion_con_hueco] || 0) + 1; }
  return c;
};

// El caso que se encontró con uso real
let c = await cuenta(['caminar', 'pantallas'], 40);
check('caminar + «apagar pantallas antes de dormir»: el hueco siempre va a caminar (40 de 40)', c.caminar === 40, JSON.stringify(c));
c = await cuenta(['pantallas', 'caminar'], 40);
check('igual si se eligen en el otro orden (40 de 40)', c.caminar === 40, JSON.stringify(c));
c = await cuenta(['levantarse', 'agua'], 20);
check('«levantarte a tu hora» tampoco se lleva el hueco (20 de 20 van al agua)', c.agua === 20, JSON.stringify(c));

// Dos acciones libres: el sorteo sigue siendo al azar
c = await cuenta(['caminar', 'agua'], 80);
check('dos acciones sin momento propio: se sigue sorteando (las dos salen, ninguna menos de 20 de 80)',
  (c.caminar || 0) >= 20 && (c.agua || 0) >= 20 && (c.caminar || 0) + (c.agua || 0) === 80, JSON.stringify(c));

// Ninguna puede llevar hueco
let e = await persona(['pantallas', 'levantarse']);
check('dos acciones con momento propio: nadie lleva hueco', e.accion_con_hueco === null, JSON.stringify(e.accion_con_hueco));
e = await persona(['pantallas']);
check('una sola acción con momento propio: sin hueco', e.accion_con_hueco === null);
e = await persona(['caminar']);
check('una sola acción libre: lleva hueco, como antes', e.accion_con_hueco === 'caminar');

// Lo que recibe la página
e = await persona(['caminar', 'pantallas']);
const pant = e.acciones.find(a => a.id === 'pantallas'), cam = e.acciones.find(a => a.id === 'caminar');
check('mi_estado manda el momento de cada acción', pant.momento === 'antes de dormir' && cam.momento === null, JSON.stringify(e.acciones));
check('la acción con hueco sigue yendo primero', e.acciones[0].id === 'caminar');
check('el plan sigue guardándose una sola vez', await (async () => {
  const id = (await db.query(`select id from public.participantes order by plan_en desc limit 1`)).rows[0].id;
  await db.exec(`set test.uid = '${id}'; set role authenticated;`);
  try { await db.query(`select public.guardar_plan(array['agua'], 'comida', 3)`); return false; }
  catch (err) { return err.message.includes('plan_ya_guardado'); }
  finally { await db.exec(`reset role; set test.uid = '';`); }
})());

console.log(`\n${ok} pruebas pasaron, ${mal} fallaron`);
process.exit(mal ? 1 : 0);
