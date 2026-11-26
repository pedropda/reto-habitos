-- =====================================================================
-- Reto de hábitos · base de datos (Supabase / Postgres)
-- Versión 0.2 · iteraciones 1 y 2 (historias 1 a 11)
--
-- Cómo usarlo: Supabase > SQL Editor > pegar TODO este archivo > Run.
-- Se puede correr varias veces sin romper nada.
--
-- Reglas del diseño (Anexo E de la Fase 2, dato mínimo):
--   * No se guarda nombre, correo ni teléfono. Solo alias.
--   * Cada participante solo lee SUS filas (RLS).
--   * Nadie escribe directo en las tablas: todo pasa por las funciones
--     de abajo, que validan las reglas (solo hoy y ayer, hora de CDMX...).
--   * La tabla de la liga nunca dice qué acción hizo cada quien.
-- =====================================================================

-- ---------- Tablas ---------------------------------------------------

-- Cohorte = un grupo invitado con un mismo enlace (?c=CODIGO)
create table if not exists public.cohortes (
  codigo      text primary key,
  nombre      text not null,
  abierta     boolean not null default true,   -- false = ya no acepta altas
  cupo        int not null default 40,
  creado_en   timestamptz not null default now()
);

-- Liga = 3 o 4 personas de una cohorte. El equipo las sortea a mano.
create table if not exists public.ligas (
  id               bigint generated always as identity primary key,
  cohorte          text not null references public.cohortes(codigo),
  nombre           text not null,
  tabla_encendida  boolean not null default false,  -- interruptor de la tabla (historia 6)
  creado_en        timestamptz not null default now()
);

-- Catálogo de micro-acciones (5 a 15 minutos). Sin texto libre.
create table if not exists public.catalogo (
  id         text primary key,
  categoria  text not null,
  nombre     text not null,
  minutos    int  check (minutos between 5 and 15),  -- vacío = no tiene duración fija
  emoji      text,
  orden      int  not null default 0,
  activa     boolean not null default true
);
-- Ajustes para bases creadas con la versión 0.1
alter table public.catalogo add column if not exists emoji text;
alter table public.catalogo alter column minutos drop not null;
alter table public.catalogo drop constraint if exists catalogo_categoria_check;
alter table public.catalogo add constraint catalogo_categoria_check
  check (categoria in ('movimiento', 'sueno', 'alimentacion', 'bienestar'));

create table if not exists public.participantes (
  id                  uuid primary key references auth.users(id) on delete cascade,
  cohorte             text not null references public.cohortes(codigo),
  alias               text not null,
  liga_id             bigint references public.ligas(id) on delete set null,
  consentimiento_en   timestamptz not null,           -- fecha y hora de la aceptación
  aparece_en_tabla    boolean not null default false, -- casilla opcional
  es_equipo           boolean not null default false, -- el equipo se reporta aparte
  accion_a            text references public.catalogo(id),
  accion_b            text references public.catalogo(id),
  accion_con_hueco    text references public.catalogo(id), -- resultado del sorteo
  franja              text check (franja in ('antes_trabajo', 'comida', 'antes_clase', 'llegar_casa')),
  dias_comprometidos  int  check (dias_comprometidos between 1 and 7),
  plan_en             timestamptz,
  creado_en           timestamptz not null default now()
);

-- Un alias no se repite dentro de la misma cohorte (sin importar mayúsculas)
create unique index if not exists participantes_alias_unico
  on public.participantes (cohorte, lower(alias));

-- Un renglón por persona, día y acción: cumplió sí o no
create table if not exists public.registros (
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  fecha            date not null,
  accion_id        text not null references public.catalogo(id),
  cumplio          boolean not null,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now(),
  primary key (participante_id, fecha, accion_id)
);

-- ---------- Reglas de acceso (RLS) -----------------------------------

alter table public.cohortes      enable row level security;
alter table public.ligas         enable row level security;
alter table public.catalogo      enable row level security;
alter table public.participantes enable row level security;
alter table public.registros     enable row level security;

-- Permisos de tabla: solo lectura, solo para quien ya entró (rol authenticated).
-- cohortes y ligas no se exponen: se consultan únicamente dentro de las funciones.
revoke all on public.cohortes, public.ligas, public.catalogo,
              public.participantes, public.registros from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.catalogo, public.participantes, public.registros to authenticated;

drop policy if exists catalogo_leer on public.catalogo;
create policy catalogo_leer on public.catalogo
  for select to authenticated using (activa);

drop policy if exists participantes_leer_propio on public.participantes;
create policy participantes_leer_propio on public.participantes
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists registros_leer_propios on public.registros;
create policy registros_leer_propios on public.registros
  for select to authenticated using (participante_id = (select auth.uid()));

-- No hay políticas de insert/update/delete: nadie escribe directo.

-- ---------- Funciones ------------------------------------------------

-- El día se calcula con la hora de la Ciudad de México (historia 4)
create or replace function public.hoy_cdmx()
returns date
language sql stable
set search_path = ''
as $$
  select (now() at time zone 'America/Mexico_City')::date;
$$;

-- Días cumplidos de una persona en la semana que empieza en p_lunes.
-- DECISIÓN POR CONFIRMAR CON EL EQUIPO: un día cuenta como cumplido si la
-- persona marcó "sí" en AL MENOS UNA de sus acciones. Para exigir todas,
-- se cambia solo esta función.
create or replace function public.dias_cumplidos(p_participante uuid, p_lunes date)
returns int
language sql stable
set search_path = ''
as $$
  select count(distinct r.fecha)::int
  from public.registros r
  where r.participante_id = p_participante
    and r.cumplio
    and r.fecha between p_lunes and p_lunes + 6;
$$;

-- % de la meta propia: días cumplidos entre días comprometidos, tope 100
create or replace function public.pct_meta(p_cumplidos int, p_comprometidos int)
returns int
language sql immutable
set search_path = ''
as $$
  select case
    when coalesce(p_comprometidos, 0) = 0 then 0
    else least(100, round(100.0 * p_cumplidos / p_comprometidos))::int
  end;
$$;

-- Historia 8: racha = días cumplidos seguidos, contando hacia atrás desde hoy
-- (o desde ayer, si hoy todavía no hay un "sí"). Un día fallado por semana
-- (lunes a domingo) no rompe la racha: es el comodín. El día del comodín no suma.
create or replace function public.racha(p_participante uuid)
returns int
language plpgsql stable
set search_path = ''
as $$
declare
  v_hoy     date := public.hoy_cdmx();
  v_inicio  date;
  v_dias    date[];
  v_d       date;
  v_racha   int := 0;
  v_comodin date;   -- lunes de la última semana en la que ya se usó el comodín
  v_sem     date;
begin
  select (plan_en at time zone 'America/Mexico_City')::date into v_inicio
  from public.participantes where id = p_participante;
  if v_inicio is null then
    return 0;
  end if;

  select coalesce(array_agg(distinct fecha), '{}') into v_dias
  from public.registros where participante_id = p_participante and cumplio;

  v_d := v_hoy;
  if not (v_d = any (v_dias)) then
    v_d := v_d - 1;   -- hoy sigue abierto: todavía no cuenta como falla
  end if;

  -- v_inicio - 1: el día del alta también se puede registrar "ayer"
  while v_d >= v_inicio - 1 loop
    if v_d = any (v_dias) then
      v_racha := v_racha + 1;
    else
      v_sem := date_trunc('week', v_d::timestamp)::date;
      if v_comodin is not distinct from v_sem then
        exit;
      end if;
      v_comodin := v_sem;
    end if;
    v_d := v_d - 1;
  end loop;

  return v_racha;
end;
$$;

-- Historia 1: alta con alias y consentimiento
create or replace function public.alta(
  p_codigo  text,
  p_alias   text,
  p_acepta  boolean,
  p_aparece boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_alias   text := btrim(regexp_replace(coalesce(p_alias, ''), '\s+', ' ', 'g'));
  v_cohorte public.cohortes;
  v_total   int;
begin
  if v_uid is null then
    raise exception 'sin_sesion';
  end if;
  if exists (select 1 from public.participantes where id = v_uid) then
    raise exception 'ya_tiene_alta';
  end if;
  if p_acepta is not true then
    raise exception 'falta_consentimiento';
  end if;

  select * into v_cohorte from public.cohortes where codigo = upper(btrim(coalesce(p_codigo, '')));
  if not found or not v_cohorte.abierta then
    raise exception 'codigo_invalido';
  end if;

  -- 3 a 20 caracteres: letras, números, espacio, guion y guion bajo
  if v_alias !~ '^[[:alnum:]_ -]{3,20}$' then
    raise exception 'alias_invalido';
  end if;
  if exists (select 1 from public.participantes
             where cohorte = v_cohorte.codigo and lower(alias) = lower(v_alias)) then
    raise exception 'alias_ocupado';
  end if;

  select count(*) into v_total from public.participantes where cohorte = v_cohorte.codigo;
  if v_total >= v_cohorte.cupo then
    raise exception 'cohorte_llena';
  end if;

  insert into public.participantes (id, cohorte, alias, consentimiento_en, aparece_en_tabla)
  values (v_uid, v_cohorte.codigo, v_alias, now(), coalesce(p_aparece, false));
exception
  when unique_violation then
    raise exception 'alias_ocupado';
end;
$$;

-- Historias 2 y 3: 1 o 2 micro-acciones, franja y días comprometidos.
-- Si eligió 2, aquí se sortea cuál lleva hueco (hipótesis 1).
-- El plan se guarda una sola vez; después solo se puede mover la franja.
create or replace function public.guardar_plan(
  p_acciones text[],
  p_franja   text,
  p_dias     int
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.participantes;
  v_n   int := coalesce(array_length(p_acciones, 1), 0);
  v_a   text;
  v_b   text;
begin
  select * into v_p from public.participantes where id = v_uid;
  if not found then
    raise exception 'sin_alta';
  end if;
  if v_p.plan_en is not null then
    raise exception 'plan_ya_guardado';
  end if;
  if v_n not in (1, 2) then
    raise exception 'acciones_invalidas';
  end if;

  v_a := p_acciones[1];
  v_b := case when v_n = 2 then p_acciones[2] end;
  if v_a = v_b then
    raise exception 'acciones_invalidas';
  end if;
  if (select count(*) from public.catalogo
      where activa and id in (v_a, coalesce(v_b, v_a))) <> v_n then
    raise exception 'acciones_invalidas';
  end if;
  if p_franja is null or p_franja not in ('antes_trabajo', 'comida', 'antes_clase', 'llegar_casa') then
    raise exception 'franja_invalida';
  end if;
  if p_dias is null or p_dias not between 1 and 7 then
    raise exception 'dias_invalidos';
  end if;

  update public.participantes set
    accion_a           = v_a,
    accion_b           = v_b,
    accion_con_hueco   = case when v_b is null or random() < 0.5 then v_a else v_b end,
    franja             = p_franja,
    dias_comprometidos = p_dias,
    plan_en            = now()
  where id = v_uid;
end;
$$;

-- Historia 3: mover la franja cuando haga falta
create or replace function public.cambiar_franja(p_franja text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_franja is null or p_franja not in ('antes_trabajo', 'comida', 'antes_clase', 'llegar_casa') then
    raise exception 'franja_invalida';
  end if;
  update public.participantes set franja = p_franja
  where id = auth.uid() and plan_en is not null;
  if not found then
    raise exception 'sin_plan';
  end if;
end;
$$;

-- Historia 4: marcar sí o no. Solo hoy y ayer; la fecha la pone el servidor.
create or replace function public.registrar(
  p_accion  text,
  p_cumplio boolean,
  p_ayer    boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_p     public.participantes;
  v_fecha date := public.hoy_cdmx() - case when p_ayer then 1 else 0 end;
begin
  select * into v_p from public.participantes where id = v_uid;
  if not found or v_p.plan_en is null then
    raise exception 'sin_plan';
  end if;
  if p_cumplio is null or p_accion is null
     or p_accion not in (v_p.accion_a, coalesce(v_p.accion_b, v_p.accion_a)) then
    raise exception 'accion_invalida';
  end if;

  insert into public.registros (participante_id, fecha, accion_id, cumplio)
  values (v_uid, v_fecha, p_accion, p_cumplio)
  on conflict (participante_id, fecha, accion_id)
  do update set cumplio = excluded.cumplio, actualizado_en = now();
end;
$$;

-- Todo lo que la pantalla "Hoy" necesita, en una sola llamada
create or replace function public.mi_estado()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_p     public.participantes;
  v_hoy   date := public.hoy_cdmx();
  v_lunes date := date_trunc('week', public.hoy_cdmx()::timestamp)::date;
  v_cum   int;
begin
  select * into v_p from public.participantes where id = v_uid;
  if not found then
    return jsonb_build_object('alta', false);
  end if;

  v_cum := public.dias_cumplidos(v_uid, v_lunes);

  return jsonb_build_object(
    'alta', true,
    'alias', v_p.alias,
    'tiene_plan', v_p.plan_en is not null,
    'aparece_en_tabla', v_p.aparece_en_tabla,
    'franja', v_p.franja,
    'dias_comprometidos', v_p.dias_comprometidos,
    'accion_con_hueco', v_p.accion_con_hueco,
    'acciones', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre, 'minutos', c.minutos,
                                          'emoji', c.emoji, 'categoria', c.categoria)
                       order by (c.id = v_p.accion_con_hueco) desc, c.orden)
      from public.catalogo c
      where c.id in (v_p.accion_a, v_p.accion_b)
    ), '[]'::jsonb),
    'hoy', v_hoy,
    'ayer', v_hoy - 1,
    'lunes', v_lunes,
    'registros', coalesce((
      select jsonb_agg(jsonb_build_object('fecha', r.fecha, 'accion', r.accion_id, 'cumplio', r.cumplio))
      from public.registros r
      where r.participante_id = v_uid and r.fecha in (v_hoy, v_hoy - 1)
    ), '[]'::jsonb),
    'dias_cumplidos_semana', v_cum,
    'pct_semana', public.pct_meta(v_cum, v_p.dias_comprometidos),
    -- Historia 8: mi semana (lunes a domingo) y mi racha
    'racha', public.racha(v_uid),
    'semana', (
      select jsonb_agg(jsonb_build_object(
        'fecha', d.dia,
        'estado', case
          when d.dia > v_hoy then 'futuro'
          when exists (select 1 from public.registros r
                       where r.participante_id = v_uid and r.fecha = d.dia and r.cumplio) then 'si'
          when d.dia = v_hoy and not exists (select 1 from public.registros r
                       where r.participante_id = v_uid and r.fecha = d.dia) then 'pendiente'
          when v_p.plan_en is null
               or d.dia < (v_p.plan_en at time zone 'America/Mexico_City')::date - 1 then 'antes'
          else 'no'
        end) order by d.dia)
      from (select (v_lunes + n) as dia from generate_series(0, 6) n) d
    )
  );
end;
$$;

-- Historia 5: tabla semanal de mi liga. Solo alias y % de la meta propia,
-- solo de quien aceptó aparecer. Se reinicia sola cada lunes (hora de CDMX).
create or replace function public.tabla_liga()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_p     public.participantes;
  v_liga  public.ligas;
  v_lunes date := date_trunc('week', public.hoy_cdmx()::timestamp)::date;
  v_filas jsonb;
  v_grupo jsonb;
begin
  select * into v_p from public.participantes where id = v_uid;
  if not found then
    raise exception 'sin_alta';
  end if;
  if v_p.liga_id is null then
    return jsonb_build_object('estado', 'sin_liga');
  end if;

  select * into v_liga from public.ligas where id = v_p.liga_id;
  if not v_liga.tabla_encendida then
    return jsonb_build_object('estado', 'apagada', 'liga', v_liga.nombre);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('alias', t.alias, 'pct', t.pct, 'dias', t.dias,
                                               'racha', t.racha, 'soy_yo', t.soy_yo)
                            order by t.pct desc, lower(t.alias)), '[]'::jsonb)
  into v_filas
  from (
    select p.alias,
           public.dias_cumplidos(p.id, v_lunes) as dias,
           public.pct_meta(public.dias_cumplidos(p.id, v_lunes), p.dias_comprometidos) as pct,
           public.racha(p.id) as racha,
           p.id = v_uid as soy_yo
    from public.participantes p
    where p.liga_id = v_liga.id
      and p.aparece_en_tabla
      and p.plan_en is not null
  ) t;

  -- Historia 11: meta colectiva. Se calcula sobre toda la cohorte (no sobre la
  -- liga) y solo con 5 personas o más, para que nadie pueda deducir el avance
  -- de quien eligió no aparecer. No hay lista de últimos lugares.
  select case when count(*) >= 5 then jsonb_build_object(
           'participantes', count(*),
           'pct', public.pct_meta(sum(least(g.dias, g.meta))::int, sum(g.meta)::int))
         end
  into v_grupo
  from (
    select public.dias_cumplidos(p.id, v_lunes) as dias, p.dias_comprometidos as meta
    from public.participantes p
    where p.cohorte = v_p.cohorte and p.plan_en is not null
  ) g;

  return jsonb_build_object(
    'estado', 'encendida',
    'liga', v_liga.nombre,
    'lunes', v_lunes,
    'yo_aparezco', v_p.aparece_en_tabla,
    'filas', v_filas,
    'grupo', v_grupo
  );
end;
$$;

-- Historia 7: cambiar después la decisión de aparecer en la tabla
create or replace function public.cambiar_aparece(p_aparece boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_aparece is null then
    raise exception 'valor_invalido';
  end if;
  update public.participantes set aparece_en_tabla = p_aparece where id = auth.uid();
  if not found then
    raise exception 'sin_alta';
  end if;
end;
$$;

-- Historia 9: salir y borrar mis datos. Borra al usuario; su alias, su plan y
-- sus registros se van en cascada. No se puede deshacer.
create or replace function public.borrar_mis_datos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'sin_sesion';
  end if;
  delete from auth.users where id = v_uid;
end;
$$;

-- Historia 10: indicadores agregados por semana, SIN alias. No se expone a la
-- página: el equipo la corre en el SQL Editor y exporta el resultado.
--   select * from public.indicadores('CODIGO-DE-LA-COHORTE');
-- El equipo (es_equipo) sale en un renglón aparte y no cuenta en los indicadores.
create or replace function public.indicadores(p_cohorte text)
returns table (
  semana              date,
  grupo               text,
  participantes       int,
  con_registro        int,
  dias_comprometidos  int,
  dias_cumplidos      int,
  pct_cumplimiento    int,
  aceptan_aparecer    int
)
language sql stable
set search_path = ''
as $$
  with semanas as (
    select generate_series(
      (select date_trunc('week', min(plan_en at time zone 'America/Mexico_City'))
       from public.participantes
       where cohorte = upper(btrim(p_cohorte)) and plan_en is not null),
      date_trunc('week', public.hoy_cdmx()::timestamp),
      interval '7 days')::date as lunes
  ), base as (
    select s.lunes, p.es_equipo, p.dias_comprometidos as meta, p.aparece_en_tabla,
           public.dias_cumplidos(p.id, s.lunes) as dias,
           exists (select 1 from public.registros r
                   where r.participante_id = p.id and r.fecha between s.lunes and s.lunes + 6) as con_registro
    from semanas s
    join public.participantes p
      on p.cohorte = upper(btrim(p_cohorte))
     and p.plan_en is not null
     and (p.plan_en at time zone 'America/Mexico_City')::date <= s.lunes + 6
  )
  select lunes,
         case when es_equipo then 'equipo' else 'externos' end,
         count(*)::int,
         (count(*) filter (where con_registro))::int,
         sum(meta)::int,
         sum(least(dias, meta))::int,
         public.pct_meta(sum(least(dias, meta))::int, sum(meta)::int),
         (count(*) filter (where aparece_en_tabla))::int
  from base
  group by lunes, es_equipo
  order by lunes, 2;
$$;

-- Permisos de las funciones: solo quien ya entró puede llamarlas
revoke execute on function
  public.hoy_cdmx(),
  public.dias_cumplidos(uuid, date),
  public.pct_meta(int, int),
  public.alta(text, text, boolean, boolean),
  public.guardar_plan(text[], text, int),
  public.cambiar_franja(text),
  public.registrar(text, boolean, boolean),
  public.mi_estado(),
  public.tabla_liga(),
  public.racha(uuid),
  public.cambiar_aparece(boolean),
  public.borrar_mis_datos(),
  public.indicadores(text)
from public, anon, authenticated;

grant execute on function
  public.alta(text, text, boolean, boolean),
  public.guardar_plan(text[], text, int),
  public.cambiar_franja(text),
  public.registrar(text, boolean, boolean),
  public.mi_estado(),
  public.tabla_liga(),
  public.cambiar_aparece(boolean),
  public.borrar_mis_datos()
to authenticated;

-- ---------- Datos iniciales ------------------------------------------

-- Catálogo (versión 2, 25-nov-2026): acciones básicas del día, con nombre corto.
-- BORRADOR: falta la revisión del profesional de la salud aliado.
insert into public.catalogo (id, categoria, nombre, minutos, emoji, orden) values
  ('caminar',     'movimiento',   'Salir a caminar',                               15,   '🚶', 1),
  ('estirar',     'movimiento',   'Estirarte',                                      5,   '🧘', 2),
  ('fuerza',      'movimiento',   'Ejercicio corto sin equipo',                    10,   '💪', 3),
  ('levantarse',  'sueno',        'Levantarte a tu hora, sin posponer la alarma',  null, '⏰', 4),
  ('tender_cama', 'sueno',        'Tender tu cama',                                 5,   '🛏️', 5),
  ('pantallas',   'sueno',        'Apagar pantallas antes de dormir',              15,   '📵', 6),
  ('agua',        'alimentacion', 'Tomar 2 vasos de agua',                          5,   '💧', 7),
  ('fruta',       'alimentacion', 'Comer una fruta o verdura',                     10,   '🍎', 8),
  ('disfrutar',   'bienestar',    'Hacer algo que disfruto',                       15,   '🎵', 9),
  ('respirar',    'bienestar',    'Respirar con calma',                             5,   '🌬️', 10)
on conflict (id) do update set
  categoria = excluded.categoria, nombre = excluded.nombre, minutos = excluded.minutos,
  emoji = excluded.emoji, orden = excluded.orden, activa = true;

-- Las acciones que ya no están en el catálogo se apagan (no se borran,
-- por si alguien ya las había elegido).
update public.catalogo set activa = false
where id not in ('caminar', 'estirar', 'fuerza', 'levantarse', 'tender_cama',
                 'pantallas', 'agua', 'fruta', 'disfrutar', 'respirar');

-- Cohorte de PRUEBA para el equipo. El enlace queda: .../?c=PRUEBA
-- La cohorte real se crea antes del domingo 29 con un código difícil de adivinar.
insert into public.cohortes (codigo, nombre) values ('PRUEBA', 'Prueba interna del equipo')
on conflict (codigo) do nothing;

insert into public.ligas (cohorte, nombre)
select 'PRUEBA', 'Liga de prueba'
where not exists (select 1 from public.ligas where cohorte = 'PRUEBA');
