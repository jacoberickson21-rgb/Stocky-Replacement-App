-- CreateTable
CREATE TABLE "FailureLog" (
    "id" SERIAL NOT NULL,
    "operation" TEXT NOT NULL,
    "itemLabel" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" INTEGER,

    CONSTRAINT "FailureLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FailureLog" ADD CONSTRAINT "FailureLog_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
