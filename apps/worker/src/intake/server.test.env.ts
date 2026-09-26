// Imported first by server.test.ts: importing server.ts pulls in @prava/db,
// which throws at module scope when DATABASE_URL is unset.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/sendit-test';
