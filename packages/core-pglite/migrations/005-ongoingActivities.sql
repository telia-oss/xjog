--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE TABLE "ongoingActivities" (
  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,

  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT transaction_timestamp(),

  PRIMARY KEY ("machineId", "chartId", "activityId")
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "ongoingActivities"; 