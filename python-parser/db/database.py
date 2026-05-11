import os
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, JSON, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Service degrades gracefully when DATABASE_URL is absent (skips profile lookups).
_engine = None
SessionLocal = None

if DATABASE_URL:
    _engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)

Base = declarative_base()


class Vendor(Base):
    __tablename__ = "Vendor"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)


class VendorProfile(Base):
    __tablename__ = "VendorProfile"

    id = Column(String, primary_key=True)
    vendorId = Column(Integer, nullable=False, unique=True)
    columnMappings = Column(JSON, nullable=False)
    extractionHints = Column(JSON, nullable=True)
    createdAt = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updatedAt = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
