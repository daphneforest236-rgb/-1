import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './db.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');
const pool = await getPool();
await pool.query(sql);
console.log('Database schema is ready.');
await pool.end();
