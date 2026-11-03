-- Shipyard-Migration: expand
-- SHP-T-19.2 (SHP-ADR-013; SHP-REQ-209): when each failing container began failing, for Overview's
-- incident banners and the incident bundle. Additive only: one new table, nothing existing altered.

-- CreateTable
CREATE TABLE "container_condition" (
    "agent_id" UUID NOT NULL,
    "container_name" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "container_condition_pkey" PRIMARY KEY ("agent_id","container_name")
);

-- AddForeignKey
ALTER TABLE "container_condition" ADD CONSTRAINT "container_condition_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
