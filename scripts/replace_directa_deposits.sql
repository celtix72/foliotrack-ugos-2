-- ==============================================================================
-- replace_directa_deposits.sql
-- Sostituisce nel database di FolioTrack tutti i depositi/conferimenti
-- per il portafoglio "DIRECTA" con i 14 conferimenti effettivi.
-- ==============================================================================

BEGIN TRANSACTION;

-- 1. Eliminazione dei vecchi movimenti di tipo DEPOSIT o CONFERIMENTO per DIRECTA
DELETE FROM transactions 
WHERE portfolioId = (SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1)
  AND (UPPER(type) IN ('DEPOSIT', 'DEPOSITO') OR notes LIKE '%conferimento%');

-- 2. Inserimento dei 14 conferimenti effettivi estratti dall'estratto conto Directa
INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount, notes, createdAt)
VALUES 
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2024-02-14', 1.0, 15000.0, 0.0, 0.0, 1.0, 15000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2024-02-14', 1.0, 5000.0,  0.0, 0.0, 1.0, 5000.0,  'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-03-07', 1.0, 2000.0,  0.0, 0.0, 1.0, 2000.0,  'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-04-01', 1.0, 5000.0,  0.0, 0.0, 1.0, 5000.0,  'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-04-09', 1.0, 10000.0, 0.0, 0.0, 1.0, 10000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-04-14', 1.0, 10000.0, 0.0, 0.0, 1.0, 10000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-05-30', 1.0, 5000.0,  0.0, 0.0, 1.0, 5000.0,  'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-06-13', 1.0, 15000.0, 0.0, 0.0, 1.0, 15000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-06-17', 1.0, 12000.0, 0.0, 0.0, 1.0, 12000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-07-24', 1.0, 15000.0, 0.0, 0.0, 1.0, 15000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-07-25', 1.0, 11600.0, 0.0, 0.0, 1.0, 11600.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-08-07', 1.0, 15000.0, 0.0, 0.0, 1.0, 15000.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2025-08-08', 1.0, 50715.0, 0.0, 0.0, 1.0, 50715.0, 'Conferimento con bonifico', datetime('now')),
  ((SELECT id FROM portfolios WHERE UPPER(name) = 'DIRECTA' LIMIT 1), 'DEPOSIT', 'CASH', '2026-06-23', 1.0, 5000.0,  0.0, 0.0, 1.0, 5000.0,  'Conferimento con bonifico', datetime('now'));

COMMIT;
