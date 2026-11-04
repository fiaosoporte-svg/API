const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL (revisa el archivo .env)');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_CONEXIONES || 10),
});

// Las funciones de la base usan nombres sin esquema: cada conexión trabaja dentro de barber.
pool.on('connect', (cliente) => cliente.query('set search_path to barber, extensions'));

/**
 * Ejecuta `trabajo(cliente)` en una transacción. Si hay cuenta, la deja como autora para la auditoría.
 * Las funciones que no lanzan error al fallar (login, unirse) confirman igual: así el conteo de intentos se guarda.
 */
async function transaccion(cuentaId, trabajo) {
  const cliente = await pool.connect();
  try {
    await cliente.query('begin');
    if (cuentaId) {
      await cliente.query("select set_config('barber.cuenta_id', $1, true)", [cuentaId]);
    }
    const resultado = await trabajo(cliente);
    await cliente.query('commit');
    return resultado;
  } catch (error) {
    await cliente.query('rollback').catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

/** Llama una función y devuelve su único valor: `uno(c, 'fn_x($1, $2)', [a, b])`. */
async function uno(cliente, llamada, parametros = []) {
  const { rows } = await cliente.query(`select ${llamada} as r`, parametros);
  return rows[0] ? rows[0].r : null;
}

module.exports = { pool, transaccion, uno };
