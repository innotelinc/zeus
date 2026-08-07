-- Migration 003: Add scheduled_at for fax scheduling
ALTER TABLE faxes ADD COLUMN scheduled_at TEXT;
