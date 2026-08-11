// AI Reports Frontend Logic

let aiReportsHistory = [];
let currentAiReport = null;

async function loadAiReportsHistory() {
    try {
        const res = await fetch('/api/analytics/ai-reports');
        if (res.ok) {
            aiReportsHistory = await res.json();
            renderAiReportsHistory();
        }
    } catch (e) {
        console.error('Failed to load AI reports history', e);
    }
}

function renderAiReportsHistory() {
    const container = document.getElementById('ai-reports-list');
    if (!container) return;
    
    if (aiReportsHistory.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-sm p-4 text-center">Nessun report generato.</p>';
        return;
    }
    
    container.innerHTML = aiReportsHistory.map(r => `
        <div class="p-4 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 flex justify-between items-center transition-colors">
            <div class="cursor-pointer flex-1" onclick="viewAiReport(${r.id})">
                <p class="font-bold text-slate-800 dark:text-slate-200">${new Date(r.date).toLocaleDateString()} ${new Date(r.date).toLocaleTimeString()}</p>
                <div class="flex gap-2 mt-1">
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold border border-slate-200 dark:border-slate-700">Risk: ${r.risk_score}/5</span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold border border-slate-200 dark:border-slate-700">Qualità: ${r.quality_score}/5</span>
                </div>
            </div>
            <button onclick="deleteAiReport(${r.id}, event)" class="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">
                <span class="material-symbols-outlined text-sm">delete</span>
            </button>
        </div>
    `).join('');
}

function openAiReportsHistory() {
    loadAiReportsHistory();
    document.getElementById('ai-reports-history-modal').classList.remove('hidden');
    document.getElementById('ai-reports-history-modal').classList.add('flex');
}

function closeAiReportsHistory() {
    document.getElementById('ai-reports-history-modal').classList.add('hidden');
    document.getElementById('ai-reports-history-modal').classList.remove('flex');
}

async function deleteAiReport(id, e) {
    e.stopPropagation();
    if (!confirm('Vuoi davvero eliminare questo report?')) return;
    try {
        const res = await fetch('/api/analytics/ai-reports/' + id, { method: 'DELETE' });
        if (res.ok) {
            loadAiReportsHistory();
        }
    } catch(err) {}
}

async function generateNewAiReport(btn) {
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[14px] animate-spin">refresh</span><span>Generazione...</span>';
    
    try {
        const contextData = JSON.stringify({
            assetGains: window.reportsData?.assetGains || [],
            annualGains: window.reportsData?.annualGains || {},
            dividends: window.reportsData?.dividends || []
        });
        if (window.refreshAiStatus) window.refreshAiStatus();
        
        const res = await fetch('/api/analytics/ai-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contextData })
        });
        
        if (res.ok) {
            const data = await res.json();
            await loadAiReportsHistory();
            viewAiReport(data.id || data);
        } else {
            alert('Errore durante la generazione del report.');
        }
    } catch(e) {
        alert('Errore di rete.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

function viewAiReport(idOrObj) {
    let report;
    if (typeof idOrObj === 'object' && idOrObj.data) {
        report = { ...idOrObj.data, pe_value: idOrObj.portfolioPE, date: idOrObj.date };
    } else {
        report = aiReportsHistory.find(r => r.id === idOrObj);
    }
    
    if (!report) return;
    currentAiReport = report;
    
    document.getElementById('ai-report-viewer-modal').classList.remove('hidden');
    document.getElementById('ai-report-viewer-modal').classList.add('flex');
    
    // Set KPIs
    document.getElementById('ai-score-risk').innerHTML = renderStars(report.risk_score);
    document.getElementById('ai-score-div').innerHTML = renderStars(report.diversification_score);
    document.getElementById('ai-score-alloc').innerHTML = renderStars(report.allocation_score);
    document.getElementById('ai-score-qual').innerHTML = renderStars(report.quality_score);
    
    if (report.pe_value) {
        document.getElementById('ai-pe-value').innerText = report.pe_value.toFixed(1);
    } else {
        document.getElementById('ai-pe-value').innerText = 'N/A';
    }
    
    // Render Markdown
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            breaks: true,
            gfm: true
        });
        let parsedHtml = marked.parse(report.markdown_content || '');
        // Aggiungi stili tailwind alle tabelle generate
        parsedHtml = parsedHtml.replace(/<table>/g, '<div class="overflow-x-auto my-4"><table class="w-full text-left border-collapse text-sm">');
        parsedHtml = parsedHtml.replace(/<thead>/g, '<thead class="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">');
        parsedHtml = parsedHtml.replace(/<th>/g, '<th class="p-3 border-b border-slate-200 dark:border-slate-700 font-bold">');
        parsedHtml = parsedHtml.replace(/<td/g, '<td class="p-3 border-b border-slate-100 dark:border-slate-800/50"');
        parsedHtml = parsedHtml.replace(/<h2>/g, '<h2 class="text-xl font-bold mt-6 mb-3 text-slate-800 dark:text-slate-100">');
        parsedHtml = parsedHtml.replace(/<h3>/g, '<h3 class="text-lg font-bold mt-4 mb-2 text-slate-700 dark:text-slate-200">');
        parsedHtml = parsedHtml.replace(/<ul>/g, '<ul class="list-disc pl-5 my-3 space-y-1 text-slate-600 dark:text-slate-400">');
        parsedHtml = parsedHtml.replace(/<p>/g, '<p class="my-2 text-slate-600 dark:text-slate-400 leading-relaxed">');
        parsedHtml = parsedHtml.replace(/<strong>/g, '<strong class="font-bold text-slate-900 dark:text-slate-100">');
        
        document.getElementById('ai-report-content').innerHTML = parsedHtml;
    } else {
        document.getElementById('ai-report-content').innerText = report.markdown_content || '';
    }
}

function closeAiReportViewer() {
    document.getElementById('ai-report-viewer-modal').classList.add('hidden');
    document.getElementById('ai-report-viewer-modal').classList.remove('flex');
}

function renderStars(score) {
    const s = parseInt(score) || 0;
    let html = '';
    for(let i=1; i<=5; i++) {
        if (i <= s) {
            html += '<span class="material-symbols-outlined text-amber-400 text-lg" style="font-variation-settings: \'FILL\' 1;">star</span>';
        } else {
            html += '<span class="material-symbols-outlined text-slate-200 dark:text-slate-700 text-lg">star</span>';
        }
    }
    return html;
}
