const express = require('express');
const { transaccion, uno } = require('./db');
const { ErrorApi } = require('./errores');

const r = express.Router();

// Envuelve un manejador async para que sus errores lleguen a manejarErrores.
const a = (fn) => (req, res, next) => fn(req, res).catch(next);

const token = (req) => {
  const [tipo, valor] = (req.get('authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !valor) throw new ErrorApi(401, 'Inicia sesión para continuar', 'SIN_SESION');
  return valor;
};

/** Valida la sesión (fn_estado_sesion) y deja la cuenta en req.cuenta. */
const sesion = (req, _res, next) =>
  Promise.resolve()
    .then(() => transaccion(null, (c) => uno(c, 'fn_estado_sesion($1)', [token(req)])))
    .then((cuenta) => {
      req.cuenta = cuenta;
      next();
    }, next);

const soloSuperadmin = (req, _res, next) =>
  next(req.cuenta.es_superadmin ? undefined : new ErrorApi(403, 'Solo el administrador de la plataforma puede hacer esto'));

/** Transacción como la cuenta de la sesión; con negocio, también resuelve su miembro (fn_miembro_en_negocio). */
const comoMiembro = (req, trabajo) =>
  transaccion(req.cuenta.cuenta_id, async (c) => {
    const miembro = await uno(c, 'fn_miembro_en_negocio($1, $2)', [req.cuenta.cuenta_id, req.params.negocio]);
    return trabajo(c, miembro);
  });

// ---------------------------------------------------------------- Sesión (flujo 2)
r.post('/sesion', a(async (req, res) => {
  const { usuario, clave, dispositivo } = req.body || {};
  const resultado = await transaccion(null, async (c) => {
    if (!(await uno(c, 'fn_limitar($1, 30, $2::interval)', [`login:ip:${req.ip}`, '15 minutes']))) {
      return { ok: false, mensaje: 'Demasiados intentos desde esta conexión: espera unos minutos' };
    }
    return uno(c, 'fn_iniciar_sesion($1, $2, $3)', [usuario || '', clave || '', dispositivo || null]);
  });
  res.status(resultado.ok ? 200 : 401).json(resultado);
}));

r.get('/sesion', sesion, (req, res) => res.json(req.cuenta));

r.delete('/sesion', a(async (req, res) => {
  await transaccion(null, (c) => uno(c, 'fn_cerrar_sesion($1)', [token(req)]));
  res.status(204).end();
}));

r.post('/sesion/clave', sesion, a(async (req, res) => {
  const { actual, nueva } = req.body || {};
  await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_cambiar_clave($1, $2, $3)', [req.cuenta.cuenta_id, actual || '', nueva || '']));
  res.json({ ok: true, mensaje: 'Contraseña cambiada. Inicia sesión con la nueva.' });
}));

// "Mi cuenta": nombre, correo y celular (el usuario no cambia).
r.patch('/sesion/perfil', sesion, a(async (req, res) => {
  const { nombre, correo, celular } = req.body || {};
  res.json(await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_actualizar_perfil($1, $2, $3, $4)', [req.cuenta.cuenta_id, nombre || '', correo || '', celular || null])));
}));

// ---------------------------------------------------------------- Barberías de la cuenta y menú (flujos 2 y 6)
r.get('/negocios', sesion, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, (c) => uno(c, 'fn_negocios_de_cuenta($1)', [req.cuenta.cuenta_id])));
}));

r.get('/negocios/:negocio/menu', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_menu_de_miembro($1, $2)', [req.params.negocio, m])));
}));

// ---------------------------------------------------------------- Equipo: clave dinámica (flujo 7)
r.post('/unirse', sesion, a(async (req, res) => {
  const resultado = await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_unirse_con_clave($1, $2)', [req.cuenta.cuenta_id, (req.body || {}).codigo || '']));
  res.status(resultado.ok ? 200 : 422).json(resultado);
}));

r.post('/negocios/:negocio/invitaciones', sesion, a(async (req, res) => {
  const { rol, sede_id: sede, usos } = req.body || {};
  res.status(201).json(await comoMiembro(req, (c, m) =>
    uno(c, 'fn_crear_invitacion_dinamica($1, $2, $3, $4, $5)', [req.params.negocio, m, rol || '', sede || null, usos || 1])));
}));

r.get('/negocios/:negocio/invitaciones/:invitacion/clave', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) =>
    uno(c, 'fn_clave_dinamica_actual($1, $2, $3)', [req.params.negocio, m, req.params.invitacion])));
}));

r.delete('/negocios/:negocio/invitaciones/:invitacion', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) =>
    uno(c, 'fn_revocar_invitacion_dinamica($1, $2, $3)', [req.params.negocio, m, req.params.invitacion]));
  res.status(204).end();
}));

// ---------------------------------------------------------------- Nequi (flujo 8)
r.post('/negocios/:negocio/nequi/pagos', sesion, a(async (req, res) => {
  res.status(201).json(await comoMiembro(req, (c, m) =>
    uno(c, 'fn_registrar_nequi($1::jsonb)', [JSON.stringify({ ...req.body, negocio_id: req.params.negocio, usuario_id: m })])));
}));

r.post('/negocios/:negocio/dispositivos/:dispositivo/latido', sesion, a(async (req, res) => {
  await comoMiembro(req, (c) => uno(c, 'fn_latido_dispositivo($1, $2)', [req.params.negocio, req.params.dispositivo]));
  res.status(204).end();
}));

// ---------------------------------------------------------------- Plataforma: superadmin (flujos 3, 4 y 5)
r.get('/plataforma/negocios', sesion, soloSuperadmin, a(async (req, res) => {
  const filas = await transaccion(req.cuenta.cuenta_id, async (c) => (await c.query(`
    select n.id, n.nombre, n.ciudad, n.modo, n.activo, n.creado_en,
           cu.nombre as dueno, cu.usuario as dueno_usuario,
           fn_estado_acceso(n.id) as acceso
      from negocio n
      left join miembro m on m.negocio_id = n.id and m.rol = 'DUENO'
      left join cuenta cu on cu.id = m.cuenta_id
     order by n.creado_en desc`)).rows);
  res.json(filas);
}));

r.post('/plataforma/negocios', sesion, soloSuperadmin, a(async (req, res) => {
  res.status(201).json(await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_plataforma_crear_negocio($1, $2::jsonb)', [req.cuenta.cuenta_id, JSON.stringify(req.body || {})])));
}));

r.get('/plataforma/planes', sesion, soloSuperadmin, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, async (c) => (await c.query(`
    select codigo, nombre, descripcion, precio_mensual, precio_anual, max_sedes, max_miembros, dias_prueba, dias_gracia
      from plan where activo order by precio_mensual`)).rows));
}));

module.exports = r;
