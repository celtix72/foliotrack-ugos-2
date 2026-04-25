import sqlite3
import json

db_path = "data/foliotrack.db"
try:
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT * FROM users")
    rows = c.fetchall()
    print(json.dumps(rows, indent=2))
except Exception as e:
    print(e)
