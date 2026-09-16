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
