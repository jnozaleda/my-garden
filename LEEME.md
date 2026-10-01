# 🌿 Mi Jardín

Inventario de plantas de jardín y terraza, registro de cuidados y avisos según el tiempo.
Web instalable en el móvil (PWA), sin compilación: HTML + JS plano, como TempCheck.

Publicada en https://jnozaleda.github.io/my-garden/app/ (GitHub Pages desde la raíz de `main`; el `index.html` de la raíz redirige a `app/`).

## Probar en local

```bash
python3 -m http.server 8767 --directory app
```

Abre http://localhost:8767 (o usa la configuración `mijardin` del panel de previsualización).

## Archivos

| Archivo | Qué hace |
|---|---|
| `app/app.js` | Pantallas (Hoy, Plantas, Ajustes), fichas, formulario y guardado en `localStorage` |
| `app/rules.js` | Reglas puras: estación actual (meteorológica, invertida en el hemisferio sur), próximo riego/abonado con el intervalo de esa estación y cómo lo cambia el tiempo (lluvia, calor, helada, viento). Umbrales en `LIMITS` |
| `app/weather.js` | Previsión de Open-Meteo (sin clave), con los 2 días anteriores para saber si llovió ayer |
| `app/calendar.js` | Exporta los riegos y abonados como eventos repetidos `.ics` |
| `app/sw.js` | Service worker: instalación y, en la fase 2, recepción del aviso diario |
| `worker/` | Backend en Cloudflare (`my-garden-api`): ✨ Rellenar con IA. Ver abajo |

## Publicar una versión

Los archivos llevan `?v=AAAAMMDDx` (en `index.html`, en los `import` de `app.js` y en `calendar.js`). Al publicar cambios en `app/`, sube ese número en todos a la vez: así el navegador no mezcla un archivo nuevo con otro viejo de su caché.

## Mejoras que necesitan datos nuevos de la IA

Cada planta guarda `careVersion`. Cuando una mejora necesita datos nuevos (como la pauta por estación), se añade a `UPGRADES` en `app/app.js` con su versión, un texto y una función que rellena solo lo nuevo. Las plantas con versión anterior aparecen en Ajustes → «Fichas por actualizar», y al pulsar «✨ Actualizar fichas» la IA completa lo que falta sin tocar lo que puso el usuario.

## Fases

1. ✅ Inventario, registro de cuidados, previsión, avisos en la app, exportar al calendario, copia de seguridad.
2. ✅ (adelantado) Rellenar con IA desde el nombre de la planta.
3. Aviso diario push a las 8:00 (reutilizando el Worker de Cloudflare y la GitHub Action de TempCheck) y calendario por suscripción (webcal) que se actualiza solo.
4. Identificación por foto (Pl@ntNet + Claude para la ficha de cuidados) y chat con el contexto del jardín.
5. Diagnóstico de plagas por foto y calendario de temporada. Opcional: sensores de humedad de PlantPulse.

## Backend: `worker/` (my-garden-api)

Cloudflare Worker en https://my-garden-api.tempcheck-app.workers.dev

| Ruta | Qué hace |
|---|---|
| `GET /health` | Comprobación |
| `POST /care` | `{ name, lat, lon, place }` → ficha de cuidados para todo el año: especie, `seasons` (riego y abono por estación), heladas, notas y confianza. Si llega `month` (versiones antiguas de la app), añade también `waterEvery`/`feedEvery` de esa estación. Cabecera `X-Access-Code` obligatoria |

- **Proveedor de IA:** `PROVIDER` y `MODEL` en `wrangler.toml`. Hoy usa Workers AI (gratis) con `@cf/qwen/qwen3.8-27b`, elegido tras comparar con Gemma 4 y Llama 3.3 70B. Para pasar a Claude, se añade un proveedor en `src/worker.js` y se cambia `PROVIDER`.
- **Protecciones:** solo acepta peticiones desde la web publicada y desde localhost (`ALLOWED_ORIGINS`), exige el código de acceso (secreto `ACCESS_CODE`, copia local en `worker/.access-code`, que no se sube a git), y tiene un tope de `DAILY_LIMIT` llamadas al día.
- **Memoria:** guarda cada respuesta 180 días por planta y zona de ~100 km (vale para todo el año), así que repetir una planta no gasta. No guarda las respuestas de confianza baja.

```bash
cd worker
npm install
npx wrangler deploy                       # publicar
npx wrangler secret put ACCESS_CODE       # cambiar el código de acceso
echo 'ACCESS_CODE=local-test' > .dev.vars && npx wrangler dev --port 8788   # probar en local
```

## Backlog (ideas aparcadas)

- **Separar «Nombre» y «Tipo de planta» en el formulario.** El nombre es libre («Olivo del patio»); el tipo («olivo») es lo que se consulta a la IA y la clave de la memoria compartida del Worker. Así se aprovecha mejor la memoria y las respuestas son más precisas. Idea: autocompletar el tipo con las plantas que ya están en memoria. Aparcado el 2026-09-29: primero, pruebas de uso.
- **Los días de riego de la IA suponen maceta.** Las notas ya son neutras (2026-10-01), pero los intervalos se piden para maceta mediana; en suelo suelen bastar riegos más espaciados. Opciones: pedir también la pauta para suelo, o alargar los intervalos al elegir «Suelo». Detectado el 2026-09-29.
- **Unificar emojis e iconos.** Los controles (pestañas, interruptores, heladas) usan iconos de línea que toman el color del estado; el contenido (previsión, tareas, fichas sin foto, avisos) sigue con emojis. Si se quiere un estilo único, pasar también el contenido a iconos. Apuntado el 2026-10-01.
- **Ajustar el riego cuando el tiempo se sale de lo normal.** La pauta por estación supone un año normal; la capa del tiempo solo reacciona a lluvia (≥5 mm) y calor fuerte (≥32°). Un abril seco y caluroso (25°, semanas sin llover) no adelanta el riego. Idea: comparar temperatura y lluvia recientes y previstas con lo normal para la fecha (como hace TempCheck) y acortar o alargar el intervalo. Apuntado el 2026-10-01.
- **Datos reales del clima local para la IA.** Hoy la IA usa lo que «sabe» del clima de cada lugar; las diferencias entre zonas (p. ej. Bilbao frente a Madrid) salen pequeñas. Idea: enviarle las temperaturas y lluvias normales de la zona por estación. Apuntado el 2026-10-01.
