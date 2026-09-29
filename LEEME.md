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

## Fases

1. ✅ Inventario, registro de cuidados, previsión, avisos en la app, exportar al calendario, copia de seguridad.
2. Aviso diario push a las 8:00 (reutilizando el Worker de Cloudflare y la GitHub Action de TempCheck) y calendario por suscripción (webcal) que se actualiza solo.
3. Identificación por foto (Pl@ntNet + Claude para la ficha de cuidados) y chat con el contexto del jardín.
4. Diagnóstico de plagas por foto y calendario de temporada. Opcional: sensores de humedad de PlantPulse.
