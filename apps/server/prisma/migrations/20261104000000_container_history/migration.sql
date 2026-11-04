-- Shipyard-Migration: expand
-- SHP-T-20.3 (SHP-ADR-013; SHP-REQ-222, SHP-REQ-223, SHP-REQ-224): container events kept 30 days and
-- 30-minute health buckets kept 7. Neither table has a column for probe or log output. Additive
-- only: two new tables, nothing existing altered.

-- CreateTable
CREATE TABLE "container_event" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "container_id" TEXT NOT NULL,
    "container_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "exit_code" INTEGER,
    "health" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "container_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_health" (
    "agent_id" UUID NOT NULL,
    "container_name" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(3) NOT NULL,
    "worst_health" TEXT NOT NULL,
    "failed_checks" INTEGER NOT NULL DEFAULT 0,
    "last_probe_start" TIMESTAMPTZ(3),

    CONSTRAINT "container_health_pkey" PRIMARY KEY ("agent_id","container_name","bucket_start")
);

-- CreateIndex
CREATE INDEX "container_event_agent_id_container_name_at_idx" ON "container_event"("agent_id", "container_name", "at");

-- CreateIndex
CREATE INDEX "container_event_at_idx" ON "container_event"("at");

-- CreateIndex
CREATE UNIQUE INDEX "container_event_agent_id_container_id_kind_at_key" ON "container_event"("agent_id", "container_id", "kind", "at");

-- CreateIndex
CREATE INDEX "container_health_bucket_start_idx" ON "container_health"("bucket_start");

-- AddForeignKey
ALTER TABLE "container_event" ADD CONSTRAINT "container_event_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_health" ADD CONSTRAINT "container_health_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
