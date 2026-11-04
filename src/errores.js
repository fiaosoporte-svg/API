// Convierte los errores de la base (raise exception ... using errcode) en respuestas HTTP claras.
const POR_CODIGO = {
  '28000': 401, // invalid_authorization_specification: sesión vencida
  '28P01': 400, // invalid_password
  '42501': 403, // insufficient_privilege
  P0002: 404, // no_data_found
  '23505': 409, // unique_violation
  '23514': 422, // check_violation
  '22023': 422, // invalid_parameter_value
  '22P02': 422, // dato con formato inválido (p. ej. uuid)
  '54000': 429, // program_limit_exceeded: demasiados intentos
};

class ErrorApi extends Error {
  constructor(estado, mensaje, codigo) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}

function manejarErrores(error, _req, res, _next) {
  if (error instanceof ErrorApi) {
    return res.status(error.estado).json({ error: error.message, codigo: error.codigo });
  }
  const estado = POR_CODIGO[error.code];
  if (estado) {
    // Mensajes escritos para el usuario final en la propia base. HINT 'CAMBIAR_CLAVE' = debe cambiar la contraseña.
    return res.status(estado).json({ error: error.message, codigo: error.hint || error.code });
  }
  console.error(error);
  return res.status(500).json({ error: 'Ocurrió un error inesperado. Intenta de nuevo.' });
}

module.exports = { ErrorApi, manejarErrores };
