--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------


CREATE TABLE "fullJournalStates" (
  "id" BIGINT,
  "created" TIMESTAMP WITH TIME ZONE NOT NULL,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,

  "ownerId" TEXT,
  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,
  "parentMachineId" TEXT,
  "parentChartId" TEXT,

  -- Event that caused this transition, as serialized JSON
  "event" BYTEA DEFAULT NULL,

  -- Full state as serialized JSON, but only mandatory for the first entry
  "state" BYTEA DEFAULT NULL,
  -- Context as serialized JSON,but only mandatory for the first entry
  "context" BYTEA DEFAULT NULL,

  -- Actions triggered by the transition
  "actions" BYTEA DEFAULT NULL,

  PRIMARY KEY("machineId", "chartId")
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "fullJournalStates";

