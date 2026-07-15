const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// SSL activado para cualquier BD remota (Render, Supabase…); desactivado en local
const isRemoteDb = process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes('localhost') &&
  !process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false,
});

async function getDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const { runMigrations } = require('./migrate');
  await runMigrations(pool);
  return pool;
}

// Ejecuta una consulta de escritura (INSERT, UPDATE, DELETE)
// Convierte ? a $1, $2, ... para compatibilidad con el código existente
async function run(sql, params = []) {
  const pgSql = toPgParams(sql);
  await pool.query(pgSql, params);
}

// Devuelve todas las filas como array de objetos
async function all(sql, params = []) {
  const pgSql = toPgParams(sql);
  const result = await pool.query(pgSql, params);
  return result.rows;
}

// Devuelve solo la primera fila
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

// Convierte placeholders ? estilo SQLite a $1, $2, ... estilo PostgreSQL
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

module.exports = { getDb, run, get, all };
