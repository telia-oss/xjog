--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE TABLE "journalEntries" (
  "id" SERIAL PRIMARY KEY,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT transaction_timestamp(),

  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,

  -- Event that caused this transition, as serialized JSON
  "event" BYTEA,
  -- Full state as serialized JSON, but only mandatory for the first entry
  "state" BYTEA DEFAULT NULL,
  -- Context as serialized JSON,but only mandatory for the first entry
  "context" BYTEA DEFAULT NULL,

  -- Change set between this and previous entry, can be used for time travel
  "stateDelta" BYTEA NOT NULL,
  -- Change set between this and previous entry, can be used for time travel
  "contextDelta" BYTEA NOT NULL,

  -- Actions triggered by the transition
  "actions" BYTEA DEFAULT NULL
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "journalEntries";
