-- Part 12 initial migration: enable the PostgreSQL extensions required by the
-- Notted schema. uuid-ossp backs application UUID helpers; vector backs the
-- embedding columns introduced in Part 18. Hand-written because drizzle-kit
-- does not emit CREATE EXTENSION; future schema migrations are generated.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
