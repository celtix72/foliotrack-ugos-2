const fs = require('fs');
let code = fs.readFileSync('public/asset_chart_component.js', 'utf8');

// 1. Add Engine Tag logic
const oldHistoryRender = `
            listEl.innerHTML = history.map(item => {
                const date = new Date(item.created_at).toLocaleString();
                let actionColor = 'rgba(148,163,184,0.1)';`;

const newHistoryRender = `
            listEl.innerHTML = history.map(item => {
                const date = new Date(item.created_at).toLocaleString();
                let actionColor = 'rgba(148,163,184,0.1)';
                
                const engine = item.engine || 'X';
                let engineIcon = 'smart_toy';
                if (engine === 'Gemini') engineIcon = 'auto_awesome';
                else if (engine === 'Qwen') engineIcon = 'chat_spark';
                else if (engine === 'Agnes') engineIcon = 'psychiatry';
                else if (engine === 'OpenAI') engineIcon = 'data_exploration';
                else if (engine === 'X') engineIcon = 'close';
`;

code = code.replace(oldHistoryRender, newHistoryRender);

const oldDateHtml = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span style="font-size: 10px; font-weight: 900; color: #94a3b8; display: flex; align-items: center; gap: 4px;">
                                <span class="material-symbols-outlined" style="font-size: 14px;">calendar_today</span> \${date}
                            </span>
                            <div style="display: flex; gap: 8px; align-items: center;">`;

const newDateHtml = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 10px; font-weight: 900; color: #94a3b8; display: flex; align-items: center; gap: 4px;">
                                    <span class="material-symbols-outlined" style="font-size: 14px;">calendar_today</span> \${date}
                                </span>
                                <span style="font-size: 10px; font-weight: 900; color: #64748b; background: rgba(148,163,184,0.1); padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 3px;" title="Motore IA: \${engine}">
                                    <span class="material-symbols-outlined" style="font-size: 12px;">\${engineIcon}</span> \${engine}
                                </span>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">`;

code = code.replace(oldDateHtml, newDateHtml);

// 2. Fix the Detail Modal Parent Node
const oldModalTarget = `
            const target = document.getElementById('mobile-ui') || document.body;
            target.appendChild(detailModal);`;

const newModalTarget = `
            const target = document.body;
            target.appendChild(detailModal);`;

code = code.replace(oldModalTarget, newModalTarget);

fs.writeFileSync('public/asset_chart_component.js', code, 'utf8');
console.log('Patched asset_chart_component.js');
