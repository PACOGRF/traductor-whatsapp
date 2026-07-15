const fs = require('fs');
const path = require('path');

// Aplica en orden los archivos migrations/*.sql que aún no se hayan ejecutado.
// Cada migración corre dentro de una transacción: o se aplica entera o no se aplica.
async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const dir = path.join(__dirname, '../../migrations');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (done.rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('✅ Migración aplicada: ' + file);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error en migración ' + file + ': ' + err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };
