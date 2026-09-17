let pool;

export async function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL 未配置。请先创建 PostgreSQL 数据库并在本地 .env 中填写连接地址。');
  }
  if (!pool) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export async function query(text, params = []) {
  return (await getPool()).query(text, params);
}

export async function transaction(work) {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
