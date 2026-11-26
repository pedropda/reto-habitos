# Bitácora · Iteración 1 (23 al 29 de noviembre de 2026)

**Objetivo de la iteración:** «Entro, elijo mi hueco y registro».

**Historias comprometidas:** 1 a 6.

| Campo | Registro |
|---|---|
| Historias terminadas | _Por llenar el domingo 29._ |
| Quién hizo qué | _Por llenar._ |
| Evidencia (capturas, liga, versión) | _Por llenar: enlace publicado, capturas del tablero Kanban antes y después, capturas de la página con datos de prueba._ |
| Problemas y cómo se resolvieron | _Por llenar._ |
| Qué aprendimos | _Por llenar._ |
| Qué cambia para la siguiente iteración | _Por llenar._ |

## Registro por día

### Miércoles 25 de noviembre

- Se escribió la versión 0.1 del código: base de datos (`supabase/schema.sql`) y página (`index.html`, `css/`, `js/`), con apoyo de una herramienta de inteligencia artificial (Claude).
- Historias cubiertas en código: 1 (alta con alias y consentimiento), 2 (micro-acciones), 3 (hueco y días, con sorteo), 4 (registro sí/no de hoy y ayer), 5 (tabla de la liga por % de la meta propia) y la parte de base de datos de la 6 (reglas de acceso, ligas e interruptor de tabla).
- Pruebas automáticas en local: 44 comprobaciones de la base de datos y 37 de la página en tamaño celular, todas aprobadas. La autenticación de Supabase estuvo simulada.
- Se creó el proyecto de Supabase (plan Free, región us-east-1), se activó el acceso anónimo y se corrió `schema.sql`. Comprobado: 10 acciones en el catálogo, reglas de acceso activas en las 5 tablas y, sin sesión, la API rechaza tablas y funciones.
- Se creó el repositorio público `pedropda/reto-habitos` y se publicó con GitHub Pages: https://pedropda.github.io/reto-habitos/
- La cohorte `PRUEBA` se cerró porque su código está en el repositorio público. El equipo prueba con una cohorte privada cuyo código no se escribe en el repositorio.
- **Falta para cerrar la historia 6:** la primera alta real desde un celular con el enlace del equipo.
- Adelanto de la iteración 2: el código de las historias 7 a 11 quedó escrito y probado en local (66 comprobaciones de base de datos y 52 de la página), **sin publicar**. Se publica como versión 0.2 cuando el equipo lo decida.

### Jueves 26 de noviembre

- _Por llenar._

### Viernes 27 de noviembre · punto de control

- ¿El registro diario funciona en celular con el enlace público? _Sí / No._
- Si no: se activa el plan B (Google Forms con hoja de cálculo).

### Sábado 28 de noviembre

- _Por llenar._

### Domingo 29 de noviembre · revisión y retrospectiva

- _Por llenar. Versión 0.1 publicada y sorteo de las ligas._

---

Las capturas usan solo datos de prueba o resultados agregados, nunca alias reales.
