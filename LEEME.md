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
| `app/rules.js` | Reglas puras: próximo riego/abonado y cómo lo cambia el tiempo (lluvia, calor, helada, viento). Umbrales en `LIMITS` |
| `app/weather.js` | Previsión de Open-Meteo (sin clave), con los 2 días anteriores para saber si llovió ayer |
| `app/calendar.js` | Exporta los riegos y abonados como eventos repetidos `.ics` |
| `app/sw.js` | Service worker: instalación y, en la fase 2, recepción del aviso diario |
| `worker/` | Backend en Cloudflare (`my-garden-api`): ✨ Rellenar con IA. Ver abajo |

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
| `POST /care` | `{ name, lat, lon, month, place }` → ficha de cuidados (especie, riego, abono, heladas, notas, confianza). Cabecera `X-Access-Code` obligatoria |

- **Proveedor de IA:** `PROVIDER` y `MODEL` en `wrangler.toml`. Hoy usa Workers AI (gratis) con `@cf/qwen/qwen3.8-27b`, elegido tras comparar con Gemma 4 y Llama 3.3 70B. Para pasar a Claude, se añade un proveedor en `src/worker.js` y se cambia `PROVIDER`.
- **Protecciones:** solo acepta peticiones desde la web publicada y desde localhost (`ALLOWED_ORIGINS`), exige el código de acceso (secreto `ACCESS_CODE`, copia local en `worker/.access-code`, que no se sube a git), y tiene un tope de `DAILY_LIMIT` llamadas al día.
- **Memoria:** guarda cada respuesta 90 días por planta, zona de ~100 km y estación, así que repetir una planta no gasta. No guarda las respuestas de confianza baja.

```bash
cd worker
npm install
npx wrangler deploy                       # publicar
npx wrangler secret put ACCESS_CODE       # cambiar el código de acceso
echo 'ACCESS_CODE=local-test' > .dev.vars && npx wrangler dev --port 8788   # probar en local
```
