/**
 * Provider tokens for raw database dependencies.
 *
 * Application code should inject {@link DatabaseService} instead. These symbols
 * are referenced only by the database module wiring (to create the pool and the
 * Drizzle handle) and by the {@link DatabaseService} constructor. Keeping them
 * in a dedicated module avoids a circular import between the service and the
 * module that wires it.
 */
export const DATABASE_POOL = Symbol("DATABASE_POOL");

/**
 * Drizzle database handle bound to the Notted schema. Provided as a factory so
 * the handle is constructed exactly once and shared across the module.
 */
export const DATABASE = Symbol("DATABASE");
