-- Ridge Quest: forgot-password support for player_account. Same
-- token-hash + expiry shape as user_account's existing invite_token/
-- invite_expires (migrations/0006_users_projects.sql) — reusing that
-- proven pattern rather than inventing a new one.
ALTER TABLE player_account ADD COLUMN reset_token TEXT;
ALTER TABLE player_account ADD COLUMN reset_expires INTEGER;
