# API de filo.

API en Node.js (Express) que usa la app Flutter. Es una capa delgada: valida la sesión y llama a las funciones `fn_*`
de la base (esquema `barber` en Supabase), donde viven todas las reglas del negocio.

## Puesta en marcha
1. En el SQL Editor de Supabase, habilita el rol del backend (una sola vez, con una clave larga):
   ```sql
   alter role barber_backend login password '<clave larga y aleatoria>';
   ```
2. Copia `.env.example` como `.env` y completa `DATABASE_URL` con esa clave (usuario `barber_backend.<proyecto>`, puerto **5432**).
3. `npm install` y `npm run dev` (lee el archivo `.env`). Comprueba con `GET /salud` → `{"ok": true}`.
   En el servidor se usa `npm start` y las variables se configuran en el panel del hosting.

## Subirla a un servidor
Sirve cualquier hosting de Node.js 20+ (Render, Railway, Fly.io, un VPS...): comando de inicio `npm start`,
variables de entorno `DATABASE_URL`, `PUERTO` y `CORS_ORIGEN` (dominio de la app web). Siempre detrás de HTTPS.

## Endpoints (`/v1`)
Todas, salvo iniciar sesión, llevan `Authorization: Bearer <token>`. Errores: `{"error": "mensaje para el usuario", "codigo": "..."}`.
Con `codigo = CAMBIAR_CLAVE` la app debe llevar a la pantalla de cambio de contraseña.

| Método | Ruta | Función de la base |
|---|---|---|
| POST | `/sesion` `{usuario, clave}` | `fn_iniciar_sesion` (más límite por IP) |
| GET | `/sesion` | `fn_estado_sesion` |
| DELETE | `/sesion` | `fn_cerrar_sesion` |
| POST | `/sesion/clave` `{actual, nueva}` | `fn_cambiar_clave` |
| PATCH | `/sesion/perfil` `{nombre, correo, celular}` | `fn_actualizar_perfil` |
| GET | `/negocios` | `fn_negocios_de_cuenta` |
| GET | `/negocios/:negocio/menu` | `fn_menu_de_miembro` |
| POST | `/unirse` `{codigo}` | `fn_unirse_con_clave` |
| POST | `/negocios/:negocio/invitaciones` `{rol, sede_id, usos}` | `fn_crear_invitacion_dinamica` |
| GET | `/negocios/:negocio/invitaciones/:id/clave` | `fn_clave_dinamica_actual` |
| DELETE | `/negocios/:negocio/invitaciones/:id` | `fn_revocar_invitacion_dinamica` |
| POST | `/negocios/:negocio/nequi/pagos` | `fn_registrar_nequi` |
| POST | `/negocios/:negocio/dispositivos/:id/latido` | `fn_latido_dispositivo` |
| GET | `/plataforma/negocios` | lista de barberías (superadmin) |
| POST | `/plataforma/negocios` | `fn_plataforma_crear_negocio` (superadmin) |
| GET | `/plataforma/planes` | planes activos (superadmin) |

## App
`flutter run --dart-define=API_URL=https://tu-api.com` usa esta API; sin `API_URL` la app usa datos de ejemplo.
