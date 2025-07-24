--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE TABLE "deferredEvents" (
  "id" SERIAL PRIMARY KEY,

  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,

  -- Id serialized as JSON value (number or string)
  "eventId" TEXT NOT NULL,
  -- Possible destination serialized as JSON value
  "eventTo" TEXT,

  -- SCXML event as mapped by XState
  "event" TEXT NOT NULL,

  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT transaction_timestamp(),
  -- Corresponds to SendActionObject's field delay
  "delay" BIGINT NOT NULL,
  -- Calculated due time
  "due" TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Id of the instance who's processing this event, or NULL if none
  "lock" TEXT
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "deferredEvents"; 