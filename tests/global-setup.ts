/**
 * Vitest global setup (runs once, in its own process): create the eden_test database if
 * missing and bring its schema to head with the checked-in drizzle migrations.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { adminDatabaseUrl, testDatabaseUrl, TEST_DB_NAME } from "./env";

export default async function setup() {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${TEST_DB_NAME}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${TEST_DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }

  const client = postgres(testDatabaseUrl(), { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
