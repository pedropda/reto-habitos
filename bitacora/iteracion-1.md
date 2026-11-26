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
- Primera alta real desde un celular (Pedro): alias, micro-acciones y hueco funcionaron con el enlace del equipo. Falta confirmar el registro diario y la tabla.
- Adelanto de la iteración 2: se escribió el código de las historias 7 a 11 y se publicó como **versión 0.2**, antes de invitar a participantes, para no cambiar la página con la prueba en curso. Pruebas en local: 66 comprobaciones de base de datos y 55 de la página.
- Catálogo nuevo de 10 micro-acciones en 4 categorías (borrador, pendiente de la revisión del profesional de la salud) y rediseño de la interfaz: tema oscuro, tarjetas por categoría, un solo toque para marcar, semana y racha arriba. Capturas con datos de prueba: `docs/pantallas-v0.2.png`.

### Jueves 26 de noviembre

- Alta con el enlace del equipo desde Chrome en computadora (Pedro, con apoyo de Claude): alias, dos micro-acciones, hueco «antes de clase» y 5 días por semana. El plan se guardó. Falta confirmar el registro diario y la tabla con uso real; el primer registro es esta noche.
- **Error encontrado con uso real:** con «Salir a caminar» y «Apagar pantallas antes de dormir», el sorteo le dio el hueco «antes de clase» a apagar pantallas. Corrección propuesta y probada en local (11 comprobaciones): `reto-habitos-v0.3/supabase/propuesta-sorteo-hueco.sql`. No está aplicada: decide el equipo, porque cambia el sorteo de la hipótesis 1.
- Se preparó la **versión 0.3** en la carpeta `reto-habitos-v0.3` (fuera del repositorio), con apoyo de Claude: marca **Racha**, logo, ícono en la pestaña del navegador, tema claro y oscuro y ajustes de interfaz. Pruebas en local: 79 comprobaciones de la página y 66 de la base de datos, todas aprobadas. El nombre «Racha» quedó confirmado ese mismo día y los archivos se copiaron al repositorio. Falta el commit y el push: hasta entonces la página pública sigue en la 0.2.
- Tablero de Miro: tarjetas nuevas en el Kanban (error del sorteo, versión 0.3 e idea H25) y dos marcos nuevos, «Fase 3 · Racha: marca y versión 0.3» y «Más adelante · Racha dentro de un asistente de IA».
- Se descargaron las grabaciones y transcripciones de las clases del 23 y del 25 de noviembre. Para el lunes 30 el profesor pidió mostrar lo que ya esté terminado del backlog.

### Viernes 27 de noviembre · punto de control

- ¿El registro diario funciona en celular con el enlace público? _Sí / No._
- Si no: se activa el plan B (Google Forms con hoja de cálculo).

### Sábado 28 de noviembre

- _Por llenar._

### Domingo 29 de noviembre · revisión y retrospectiva

- _Por llenar. Versión 0.1 publicada y sorteo de las ligas._

---

Las capturas usan solo datos de prueba o resultados agregados, nunca alias reales.
