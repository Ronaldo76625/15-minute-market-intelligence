# Kalshi 15-Minute Monitor

Panel local para generar predicciones probabilísticas experimentales sobre siete contratos activos de criptomonedas de 15 minutos en Kalshi.

Versión pública: [15-minute-market-intelligence.deposadaplazaronaldo.workers.dev](https://15-minute-market-intelligence.deposadaplazaronaldo.workers.dev)

## Estado de esta copia

- Usa la API REST pública oficial de Kalshi; no requiere clave para leer datos de mercado.
- Consulta las series de 15 minutos para BTC, ETH, SOL, XRP, DOGE, BNB y HYPE.
- Selecciona inglés o español y modo claro u oscuro según el dispositivo en la primera visita; ambos pueden cambiarse manualmente.
- Muestra precios como decimales de dólar internamente (`0.41`) y como centavos en pantalla (`41.0¢`).
- La gráfica usa velas públicas de un minuto del contrato activo de 15 minutos.
- Puede cargar hasta 1,000 mercados resueltos por moneda y entrena un conjunto logístico con precio, momentum de varios horizontes, spread, volumen reciente, volatilidad, rango, interés abierto, hora y activo.
- Separa cronológicamente el historial en 70% para entrenamiento, 15% para calibración y 15% para una evaluación final que nunca interviene en los ajustes.
- Calibra las probabilidades, las compara con el precio de Kalshi y vuelve automáticamente a esa referencia cuando las variables adicionales no demuestran una mejora estable.
- La política de confianza se elige con el límite inferior de Wilson y exige una muestra mínima. La pantalla muestra acierto, límite conservador al 95% y cobertura para evitar porcentajes altos basados en pocas señales.
- Brier score, Brier skill, log-loss y error de calibración miden la calidad de todas las probabilidades, no sólo los aciertos.
- Muestra rentabilidad histórica por moneda al precio ask y descuenta una estimación de la comisión taker general de Kalshi.
- Registra una sola señal por contrato aproximadamente cinco minutos antes del cierre y la evalúa cuando Kalshi publica el resultado. En local usa `.local/paper-signals.json`; la versión pública usa una base D1 de Cloudflare.
- Clasifica la situación actual como favorable, esperar o evitar usando únicamente reglas elegidas en el periodo de calibración, confianza calificada y expectativa neta estimada.
- No solicita credenciales, no tiene órdenes ni ejecuta compras. Cualquier decisión y operación se realiza por separado en Kalshi.

## Tecnología

- Frontend: React 19, TypeScript, Vite, Tailwind CSS y Recharts.
- Backend local: Node.js, TypeScript, Express y Zod.
- Despliegue público: Cloudflare Worker, Static Assets y D1.
- Actualización pública: GitHub Actions consulta la API oficial cada cinco minutos y publica una instantánea de sólo lectura; Cloudflare la conserva en D1 como respaldo.
- Reentrenamiento público: otro flujo gratuito reentrena diariamente, aplica barreras mínimas de muestra, calibración y precisión, y sólo entonces publica el modelo validado.
- Monorepo: pnpm workspaces.

## Abrir el código

Abre la carpeta raíz de este repositorio (`source`) completa en tu editor.

Los dos archivos principales son:

- `artifacts/api-server/src/routes/kalshi.ts`: conexión a Kalshi y respuesta del panel.
- `artifacts/api-server/src/services/kalshi-model.ts`: entrenamiento, predicción y evaluación temporal.
- `artifacts/api-server/src/services/paper-signal-ledger.ts`: seguimiento local de predicciones posteriores al desarrollo.
- `artifacts/kalshi-predictor/src/App.tsx`: interfaz del panel.
- `artifacts/kalshi-predictor/src/i18n.ts`: textos en inglés/español y detección de idioma.
- `cloudflare/worker.ts`: API pública y conexión de la versión desplegada.
- `cloudflare/model-snapshot.json`: modelo entrenado y sus métricas de validación, sin credenciales ni datos personales.

## Ejecutar localmente

Desde la carpeta raíz del proyecto, instala las dependencias una sola vez:

```bash
pnpm install
```

Después inicia la aplicación completa con un solo comando:

```bash
pnpm run dev
```

Abre `http://localhost:5173` en el navegador. La primera carga tarda más porque descarga el historial, entrena el modelo y ejecuta el holdout.

Si el puerto 5000 está ocupado, usa otro puerto en el backend y pásalo al proxy de Vite:

```bash
API_PORT=5052 WEB_PORT=5174 pnpm run dev
```

## API utilizada

Base predeterminada:

`https://external-api.kalshi.com/trade-api/v2`

Se puede sustituir con la variable `KALSHI_API_BASE_URL`. Esta copia sólo lee información pública y no incluye operaciones de trading.

## Actualizar el modelo

La versión local vuelve a entrenar el modelo periódicamente. Cloudflare utiliza una instantánea validada para evitar entrenamientos costosos en cada visita. Para regenerarla con los mercados resueltos más recientes:

```bash
pnpm run model:refresh
```

Después valida y vuelve a publicar la aplicación.

## Desplegar en Cloudflare

El Worker sirve la interfaz y la API desde el mismo subdominio `workers.dev`; no hace falta comprar un dominio. Antes del primer despliegue hay que crear la base D1 y sustituir su identificador en `wrangler.jsonc`.

```bash
pnpm run cloudflare:types
pnpm run cloudflare:migrate:remote
pnpm run cloudflare:deploy
```

El esquema de D1 está en `cloudflare/migrations`. Wrangler publica los archivos compilados de React y dirige únicamente `/api/*` al Worker.

El flujo `.github/workflows/update-kalshi-snapshot.yml` renueva los precios cada cinco minutos. El flujo `.github/workflows/retrain-kalshi-model.yml` vuelve a entrenar y validar el modelo una vez al día. Ambos guardan la instantánea y el último modelo aprobado en una rama técnica `live-data`, sin credenciales de Kalshi y sin acceso para operar. Si Kalshi o GitHub se retrasan, el panel muestra la hora exacta de la última instantánea almacenada.

## Interpretación responsable

La probabilidad del modelo representa su estimación para el lado mostrado. La rentabilidad neta es aproximada: usa la cotización observada y la fórmula general de comisión taker, pero el precio ejecutado, redondeos y tarifas reales pueden variar. La tasa de acierto pertenece únicamente al holdout histórico indicado y puede cambiar cuando se reentrena. La rentabilidad histórica total de una versión puede ser negativa aunque su tasa de acierto parezca alta. Ninguna etiqueta constituye una promesa de beneficio, una instrucción de compra ni asesoría financiera.
