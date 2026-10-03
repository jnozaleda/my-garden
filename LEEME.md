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
| `app/sync.js` | Sincronización: marcas de tiempo por planta/registro, fusión (igual que en el Worker), claves y llamadas a `/garden` |
| `app/calendar.js` | Exporta los riegos y abonados como eventos repetidos `.ics` |
| `app/sw.js` | Service worker: instalación y, en la fase 2, recepción del aviso diario |
| `worker/` | Backend en Cloudflare (`my-garden-api`): ✨ Rellenar con IA. Ver abajo |

## Publicar una versión

Los archivos llevan `?v=AAAAMMDDx` (en `index.html`, en los `import` de `app.js` y en `calendar.js`). Al publicar cambios en `app/`, sube ese número en todos a la vez: así el navegador no mezcla un archivo nuevo con otro viejo de su caché.

## Mejoras que necesitan datos nuevos de la IA

Cada planta guarda `careVersion`. Cuando una mejora necesita datos nuevos (como la pauta por estación), se añade a `UPGRADES` en `app/app.js` con su versión, un texto y una función que rellena solo lo nuevo. Las plantas con versión anterior aparecen en un aviso arriba en Hoy (con «Más tarde», que lo oculta hasta la siguiente mejora), con un punto rojo en la pestaña Ajustes y en la tarjeta «Fichas por actualizar»; al pulsar «Actualizar» la IA completa lo que falta sin tocar lo que puso el usuario.

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
| `POST /identify` | `{ image (JPEG en base64, ~640 px), place }` → `{ isPlant, candidates: [{commonName, species, confidence}] }` (1–3 candidatos). Gemini con visión (solo los modelos Gemini de la cadena `PROVIDER`; Workers AI no); cuenta en la cuota diaria. Sin memoria: cada foto es una consulta |
| `POST /push/subscribe` · `/push/unsubscribe` · `/push/test` | Aviso diario: guarda la suscripción del navegador (endpoint de Apple/Google/Mozilla, clave del jardín, ubicación). Un cron a las 06:00 y 07:00 UTC envía a las 8:00 de Madrid lo que toca hoy (mismas reglas que la app, `app/rules.js`) y los avisos del tiempo, solo si hay algo. Cifrado Web Push y firma VAPID hechos en el Worker (clave privada en el secreto `VAPID_PRIVATE_JWK`) |
| `GET/PUT /garden/:clave` | Sincronización («clave del jardín», 16 caracteres). PUT envía el jardín entero; el Worker lo combina con lo guardado (gana el cambio más reciente por planta y registro, los borrados se guardan como marcas) y devuelve el resultado. Se guarda en KV bajo el hash de la clave. Quien tiene la clave lo lee y edita: así se comparte |
| `POST /event` | `{ device, events: [...] }` (texto plano, sin código) → suma recuentos anónimos al resumen del día (`stats:AAAA-MM-DD` en KV: eventos, dispositivos con hash, uso de la IA). La app los envía en lotes |
| `GET /stats?days=30` | Resúmenes por día para «Uso de la app». **Siempre** exige el código de acceso, aunque la IA esté abierta |
| `POST /calendar` | `{ name, species, lat, lon, place }` → calendario de tareas del año (`tasks`: tipo, título, cómo, meses) y riesgos (`risks`: hongos, caracoles, quemaduras, viento). Se pide aparte y en segundo plano porque tarda más. Memoria propia (`cal:`). Cabecera `X-Access-Code` obligatoria |
| `POST /care` | `{ name, lat, lon, place }` → ficha de cuidados para todo el año: especie, `seasons` (riego y abono por estación), `tips` (un consejo por estación), heladas, notas para todo el año, confianza y `alternatives` (otras plantas que se llaman igual, p. ej. «jazmín» → falso jazmín). Si el nombre no es una planta responde `422 { error: "not_plant" }`. Si llega `month` (versiones antiguas de la app), añade también `waterEvery`/`feedEvery` de esa estación. Cabecera `X-Access-Code` obligatoria |

- **Proveedor de IA:** `PROVIDER` y `MODEL` en `wrangler.toml`. Hoy usa Workers AI (gratis) con `@cf/qwen/qwen3.8-27b`, elegido tras comparar con Gemma 4 y Llama 3.3 70B. Para pasar a Claude, se añade un proveedor en `src/worker.js` y se cambia `PROVIDER`.
- **Protecciones:** solo acepta peticiones desde la web publicada y desde localhost (`ALLOWED_ORIGINS`); código de acceso (secreto `ACCESS_CODE`, copia local en `worker/.access-code`, que no se sube a git) **activable con `REQUIRE_CODE`** (desde el 2026-10-02 está en `off` para compartir la app en familia; la app lo detecta con `GET /health`); tope diario total (`DAILY_LIMIT`) y por conexión (`IP_DAILY_LIMIT`). Volver a `on` antes de pasar a un proveedor de pago.
- **Memoria:** guarda cada respuesta 180 días por planta y zona de ~100 km (vale para todo el año), así que repetir una planta no gasta. No guarda las respuestas de confianza baja.

```bash
cd worker
npm install
npx wrangler deploy                       # publicar
npx wrangler secret put ACCESS_CODE       # cambiar el código de acceso
echo 'ACCESS_CODE=local-test' > .dev.vars && npx wrangler dev --port 8788   # probar en local
```

## Backlog

El backlog vive en GitHub Issues, en el repositorio privado [jnozaleda/mygarden-backlog](https://github.com/jnozaleda/mygarden-backlog/issues) (desde el 2026-10-02). Las ideas que estaban aquí se pasaron a issues (#7–#17).
