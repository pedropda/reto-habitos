-- Racha · PROPUESTA, sin aplicar (26-nov-2026)
-- =====================================================================
-- NO es parte de schema.sql y NO se ha corrido en Supabase.
-- El equipo decide si se aplica: cambia el sorteo de la hipótesis 1
-- (Anexo F), así que conviene decidirlo antes de abrir la cohorte real.
--
-- Problema encontrado con uso real (26-nov): al elegir «Salir a caminar»
-- y «Apagar pantallas antes de dormir» con el hueco «Antes de clase»,
-- el sorteo le dio el hueco a «Apagar pantallas antes de dormir».
-- La tarjeta decía «Tu hueco: antes de clase» en una acción que por
-- definición se hace antes de dormir.
--
-- Qué cambia:
--   1. catalogo.momento: texto corto para las acciones que ya traen su
--      propio momento del día («antes de dormir», «al despertar»).
--   2. guardar_plan: el hueco se sortea solo entre las acciones SIN
--      momento propio. Si solo una puede llevarlo, es esa. Si ninguna
--      puede, nadie lleva hueco (accion_con_hueco queda vacío).
--   3. mi_estado: manda «momento» para que la tarjeta diga
--      «Su momento: antes de dormir» en lugar de «Sin hueco fijo».
--
-- Efecto en la medición: quien combine una acción con momento propio y
-- otra sin él ya no entra al sorteo (la asignación deja de ser al azar
-- para esa persona). Hay que excluir esos casos de la comparación de la
-- hipótesis 1 o avisarlo en el Anexo F.
--
-- No toca los planes ya guardados. Es compatible con la página 0.2 y 0.3.
-- Probada en local: pruebas/probar-propuesta-hueco.mjs
-- =====================================================================

alter table public.catalogo add column if not exists momento text;

update public.catalogo set momento = 'antes de dormir' where id = 'pantallas';
update public.catalogo set momento = 'al despertar'    where id = 'levantarse';
-- «Tender tu cama» se deja sin momento propio: el equipo decide si también lo lleva.

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
  v_a_libre boolean;
  v_b_libre boolean;
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

  -- «Libre» = la acción no trae su propio momento del día
  select momento is null into v_a_libre from public.catalogo where id = v_a;
  if v_b is not null then
    select momento is null into v_b_libre from public.catalogo where id = v_b;
  end if;

  update public.participantes set
    accion_a           = v_a,
    accion_b           = v_b,
    accion_con_hueco   = case
      when v_b is null            then case when v_a_libre then v_a end
      when v_a_libre and v_b_libre then case when random() < 0.5 then v_a else v_b end
      when v_a_libre              then v_a
      when v_b_libre              then v_b
    end,
    franja             = p_franja,
    dias_comprometidos = p_dias,
    plan_en            = now()
  where id = v_uid;
end;
$$;


-- Igual que en schema.sql, más el campo «momento» de cada acción
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
                                          'emoji', c.emoji, 'categoria', c.categoria,
                                          'momento', c.momento)
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
