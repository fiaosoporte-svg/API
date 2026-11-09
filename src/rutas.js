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

/** Igual que comoMiembro, pero exige que la persona tenga hoy el módulo (permiso por persona, flujo 6). */
const conModulo = (req, modulo, trabajo) =>
  comoMiembro(req, async (c, m) => {
    if (!(await uno(c, 'fn_puede($1, $2, $3)', [req.params.negocio, m, modulo]))) {
      throw new ErrorApi(403, 'No tienes permiso para esta pantalla');
    }
    await uno(c, 'fn_validar_miembro($1, $2, null)', [req.params.negocio, m]);
    return trabajo(c, m);
  });

// ---------------------------------------------------------------- Registro público de cuentas (flujo 7)
r.post('/cuentas', a(async (req, res) => {
  const { nombre, usuario, correo, celular, clave } = req.body || {};
  if (!usuario || !nombre) throw new ErrorApi(422, 'Escribe tu nombre y tu usuario');
  // El límite va en su propia transacción: si el registro falla, el intento igual se cuenta.
  const permitido = await transaccion(null, (c) => uno(c, 'fn_limitar($1, 10, $2::interval)', [`registro:ip:${req.ip}`, '1 hour']));
  if (!permitido) throw new ErrorApi(429, 'Demasiados registros desde esta conexión: intenta más tarde');
  await transaccion(null, (c) => uno(c, 'fn_registrar_cuenta($1, $2, $3, $4, $5)', [nombre, correo || '', celular || null, clave || '', usuario]));
  res.status(201).json({ ok: true, mensaje: 'Cuenta creada. Ya puedes iniciar sesión.' });
}));

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

// ---------------------------------------------------------------- Datos base de la barbería
r.get('/negocios/:negocio/datos', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, async (c, m) => ({
    miembro_id: m,
    // 015: rol y sedes de quien entra (Registro usa su sede y, si es barbero, solo se registra a sí mismo).
    rol: (await c.query('select rol from miembro where id = $1', [m])).rows[0]?.rol,
    mis_sedes: (await c.query('select sede_id from miembro_sede where miembro_id = $1', [m])).rows.map((x) => x.sede_id),
    sedes: (await c.query('select id, nombre from sede where negocio_id = $1 and activo order by creado_en', [req.params.negocio])).rows,
    servicios: (await c.query(`select id, nombre, categoria, precio, duracion_min from servicio
                                where negocio_id = $1 and activo order by categoria, nombre`, [req.params.negocio])).rows,
    barberos: (await c.query(`select m.id, coalesce(m.nombre_publico, cu.nombre) as nombre,
                                     coalesce((select array_agg(ms.sede_id) from miembro_sede ms where ms.miembro_id = m.id), '{}') as sedes
                                from miembro m join cuenta cu on cu.id = m.cuenta_id
                               where m.negocio_id = $1 and m.activo and m.atiende_clientes order by 2`, [req.params.negocio])).rows,
  })));
}));

// ---------------------------------------------------------------- Inicio
r.get('/negocios/:negocio/dashboard', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'DASHBOARD', (c, m) => uno(c, 'fn_dashboard($1, $2)', [req.params.negocio, m])));
}));

// Ventas por día de los últimos 60 días: la app arma Hoy, Semana y Mes con sus barras y comparaciones.
r.get('/negocios/:negocio/ventas', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'DASHBOARD', async (c, m) => {
    // Igual que fn_dashboard: el dinero no es para los barberos.
    await uno(c, "fn_validar_miembro($1, $2, null, array['DUENO', 'ADMIN', 'RECEPCION'])", [req.params.negocio, m]);
    return (await c.query(`
    select dia::text as dia, sum(ventas) as ventas, sum(atenciones) as atenciones
      from v_resumen_dia
     where negocio_id = $1 and dia >= fn_dia(now()) - 60 and ($2::uuid is null or sede_id = $2)
     group by dia order by dia`, [req.params.negocio, req.query.sede || null])).rows;
  }));
}));

r.get('/negocios/:negocio/resumen-voz', sesion, a(async (req, res) => {
  res.json({ texto: await conModulo(req, 'DASHBOARD', (c, m) => uno(c, 'fn_resumen_voz($1, $2)', [req.params.negocio, m])) });
}));

// ---------------------------------------------------------------- Registro rápido
r.post('/negocios/:negocio/atenciones', sesion, a(async (req, res) => {
  const id = await conModulo(req, 'REGISTRO_RAPIDO', (c, m) => uno(c, 'fn_registrar_atencion($1::jsonb)',
    [JSON.stringify({ ...req.body, negocio_id: req.params.negocio, usuario_id: m })]));
  res.status(201).json({ id });
}));

// Lo que se va a cobrar, calculado por la base sin guardar nada (descuentos, combo y premio incluidos).
r.post('/negocios/:negocio/atenciones/cotizar', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'REGISTRO_RAPIDO', (c, m) => uno(c, 'fn_cotizar_atencion($1::jsonb)',
    [JSON.stringify({ ...req.body, negocio_id: req.params.negocio, usuario_id: m })])));
}));

// Ventas de un día (?dia=AAAA-MM-DD&sede=). El barbero solo ve las suyas.
r.get('/negocios/:negocio/atenciones', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_ventas_dia($1, $2, $3::date, $4)',
    [req.params.negocio, m, req.query.dia || null, req.query.sede || null])));
}));

// {motivo}. Solo dueño o admin: no borra, deja los movimientos contrarios.
r.post('/negocios/:negocio/atenciones/:atencion/anular', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) => uno(c, 'fn_anular_atencion($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.atencion, (req.body || {}).motivo || '']));
  res.status(204).end();
}));

// ---------------------------------------------------------------- Agenda
r.get('/negocios/:negocio/citas', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'AGENDA', async (c, m) => {
    // Al abrir la agenda, las citas que pasaron hace más de 30 min sin atenderse quedan como "no asistió".
    await uno(c, 'fn_cerrar_citas_vencidas($1, $2)', [req.params.negocio, m]);
    return (await c.query(`
    select ci.id, ci.inicia_en, ci.termina_en, ci.estado, cl.nombre as cliente, cl.telefono, ci.cliente_id, ci.sede_id,
           (select array_agg(cs.servicio_id order by cs.linea) from cita_servicio cs where cs.cita_id = ci.id) as servicio_ids,
           coalesce(m.nombre_publico, cu.nombre) as barbero, m.id as miembro_id,
           (select string_agg(s.nombre, ' + ' order by cs.linea) from cita_servicio cs join servicio s on s.id = cs.servicio_id
             where cs.cita_id = ci.id) as servicios
      from cita ci
      join cliente cl on cl.id = ci.cliente_id
      join miembro m on m.id = ci.miembro_id
      join cuenta cu on cu.id = m.cuenta_id
     where ci.negocio_id = $1 and fn_dia(ci.inicia_en) = coalesce($2::date, fn_dia(now()))
     order by ci.inicia_en`, [req.params.negocio, req.query.dia || null])).rows;
  }));
}));

r.get('/negocios/:negocio/horarios', sesion, a(async (req, res) => {
  const { sede, miembro, dia, duracion } = req.query;
  res.json(await conModulo(req, 'AGENDA', async (c) => (await c.query(
    'select inicia_en, termina_en from fn_horarios_disponibles($1, $2, $3, $4::date, $5::integer)',
    [req.params.negocio, sede, miembro, dia, duracion || 30])).rows));
}));

r.post('/negocios/:negocio/citas', sesion, a(async (req, res) => {
  const id = await conModulo(req, 'AGENDA', (c, m) => uno(c, 'fn_crear_cita($1::jsonb)',
    [JSON.stringify({ ...req.body, negocio_id: req.params.negocio, usuario_id: m })]));
  res.status(201).json({ id });
}));

r.post('/negocios/:negocio/citas/:cita/estado', sesion, a(async (req, res) => {
  const { estado, motivo } = req.body || {};
  await conModulo(req, 'AGENDA', (c, m) => uno(c, 'fn_cambiar_estado_cita($1, $2, $3, $4, $5)',
    [req.params.negocio, m, req.params.cita, estado || '', motivo || null]));
  res.status(204).end();
}));

// ---------------------------------------------------------------- Clientes
r.get('/negocios/:negocio/clientes', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'CLIENTES', async (c) => (await c.query(`
    select id, nombre, telefono, email, ultima_visita, total_visitas, total_gastado
      from cliente
     where negocio_id = $1 and activo and ($2::text is null or lower(nombre) like '%' || lower($2) || '%' or telefono like '%' || $2 || '%')
     order by nombre limit 100`, [req.params.negocio, req.query.q || null])).rows));
}));

r.post('/negocios/:negocio/clientes', sesion, a(async (req, res) => {
  const { nombre, telefono, email } = req.body || {};
  const fila = await conModulo(req, 'CLIENTES', async (c) => (await c.query(
    'insert into cliente (negocio_id, nombre, telefono, email) values ($1, $2, $3, $4) returning id, nombre, telefono',
    [req.params.negocio, nombre || '', telefono || null, email || null])).rows[0])
    .catch((e) => {
      if (e.code === '23505') throw new ErrorApi(409, 'Ya existe un cliente con ese teléfono');
      if (e.code === '23514') throw new ErrorApi(422, 'Revisa el nombre, el teléfono y el correo del cliente');
      throw e;
    });
  res.status(201).json(fila);
}));

// ---------------------------------------------------------------- Servicios
const errorServicio = (e) => {
  if (e.code === '23514') throw new ErrorApi(422, 'Revisa el nombre, el precio y la duración (de 5 a 480 minutos)');
  throw e;
};

r.get('/negocios/:negocio/servicios', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'SERVICIOS', async (c) => (await c.query(
    `select id, nombre, categoria, precio, duracion_min, activo from servicio
      where negocio_id = $1 order by activo desc, categoria, nombre`, [req.params.negocio])).rows));
}));

r.post('/negocios/:negocio/servicios', sesion, a(async (req, res) => {
  const { nombre, categoria, precio, duracion_min: duracion } = req.body || {};
  res.status(201).json(await conModulo(req, 'SERVICIOS', async (c) => (await c.query(
    `insert into servicio (negocio_id, nombre, categoria, precio, duracion_min)
     values ($1, $2, $3, $4, $5) returning id`,
    [req.params.negocio, nombre || '', categoria || 'CORTE', precio ?? 0, duracion || 30])).rows[0]).catch(errorServicio));
}));

r.patch('/negocios/:negocio/servicios/:servicio', sesion, a(async (req, res) => {
  const { nombre, categoria, precio, duracion_min: duracion, activo } = req.body || {};
  await conModulo(req, 'SERVICIOS', (c) => c.query(
    `update servicio set nombre = $3, categoria = $4, precio = $5, duracion_min = $6, activo = $7
      where negocio_id = $1 and id = $2`,
    [req.params.negocio, req.params.servicio, nombre || '', categoria || 'CORTE', precio ?? 0, duracion || 30, activo !== false]))
    .catch(errorServicio);
  res.status(204).end();
}));

// ---------------------------------------------------------------- Mi suscripción y Configuración
r.get('/negocios/:negocio/suscripcion', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_mi_suscripcion($1, $2)', [req.params.negocio, m])));
}));

r.get('/negocios/:negocio/configuracion', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'CONFIGURACION', async (c) => (await c.query(
    'select nombre, ciudad, telefono, email as correo, nit, razon_social from negocio where id = $1', [req.params.negocio])).rows[0]));
}));

r.patch('/negocios/:negocio/configuracion', sesion, a(async (req, res) => {
  const { nombre, ciudad, telefono, correo, nit, razon_social: razon } = req.body || {};
  await comoMiembro(req, async (c, m) => {
    await uno(c, "fn_validar_miembro($1, $2, null, array['DUENO', 'ADMIN'])", [req.params.negocio, m]);
    await c.query(`update negocio set nombre = $2, ciudad = $3, telefono = $4, email = $5, nit = $6, razon_social = $7 where id = $1`,
      [req.params.negocio, nombre || '', ciudad || null, telefono || null, correo || null, nit || null, razon || null]);
  }).catch((e) => {
    if (e.code === '23514') throw new ErrorApi(422, 'Revisa los datos: nombre, teléfono, correo o NIT no son válidos');
    throw e;
  });
  res.json({ ok: true, mensaje: 'Datos guardados' });
}));

// ---------------------------------------------------------------- Equipo y permisos por persona (flujos 6 y 7)
r.get('/negocios/:negocio/equipo', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_equipo($1, $2)', [req.params.negocio, m])));
}));

r.get('/negocios/:negocio/equipo/:miembro/permisos', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, async (c, m) => {
    await uno(c, "fn_validar_miembro($1, $2, null, array['DUENO'])", [req.params.negocio, m]);
    return uno(c, 'fn_permisos_de_miembro($1, $2)', [req.params.negocio, req.params.miembro]);
  }));
}));

// {tipo: VISTA|ACCION, modulo, codigo, dar: true|false}. Solo el dueño, y solo dentro de lo que tiene la barbería.
r.put('/negocios/:negocio/equipo/:miembro/permisos', sesion, a(async (req, res) => {
  const { tipo, modulo, codigo, dar } = req.body || {};
  await comoMiembro(req, (c, m) => uno(c, 'fn_fijar_permiso_persona($1, $2, $3, $4, $5, $6, $7)',
    [req.params.negocio, m, req.params.miembro, tipo || '', modulo || '', codigo || '', dar === true]));
  res.status(204).end();
}));

// ---------------------------------------------------------------- Equipo: horario, descansos, comisión, metas y rendimiento (013)
// ':miembro' puede ser 'yo': la persona de la sesión (la app no necesita conocer su propio id).
const persona = (req, m) => (req.params.miembro === 'yo' ? m : req.params.miembro);

// Cada persona ve su horario; solo el dueño o un admin lo cambian. Los descansos los puede poner la misma persona.
r.get('/negocios/:negocio/equipo/:miembro/horario', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_horario_de_miembro($1, $2, $3)',
    [req.params.negocio, m, persona(req, m)])));
}));

// {dias: [{dia: 0..6, desde: 'HH:MI', hasta: 'HH:MI'}]}; lista vacía = usa el horario de la sede.
r.put('/negocios/:negocio/equipo/:miembro/horario', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) => uno(c, 'fn_fijar_horario_miembro($1, $2, $3, $4::jsonb)',
    [req.params.negocio, m, req.params.miembro, JSON.stringify((req.body || {}).dias || [])]));
  res.status(204).end();
}));

// {desde, hasta (ISO), motivo: ALMUERZO|DESCANSO|VACACIONES|PERMISO|OTRO, nota}
r.post('/negocios/:negocio/equipo/:miembro/bloqueos', sesion, a(async (req, res) => {
  const { desde, hasta, motivo, nota } = req.body || {};
  if (!desde || !hasta) throw new ErrorApi(422, 'Indica desde y hasta cuándo');
  const id = await comoMiembro(req, (c, m) => uno(c, 'fn_crear_bloqueo($1, $2, $3, $4, $5, $6, $7)',
    [req.params.negocio, m, persona(req, m), desde, hasta, motivo || 'OTRO', nota || null]));
  res.status(201).json({ id });
}));

r.delete('/negocios/:negocio/bloqueos/:bloqueo', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) => uno(c, 'fn_borrar_bloqueo($1, $2, $3)', [req.params.negocio, m, req.params.bloqueo]));
  res.status(204).end();
}));

// {porcentaje, atiende_clientes}. Solo el dueño.
r.put('/negocios/:negocio/equipo/:miembro/comision', sesion, a(async (req, res) => {
  const { porcentaje, atiende_clientes: atiende } = req.body || {};
  await comoMiembro(req, (c, m) => uno(c, 'fn_fijar_comision_miembro($1, $2, $3, $4, $5)',
    [req.params.negocio, m, req.params.miembro, Number(porcentaje), typeof atiende === 'boolean' ? atiende : null]));
  res.status(204).end();
}));

// {miembro_id (null = toda la barbería), valor (0 = quitar)}. Meta mensual de ventas.
r.put('/negocios/:negocio/metas', sesion, a(async (req, res) => {
  const { miembro_id: miembro, valor } = req.body || {};
  await comoMiembro(req, (c, m) => uno(c, 'fn_fijar_meta($1, $2, $3, $4)',
    [req.params.negocio, m, miembro || null, Number(valor)]));
  res.status(204).end();
}));

// ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD (por defecto, lo que va del mes). Dueño y admin ven a todos; los demás, solo lo suyo.
r.get('/negocios/:negocio/rendimiento', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c,
    `fn_rendimiento_equipo($1, $2, coalesce($3::date, date_trunc('month', fn_dia(now()))::date), coalesce($4::date, fn_dia(now())), $5::uuid)`,
    [req.params.negocio, m, req.query.desde || null, req.query.hasta || null, req.query.sede || null])));
}));

// ---------------------------------------------------------------- Promociones, combos y tarjeta de sellos (014)
r.get('/negocios/:negocio/promociones', sesion, a(async (req, res) => {
  res.json(await conModulo(req, 'PROMOCIONES', (c, m) => uno(c, 'fn_promociones($1, $2)', [req.params.negocio, m])));
}));

// Cuerpo: ver fn_guardar_promocion (clase DESCUENTO | COMBO | SELLOS). La tarjeta de sellos también es una promoción.
r.post('/negocios/:negocio/promociones', sesion, a(async (req, res) => {
  const id = await conModulo(req, 'PROMOCIONES', (c, m) => uno(c, 'fn_guardar_promocion($1, $2, $3::jsonb)',
    [req.params.negocio, m, JSON.stringify({ ...(req.body || {}), id: null })]));
  res.status(201).json({ id });
}));

r.put('/negocios/:negocio/promociones/:promocion', sesion, a(async (req, res) => {
  await conModulo(req, 'PROMOCIONES', (c, m) => uno(c, 'fn_guardar_promocion($1, $2, $3::jsonb)',
    [req.params.negocio, m, JSON.stringify({ ...(req.body || {}), id: req.params.promocion })]));
  res.status(204).end();
}));

r.post('/negocios/:negocio/promociones/:promocion/activa', sesion, a(async (req, res) => {
  await conModulo(req, 'PROMOCIONES', (c, m) => uno(c, 'fn_activar_promocion($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.promocion, (req.body || {}).activa === true]));
  res.status(204).end();
}));

// Combos y descuentos que aplican ahora, para ofrecerlos en Registro. ?sede=&miembro=
r.get('/negocios/:negocio/promociones/vigentes', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_promociones_vigentes($1, $2, $3, $4)',
    [req.params.negocio, m, req.query.sede || null, req.query.miembro || null])));
}));

// Tarjetas, premios disponibles e historial de un cliente (ficha y aviso "🎁" al cobrar).
r.get('/negocios/:negocio/clientes/:cliente/fidelizacion', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_fidelizacion_cliente($1, $2, $3)',
    [req.params.negocio, m, req.params.cliente])));
}));

// {promocion_id, cantidad (+/-), motivo}. Requiere la acción AJUSTAR_SELLOS.
r.post('/negocios/:negocio/clientes/:cliente/sellos', sesion, a(async (req, res) => {
  const { promocion_id: promocion, cantidad, motivo } = req.body || {};
  await comoMiembro(req, (c, m) => uno(c, 'fn_ajustar_sellos($1, $2, $3, $4, $5, $6)',
    [req.params.negocio, m, req.params.cliente, promocion || null, Number(cantidad), motivo || null]));
  res.status(204).end();
}));

r.get('/negocios/:negocio/sellos/pendientes', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_sellos_pendientes($1, $2)', [req.params.negocio, m])));
}));

// {aprobar: true|false}. Requiere la acción APROBAR_SELLOS.
r.post('/negocios/:negocio/sellos/:movimiento/revisar', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) => uno(c, 'fn_revisar_sello($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.movimiento, (req.body || {}).aprobar === true]));
  res.status(204).end();
}));

// {ids?: [...], aprobar}. Sin ids: todos los pendientes. Devuelve cuántos se revisaron.
r.post('/negocios/:negocio/sellos/revisar-lote', sesion, a(async (req, res) => {
  const { ids, aprobar } = req.body || {};
  res.json({ revisados: await comoMiembro(req, (c, m) => uno(c, 'fn_revisar_sellos_lote($1, $2, $3::uuid[], $4)',
    [req.params.negocio, m, Array.isArray(ids) && ids.length ? ids : null, aprobar === true])) });
}));

// {codigo}: código promocional o código de un amigo. Devuelve {tipo, recompensa_id, premio, mensaje}.
r.post('/negocios/:negocio/clientes/:cliente/codigo', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_aplicar_codigo($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.cliente, (req.body || {}).codigo || ''])));
}));

// ---------------------------------------------------------------- Comisiones: lo que se debe y pagarlo
r.get('/negocios/:negocio/comisiones', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_comisiones_pendientes($1, $2)', [req.params.negocio, m])));
}));

// {medio}. Liquida todo lo pendiente de esa persona hasta hoy y lo registra como pagado.
r.post('/negocios/:negocio/comisiones/:miembro/pagar', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_liquidar_y_pagar($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.miembro, (req.body || {}).medio || 'EFECTIVO'])));
}));

// {activo}: retirar (false) o volver a activar (true) a una persona del equipo.
r.post('/negocios/:negocio/equipo/:miembro/activo', sesion, a(async (req, res) => {
  await comoMiembro(req, (c, m) => uno(c, 'fn_activar_miembro($1, $2, $3, $4)',
    [req.params.negocio, m, req.params.miembro, (req.body || {}).activo === true]));
  res.status(204).end();
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

// accion: VERIFICAR, DESCARTAR o EXCLUIR_PERSONA.
r.post('/negocios/:negocio/nequi/pagos/:pago/revisar', sesion, a(async (req, res) => {
  const { accion, nota } = req.body || {};
  await conModulo(req, 'NEQUI', (c, m) => uno(c, 'fn_revisar_nequi($1, $2, $3, $4, $5)',
    [req.params.negocio, m, req.params.pago, accion || '', nota || null]));
  res.status(204).end();
}));

r.get('/negocios/:negocio/nequi/pagos', sesion, a(async (req, res) => {
  res.json(await comoMiembro(req, (c, m) => uno(c, 'fn_pagos_nequi($1, $2, $3)', [req.params.negocio, m, Number(req.query.limite) || 50])));
}));

// Vincula este celular a la barbería y a la persona de la sesión: {identificador, nombre}.
r.post('/negocios/:negocio/dispositivos', sesion, a(async (req, res) => {
  const { identificador, nombre } = req.body || {};
  res.json(await comoMiembro(req, (c, m) =>
    uno(c, 'fn_vincular_dispositivo($1, $2, $3, $4)', [req.params.negocio, m, identificador || '', nombre || null])));
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

// Árbol módulo → vistas → acciones. Con ?plan=CODIGO marca lo que ese plan incluye.
r.get('/plataforma/catalogo', sesion, soloSuperadmin, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, (c) => uno(c, 'fn_plan_arbol($1)', [req.query.plan || null])));
}));

// Crea o actualiza un plan: {codigo, nombre, precio_mensual, ..., modulos: [{codigo, vistas, acciones}]}.
r.put('/plataforma/planes', sesion, soloSuperadmin, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_plataforma_guardar_plan($1, $2::jsonb)', [req.cuenta.cuenta_id, JSON.stringify(req.body || {})])));
}));

// Contraseña temporal para cualquier cuenta: se devuelve una sola vez.
r.post('/plataforma/cuentas/restablecer', sesion, soloSuperadmin, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, (c) =>
    uno(c, 'fn_plataforma_restablecer_clave($1, $2)', [req.cuenta.cuenta_id, (req.body || {}).usuario || ''])));
}));

// Módulos de una barbería: cuáles tiene hoy. Sirve para darle más al dueño desde el panel.
r.get('/plataforma/negocios/:negocio/modulos', sesion, soloSuperadmin, a(async (req, res) => {
  res.json(await transaccion(req.cuenta.cuenta_id, async (c) => (await c.query(`
    select m.codigo, m.nombre, m.nucleo, m.codigo in (select fn_modulos_habilitados($1)) as habilitado
      from modulo m where m.activo order by m.orden, m.codigo`, [req.params.negocio])).rows));
}));

r.put('/plataforma/negocios/:negocio/modulos', sesion, soloSuperadmin, a(async (req, res) => {
  const { modulo, habilitado } = req.body || {};
  await transaccion(req.cuenta.cuenta_id, (c) => uno(c, 'fn_plataforma_modulo_negocio($1, $2, $3, $4)',
    [req.cuenta.cuenta_id, req.params.negocio, modulo || '', habilitado === true]));
  res.status(204).end();
}));

// Más permisos para el dueño: extras de una barbería por vista. habilitada: true, false o null (restablecer).
r.put('/plataforma/negocios/:negocio/vistas', sesion, soloSuperadmin, a(async (req, res) => {
  const { modulo, vista, habilitada, hasta, nota } = req.body || {};
  await transaccion(req.cuenta.cuenta_id, (c) => uno(c, 'fn_plataforma_vista_negocio($1, $2, $3, $4, $5, $6, $7)',
    [req.cuenta.cuenta_id, req.params.negocio, modulo || '', vista || '', habilitada ?? null, hasta || null, nota || null]));
  res.status(204).end();
}));

module.exports = r;
