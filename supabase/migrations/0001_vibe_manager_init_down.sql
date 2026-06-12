-- Down migration for 0001_vibe_manager_init.sql.
-- Destroys all vibe_manager state. The vector extension is left in place
-- (shared with other consumers of the database).
drop schema if exists vibe_manager cascade;
