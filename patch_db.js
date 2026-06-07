const fs = require('fs');

let dbCode = fs.readFileSync('src/db.js', 'utf8');

const migrationScript = `    // Migration: Add ai_engine to assets
    try {
        dbConnection.prepare(\`ALTER TABLE assets ADD COLUMN ai_engine TEXT\`).run();
    } catch (e) {}

    // Backfill ai_engine based on ai_reasoning for existing assets
    try {
        const assetsWithoutEngine = dbConnection.prepare("SELECT ticker, ai_reasoning FROM assets WHERE ai_engine IS NULL AND ai_reasoning IS NOT NULL AND ai_reasoning != ''").all();
        const updateEngine = dbConnection.prepare("UPDATE assets SET ai_engine = ? WHERE ticker = ?");
        
        dbConnection.transaction(() => {
            for (const asset of assetsWithoutEngine) {
                const reasoning = asset.ai_reasoning.toUpperCase();
                let engine = null;
                if (reasoning.includes('ANALISI PRODOTTA DA GEMINI')) engine = 'Gemini';
                else if (reasoning.includes('ANALISI PRODOTTA DA QWEN')) engine = 'Qwen';
                else if (reasoning.includes('ANALISI PRODOTTA DA AGNES')) engine = 'Agnes';
                else if (reasoning.includes('ANALISI PRODOTTA DA OPENAI')) engine = 'OpenAI';
                else if (reasoning.includes('ANALISI TRAMITE GEMINI')) engine = 'Gemini'; // older versions
                
                if (engine) {
                    updateEngine.run(engine, asset.ticker);
                } else {
                    // Default fallback or leave NULL if undeducible
                    updateEngine.run('X', asset.ticker);
                }
            }
        })();
    } catch (e) {
        console.error("Migration error for ai_engine:", e);
    }
`;

// Insert the migration just after the `ai_updated_at` migration
dbCode = dbCode.replace(
    "dbConnection.prepare(`ALTER TABLE assets ADD COLUMN ai_updated_at DATETIME`).run();\n    } catch (e) {}",
    "dbConnection.prepare(`ALTER TABLE assets ADD COLUMN ai_updated_at DATETIME`).run();\n    } catch (e) {}\n\n" + migrationScript
);

fs.writeFileSync('src/db.js', dbCode, 'utf8');
