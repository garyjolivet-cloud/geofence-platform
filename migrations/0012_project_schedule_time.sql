-- Separate column for time-of-day, kept apart from scheduled_date because
-- field-recorder.html parses scheduled_date as a bare YYYY-MM-DD string
-- (new Date(p.scheduled_date+"T12:00:00")) -- overloading it with a full
-- datetime would silently break that parsing.
ALTER TABLE project ADD COLUMN scheduled_time TEXT;
