# Agente Integral Profesional — M-AR & Asociados

Chatbot comercial con 4 módulos (Comercial, Contable, Finanzas, Legal) y, ahora, capacidades de herramienta profesional:

1. **Captura automática de leads** — formulario + detección de datos de contacto en la charla. Quedan guardados y se exportan a Excel.
2. **Entrenamiento con documentos** — subís PDFs / catálogos / contratos / manuales y el agente responde con esa info.
3. **Reporte de actividad** — consultas, temas frecuentes y leads. Manual desde el panel o automático por email.
4. **WhatsApp** — el mismo agente atiende por WhatsApp (requiere configurar Meta, ver más abajo).
5. **Agendamiento** — los clientes piden reuniones / visitas / turnos.
6. **Atención al cliente** — el chat del agente.
7. **Panel de administración** — `/admin` con leads, conversaciones, documentos, turnos y configuración.

---

## Cómo subirlo (sin terminal, todo por la web)

### Paso 1 — Subir el código a GitHub
1. Entrá a **github.com**, creá una cuenta si no tenés, y hacé clic en **New repository**. Ponele un nombre (ej: `agente-mar`). Dejalo en **Private**. Creá el repo.
2. En el repo vacío, clic en **uploading an existing file**.
3. Arrastrá **todo el contenido** de la carpeta `agente-mar` (los archivos y carpetas `src/` y `public/`). **No subas** la carpeta `node_modules` ni `data` si existieran.
4. Clic en **Commit changes**.

### Paso 2 — Conectar Render
1. Entrá a **render.com** con tu cuenta. **New > Web Service**.
2. Conectá tu GitHub y elegí el repo `agente-mar`. Render detecta el `render.yaml` solo.
3. En **Environment**, cargá las variables (mínimas para arrancar):
   - `GROQ_API_KEY` → tu clave de Groq.
   - `ADMIN_PASSWORD` → una contraseña tuya para entrar al panel.
   - `WEB3FORMS_KEY` → tu clave (ya viene la tuya en `.env.example`).
4. **Create Web Service**. En 2-3 minutos queda online en tu URL de Render.

> Si querés reemplazar el agente actual, podés re-deployar sobre el mismo servicio `agente-mar` que ya tenés en Render.

### Paso 3 — Usarlo
- **Agente (clientes):** la URL principal, ej. `https://agente-mar.onrender.com/`
- **Panel (vos):** `https://agente-mar.onrender.com/admin`

---

## Importante: persistencia de datos

En el **plan gratuito de Render** los datos (leads, conversaciones, documentos) **se reinician con cada actualización del código** y el servidor se duerme tras 15 min sin uso.

Dos formas de resolverlo:
- **Para no perder leads:** entrá seguido al panel y usá **Descargar Excel (CSV)**. Es tu respaldo manual.
- **Para guardado permanente:** subí el plan a **Starter** y agregá un **disco** (descomentá la sección `disk:` en `render.yaml` y dejá `DATA_DIR=/var/data`). Con eso nada se borra.

---

## Reporte semanal automático

El reporte se puede generar a mano desde el panel (pestaña **Resumen**). Para que llegue **solo, todas las semanas, a tu email**:

1. Entrá a **cron-job.org** (gratis), creá una cuenta.
2. **Create cronjob**, URL:
   `https://TU-URL.onrender.com/api/report/run?token=TU_REPORT_TOKEN&days=7`
3. Programalo, por ejemplo, los lunes 9:00.
4. Listo: cada lunes corre, arma el reporte y te lo manda por email (vía Web3Forms).

---

## Conectar WhatsApp (Meta Cloud API)

Esto necesita una configuración tuya en Meta (es gratis, pero lleva pasos). El código del agente ya está listo para recibir mensajes.

1. Entrá a **developers.facebook.com** → creá una app tipo **Business**.
2. Agregá el producto **WhatsApp**. Meta te da un **número de prueba** y un **token temporal**.
3. Copiá a Render estas variables:
   - `WHATSAPP_TOKEN` → el token de acceso.
   - `WHATSAPP_PHONE_ID` → el *Phone number ID* del número.
   - `WHATSAPP_VERIFY_TOKEN` → inventá una palabra (ej: `mar_whatsapp_verify`).
4. En la configuración del webhook de Meta:
   - **Callback URL:** `https://TU-URL.onrender.com/webhook/whatsapp`
   - **Verify token:** el mismo `WHATSAPP_VERIFY_TOKEN`.
   - Suscribite al evento **messages**.
5. Mandale un WhatsApp al número de prueba: el agente responde.

> Para usar tu número real y atender clientes de verdad, Meta pide verificar el negocio. Conviene hacerlo cuando el agente ya esté probado.

---

## Estructura

```
agente-mar/
├── server.js          ← servidor y rutas
├── render.yaml        ← deploy en Render
├── .env.example       ← variables de entorno
├── src/
│   ├── db.js          ← base de datos (SQLite)
│   ├── groq.js        ← modelo + prompts por módulo
│   ├── rag.js         ← entrenamiento con documentos
│   ├── leads.js       ← captura de leads + export
│   ├── report.js      ← reportes
│   ├── notify.js      ← emails (Web3Forms)
│   └── whatsapp.js    ← integración WhatsApp
└── public/            ← chat (index) y panel (admin)
```
