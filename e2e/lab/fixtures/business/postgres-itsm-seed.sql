-- Continuous / general-business PostgreSQL fixture (idempotent).
-- Safe for Full E2E lab fixture DB; ownership tag continuous-e2e-lab.

CREATE TABLE IF NOT EXISTS continuous_itsm_tickets (
  id SERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  e2e_correlation_id TEXT NOT NULL,
  title TEXT,
  status TEXT,
  priority TEXT,
  requester TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  ordering_seq INT NOT NULL
);

DELETE FROM continuous_itsm_tickets WHERE e2e_correlation_id LIKE 'continuous-%';

INSERT INTO continuous_itsm_tickets
  (ticket_id, e2e_correlation_id, title, status, priority, requester, updated_at, ordering_seq)
VALUES
  ('TCK-100', 'continuous-itsm-ticket-100', 'Laptop request', 'open', 'low', 'user-001', '2026-09-11T00:00:00Z', 1),
  ('TCK-101', 'continuous-itsm-ticket-101', 'Access review', 'pending', 'medium', 'user-002', '2026-09-11T00:01:00Z', 2),
  ('TCK-102', 'continuous-itsm-ticket-102', 'Printer offline', 'resolved', 'low', 'user-003', '2026-09-11T00:02:00Z', 3);
