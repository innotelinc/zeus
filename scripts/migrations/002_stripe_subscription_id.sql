-- Adds Stripe subscription ID tracking to users table
-- Enables real subscription cancellation via Stripe API

ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
