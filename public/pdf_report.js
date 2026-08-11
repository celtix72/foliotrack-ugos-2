window.generateDetailedPDFReport = async function(buttonEl, mode = 'classic') {
    let originalText = '';
    if (buttonEl) {
        buttonEl.disabled = true;
        originalText = buttonEl.innerHTML;
        buttonEl.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> Generazione PDF...';
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'pt', 'a4'); // 'l' for landscape

        // Fetch Global Reports Data
        const reportsRes = await fetch('/api/analytics/reports?range=1Y');
        const reportsData = await reportsRes.json();

        // Fetch Portfolios
        const portfoliosRes = await fetch('/api/portfolios');
        const portfoliosData = await portfoliosRes.json();
        const portfolios = portfoliosData.portfolios || [];

        // Fetch details for each portfolio
        const portfolioDetailsList = [];
        for (const p of portfolios) {
            const detailRes = await fetch(`/api/portfolios/${p.id}`);
            const detailData = await detailRes.json();
            portfolioDetailsList.push({ portfolio: p, details: detailData });
        }

        // Fetch AI Report
        let aiReportText = '';
        if (mode === 'latest_ai' || mode === 'new_ai') {
            console.log(`[PDF Report] Initiating AI Report mode: ${mode}`);
            if (buttonEl) {
                buttonEl.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> Analisi IA in corso...';
            }
            try {
                if (mode === 'latest_ai') {
                    console.log('[PDF Report] Fetching latest saved AI report from /api/analytics/ai-report/latest');
                    const aiRes = await fetch('/api/analytics/ai-report/latest');
                    console.log('[PDF Report] GET latest response status:', aiRes.status);
                    if (aiRes.ok) {
                        const aiData = await aiRes.json();
                        console.log('[PDF Report] Latest AI report data:', aiData);
                        aiReportText = aiData.text || '';
                    } else {
                        const errBody = await aiRes.text();
                        console.error('[PDF Report] GET latest failed:', aiRes.status, errBody);
                    }
                } else if (mode === 'new_ai') {
                    console.log('[PDF Report] Requesting NEW AI report generation via POST /api/analytics/ai-report');
                    const contextData = JSON.stringify({
                        assetGains: reportsData.assetGains || [],
                        annualGains: reportsData.annualGains || {},
                        dividends: reportsData.dividends || []
                    });
                    if (window.refreshAiStatus) window.refreshAiStatus();
                    const aiRes = await fetch('/api/analytics/ai-report', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contextData })
                    });
                    console.log('[PDF Report] POST ai-report response status:', aiRes.status);
                    if (aiRes.ok) {
                        const aiData = await aiRes.json();
                        console.log(`[PDF Report] AI generation successful! Received ${aiData.text ? aiData.text.length : 0} chars.`);
                        aiReportText = aiData.text || '';
                        if (aiData.date) {
                            const dateStr = new Date(aiData.date).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                            const btnDownloadAi = document.getElementById('btn-download-ai');
                            const dateSpan = document.getElementById('ai-report-date');
                            if (btnDownloadAi && dateSpan) {
                                dateSpan.textContent = dateStr;
                                btnDownloadAi.classList.remove('hidden');
                            }
                        }
                    } else {
                        const errData = await aiRes.json().catch(async () => ({ error: await aiRes.text() }));
                        console.error('[PDF Report] POST ai-report error:', aiRes.status, errData);
                        const errMsg = errData.error || `Errore HTTP ${aiRes.status}`;
                        alert(`[Errore Report IA] ${errMsg}\n\nVerifica le impostazioni delle chiavi API nelle Impostazioni Amministratore.`);
                        aiReportText = `Errore durante la generazione IA: ${errMsg}`;
                    }
                }
            } catch (aiErr) {
                console.error('[PDF Report] Exception fetching AI report:', aiErr);
                alert(`[Errore Connessione IA] ${aiErr.message}`);
                aiReportText = `Errore di connessione: ${aiErr.message}`;
            }
            if (buttonEl) {
                buttonEl.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> Impaginazione PDF...';
            }
        }

        // --- PDF Generation Logic ---
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const marginLeft = 40;
        let startY = 40;

        const checkPageBreak = (neededHeight) => {
            if (startY + neededHeight > pageHeight - 40) {
                doc.addPage();
                startY = 40;
            }
        };

        if (mode === 'classic') {
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const marginLeft = 40;
        let startY = 40;

        const checkPageBreak = (neededHeight) => {
            if (startY + neededHeight > pageHeight - 40) {
                doc.addPage();
                startY = 40;
            }
        };

        const formatValue = (val) => {
            if (val === undefined || val === null || isNaN(val)) return '0';
            return Number(val).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        };

        const formatCurrency = (val) => {
            if (val === undefined || val === null || isNaN(val)) return '€ 0';
            return '€ ' + Number(val).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        };

        const formatPercent = (val) => {
            if (val === undefined || val === null || isNaN(val)) return '0,0%';
            return Number(val).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
        };

        // Header
        doc.setFontSize(22);
        doc.setFont("helvetica", "bold");
        doc.text('M2T - Portfolio Report', marginLeft, startY);
        
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        const dateStr = new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' });
        doc.text(`Generato il: ${dateStr}`, pageWidth - marginLeft - 150, startY);
        startY += 40;

        // Global Metrics Summary
        const metrics = reportsData.metrics || {};
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text('Performance Summary', marginLeft, startY);
        startY += 20;

        doc.autoTable({
            startY: startY,
            head: [['Total ROI', 'Total Gain', 'Sharpe Ratio', 'Miglior Asset']],
            body: [[
                metrics.totalROI !== undefined ? formatPercent(metrics.totalROI * 100) : 'N/A',
                metrics.totalGain !== undefined ? formatCurrency(metrics.totalGain) : 'N/A',
                metrics.sharpeRatio !== undefined ? Number(metrics.sharpeRatio).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A',
                metrics.bestAsset || 'N/A'
            ]],
            theme: 'striped',
            headStyles: { fillColor: [30, 41, 59] },
            margin: { left: marginLeft }
        });
        startY = doc.lastAutoTable.finalY + 30;
        checkPageBreak(50);

        // Portfolios Breakdown
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text('Breakdown per Portafoglio', marginLeft, startY);
        startY += 20;

        const pBreakdownBody = [];
        if (reportsData.performance && reportsData.performance.individual) {
            const ind = reportsData.performance.individual;
            for (const pid in ind) {
                const p = ind[pid];
                const pm = p.metrics || {};
                pBreakdownBody.push([
                    p.name,
                    formatCurrency(pm.currentValue || 0),
                    pm.totalROI !== undefined ? formatPercent(pm.totalROI * 100) : '0,0%',
                    pm.twr !== undefined ? formatPercent(pm.twr * 100) : '0,0%',
                    pm.xirr !== undefined ? formatPercent(pm.xirr * 100) : '0,0%'
                ]);
            }
        }

        doc.autoTable({
            startY: startY,
            head: [['Portafoglio', 'Valore Attuale (EUR)', 'ROI', 'TWR', 'XIRR']],
            body: pBreakdownBody,
            theme: 'grid',
            headStyles: { fillColor: [71, 85, 105] },
            margin: { left: marginLeft }
        });
        startY = doc.lastAutoTable.finalY + 30;

        // Asset Allocation
        if (reportsData.diversification) {
            checkPageBreak(60);

            doc.setFontSize(14);
            doc.setFont("helvetica", "bold");
            doc.text('Asset Allocation (Tipologia)', marginLeft, startY);
            startY += 20;

            const allocBody = [];
            const at = reportsData.diversification.assetType;
            let totalVal = Object.values(at).reduce((a, b) => a + b, 0);
            for (const [type, val] of Object.entries(at)) {
                allocBody.push([type, formatCurrency(val), totalVal > 0 ? formatPercent((val / totalVal) * 100) : '0,0%']);
            }
            allocBody.sort((a, b) => parseFloat(b[2].replace(',', '.')) - parseFloat(a[2].replace(',', '.')));

            doc.autoTable({
                startY: startY,
                head: [['Asset Type', 'Valore (EUR)', 'Peso %']],
                body: allocBody,
                theme: 'striped',
                headStyles: { fillColor: [99, 102, 241] },
                margin: { left: marginLeft }
            });
            startY = doc.lastAutoTable.finalY + 30;
        }

        // Owned Assets Detail
        doc.addPage();
        startY = 40;
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text('Dettaglio Asset Posseduti', marginLeft, startY);
        startY += 20;

        // Aggregate open positions across portfolios
        const allAssets = [];
        for (const p of portfolioDetailsList) {
            const pName = p.portfolio.name;
            const pCurr = p.portfolio.currency;
            if (p.details) {
                // Add Cash manually since it's not in holdings
                if (p.details.currentCash > 0) {
                    allAssets.push({
                        port: pName,
                        ticker: 'CASH',
                        name: 'Liquidità ' + pCurr,
                        type: 'Liquidity',
                        qty: p.details.currentCash,
                        price: 1,
                        unrealized: 0,
                        dividends: 0,
                        currency: pCurr
                    });
                }
                
                if (p.details.holdings) {
                    for (const h of p.details.holdings) {
                        let annualDividend = 0;
                        if (h.currentPrice && h.dividendYield) {
                            annualDividend = h.currentPrice * h.dividendYield * h.shares;
                        }
                        
                        allAssets.push({
                            port: pName,
                            ticker: h.ticker,
                            name: h.name,
                            type: h.type || 'Other',
                            qty: h.shares || 0,
                            price: h.currentPrice || 0,
                            unrealized: h.unrealizedGain || 0,
                            dividends: annualDividend,
                            currency: h.currency || pCurr
                        });
                    }
                }
            }
        }

        // Mapping for types to match user's requested grouping and names
        const typeMap = {
            'Liquidity': { name: "LIQUIDITA'", order: 1 },
            'Cash': { name: "LIQUIDITA'", order: 1 },
            'ETF Monetario': { name: "ETF MONETARIO", order: 2 },
            'Deposito Vincolato': { name: "CONTI DEPOSITO", order: 3 },
            'Bond': { name: "OBBLIGAZIONI", order: 4 },
            'ETF Obblig': { name: "OBBLIGAZIONI", order: 4 },
            'ETF Azionario': { name: "ETF AZIONARI", order: 5 },
            'Azioni': { name: "AZIONI", order: 6 },
            'Stock': { name: "AZIONI", order: 6 }
        };

        const getGroup = (type) => typeMap[type] || { name: type.toUpperCase(), order: 99 };

        // Group assets
        const groupedAssets = {};
        for (const a of allAssets) {
            const groupInfo = getGroup(a.type);
            const gName = groupInfo.name;
            if (!groupedAssets[gName]) groupedAssets[gName] = { order: groupInfo.order, assets: [] };
            groupedAssets[gName].assets.push(a);
        }

        const sortedGroups = Object.entries(groupedAssets).sort((a, b) => a[1].order - b[1].order);

        for (const [gName, group] of sortedGroups) {
            checkPageBreak(80);
            
            doc.setFontSize(12);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(50, 50, 50);
            doc.text(gName, marginLeft, startY);
            startY += 10;
            
            group.assets.sort((a, b) => b.unrealized - a.unrealized);

            const assetsBody = group.assets.map(a => [
                a.port,
                a.ticker,
                a.name,
                formatValue(a.qty),
                formatValue(a.price) + ' ' + a.currency,
                formatCurrency(a.unrealized),
                formatCurrency(a.dividends)
            ]);

            doc.autoTable({
                startY: startY,
                head: [['Portafoglio', 'Ticker', 'Nome', 'Quantità', 'Prezzo', 'Unrealized', 'Dividendi Previsti']],
                body: assetsBody,
                theme: 'grid',
                headStyles: { fillColor: [15, 23, 42] },
                styles: { fontSize: 8 },
                margin: { left: marginLeft }
            });
        }

        // ── 7. Analisi Fondamentale degli Asset (Yahoo Finance) ──────────────────
        const uniqueTickers = [...new Set(
            allAssets
                .filter(a => a.ticker && a.ticker !== 'CASH' && a.type !== 'Liquidity' && a.type !== 'Cash' && a.type !== 'Deposito Vincolato')
                .map(a => a.ticker)
        )];

        if (uniqueTickers.length > 0) {
            if (buttonEl) {
                buttonEl.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> Recupero Dati Fondamentali...';
            }
            
            const fundamentalsMap = {};
            await Promise.all(uniqueTickers.map(async (ticker) => {
                try {
                    const res = await fetch(`/api/fundamentals/${encodeURIComponent(ticker)}`);
                    if (res.ok) {
                        const data = await res.json();
                        fundamentalsMap[ticker] = data;
                    }
                } catch (err) {
                    console.error(`Error fetching fundamentals for ${ticker}:`, err);
                }
            }));

            doc.addPage();
            startY = 40;
            doc.setFontSize(14);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(15, 23, 42);
            doc.text('Analisi Fondamentale degli Asset (Yahoo Finance)', marginLeft, startY);
            startY += 20;

            const fundBody = [];
            for (const ticker of uniqueTickers) {
                const data = fundamentalsMap[ticker];
                if (!data) continue;
                
                const ks = data.keyStats || {};
                const sd = data.summaryDetail || {};
                const fd = data.financialData || {};
                
                const zScore = data.altmanZScore !== undefined && data.altmanZScore !== null ? `${data.altmanZScore.toFixed(2)} (${data.altmanZScoreZone})` : 'N/D';
                const ic = data.interestCoverageRatio !== undefined && data.interestCoverageRatio !== null ? (data.interestCoverageRatio === Infinity ? 'Infinity' : `${data.interestCoverageRatio.toFixed(1)}x`) : 'N/D';
                const netTang = data.netTangibleAssetsPerShare !== undefined && data.netTangibleAssetsPerShare !== null ? `${data.netTangibleAssetsPerShare.toFixed(2)}` : 'N/D';
                
                fundBody.push([
                    ticker,
                    data.name || 'N/D',
                    sd.trailingPE ? sd.trailingPE.toFixed(1) : 'N/D',
                    ks.forwardPE ? ks.forwardPE.toFixed(1) : 'N/D',
                    data.pegRatio ? data.pegRatio.toFixed(2) : 'N/D',
                    ks.priceToBook ? ks.priceToBook.toFixed(2) : 'N/D',
                    zScore,
                    ic,
                    netTang,
                    data.insiderSummary || 'N/D'
                ]);
            }

            doc.autoTable({
                startY: startY,
                head: [['Ticker', 'Nome', 'P/E Trail.', 'P/E Forw.', 'PEG', 'P/B', 'Altman Z-Score', 'Int. Coverage', 'Net Tang./Share', 'Insider Trading']],
                body: fundBody,
                theme: 'grid',
                headStyles: { fillColor: [79, 70, 229] }, // Indigo-600
                styles: { fontSize: 8 },
                margin: { left: marginLeft }
            });
            startY = doc.lastAutoTable.finalY + 30;
        }
        
        } else if (mode === 'latest_ai' || mode === 'new_ai') {
            // ==========================================
            // PROFESSIONAL AI REPORT LAYOUT
            // ==========================================
            doc.addPage();
            doc.deletePage(1); // Remove the initial blank page created by jsPDF constructor
            startY = 50;

            // BACKGROUND / HEADER
            doc.setFillColor(30, 41, 59); // slate-800
            doc.rect(0, 0, pageWidth, 120, 'F');
            
            doc.setFont("helvetica", "bold");
            doc.setFontSize(28);
            doc.setTextColor(255, 255, 255);
            doc.text("AI Portfolio Analysis", marginLeft, 60);
            
            doc.setFontSize(12);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(203, 213, 225); // slate-300
            const dateStr = new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' });
            doc.text(`Generated on ${dateStr} • FolioTrack Intelligence`, marginLeft, 80);
            
            startY = 160;

            // SNAPSHOT METRICS (ROI, Invested)
            let invested = 0;
            let currentVal = 0;
            let totalGain = 0;
            let totalDiv = 0;
            
            if (reportsData.assetGains) {
                reportsData.assetGains.forEach(a => {
                    invested += (a.totalInvested || 0);
                    currentVal += (a.currentValue || 0);
                    totalGain += (a.totalGain || 0);
                    totalDiv += (a.dividends || 0);
                });
            }

            const formatCurrency = (val) => '€ ' + Number(val).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            
            const printMetricBox = (x, y, w, h, label, value, valColor) => {
                doc.setDrawColor(226, 232, 240); // slate-200
                doc.setFillColor(248, 250, 252); // slate-50
                doc.roundedRect(x, y, w, h, 4, 4, 'FD');
                
                doc.setFontSize(10);
                doc.setTextColor(100, 116, 139); // slate-500
                doc.setFont("helvetica", "bold");
                doc.text(label, x + 10, y + 20);
                
                doc.setFontSize(16);
                doc.setTextColor(valColor[0], valColor[1], valColor[2]);
                doc.text(value, x + 10, y + 45);
            };

            const boxW = (pageWidth - (marginLeft * 2) - 30) / 4;
            printMetricBox(marginLeft, startY, boxW, 60, 'INVESTITO', formatCurrency(invested), [15, 23, 42]);
            printMetricBox(marginLeft + boxW + 10, startY, boxW, 60, 'VALORE ATTUALE', formatCurrency(currentVal), [15, 23, 42]);
            
            const gainColor = totalGain >= 0 ? [16, 185, 129] : [239, 68, 68];
            printMetricBox(marginLeft + (boxW * 2) + 20, startY, boxW, 60, 'GAIN TOTALE', formatCurrency(totalGain), gainColor);
            printMetricBox(marginLeft + (boxW * 3) + 30, startY, boxW, 60, 'DIVIDENDI', formatCurrency(totalDiv), [16, 185, 129]);
            
            startY += 90;

            // TRY TO EMBED CHARTS
            try {
                const addChart = (canvasId, title, x, w, h) => {
                    const canvas = document.getElementById(canvasId);
                    if (canvas) {
                        doc.setFontSize(12);
                        doc.setTextColor(15, 23, 42);
                        doc.setFont("helvetica", "bold");
                        doc.text(title, x, startY);
                        const imgData = canvas.toDataURL('image/png', 1.0);
                        // Add white background behind transparent canvas
                        doc.setFillColor(255, 255, 255);
                        doc.rect(x, startY + 10, w, h, 'F');
                        doc.addImage(imgData, 'PNG', x, startY + 10, w, h);
                        return true;
                    }
                    return false;
                };

                let chartAdded = false;
                const chartW = (pageWidth - (marginLeft * 2) - 20) / 2;
                if (addChart('performanceChart', 'Performance History', marginLeft, chartW, 140)) chartAdded = true;
                if (addChart('diversificationAssetChart', 'Asset Allocation', marginLeft + chartW + 20, chartW, 140)) chartAdded = true;
                
                if (chartAdded) {
                    startY += 180;
                }
            } catch (e) {
                console.warn('Could not embed charts in AI PDF', e);
            }

            // AI TEXT PARSING
            if (aiReportText) {
                checkPageBreak(50);
                
                doc.setFontSize(16);
                doc.setTextColor(79, 70, 229); // Indigo
                doc.setFont("helvetica", "bold");
                doc.text("AI Strategic Report", marginLeft, startY);
                startY += 25;
                
                const stripEmojis = (str) => {
                    if (!str) return '';
                    return str.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
                };

                const lines = aiReportText.split('\n');
                let tableMode = false;
                let tableRows = [];

                const renderTable = () => {
                    if (tableRows.length < 3) { tableMode = false; tableRows = []; return; }
                    const parseRow = (r) => r.split('|').map(s => stripEmojis(s.replace(/\*\*/g, '').trim())).filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
                    const head = [parseRow(tableRows[0])];
                    const body = tableRows.slice(2).map(parseRow).filter(r => r.length > 0 && r[0] !== '' && !r[0].match(/^---+$/));
                    if (body.length > 0) {
                        doc.autoTable({
                            startY: startY + 5,
                            head: head,
                            body: body,
                            theme: 'striped',
                            headStyles: { fillColor: [15, 23, 42] },
                            styles: { fontSize: 9 },
                            margin: { left: marginLeft }
                        });
                        startY = doc.lastAutoTable.finalY + 15;
                    }
                    tableMode = false;
                    tableRows = [];
                };
                
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i].trim();
                    
                    if (line.startsWith('|') && line.endsWith('|')) {
                        tableMode = true;
                        tableRows.push(line);
                        continue;
                    } else if (tableMode) {
                        renderTable();
                    }
                    
                    if (!line) {
                        startY += 8;
                        continue;
                    }
                    
                    checkPageBreak(25);
                    line = stripEmojis(line);
                    
                    // Header ##
                    if (line.startsWith('## ') || line.startsWith('### ')) {
                        startY += 10;
                        doc.setFontSize(14);
                        doc.setTextColor(15, 23, 42);
                        doc.setFont("helvetica", "bold");
                        const text = line.replace(/^#+\s/, '').replace(/\*\*/g, '');
                        doc.text(text, marginLeft, startY);
                        startY += 18;
                    } 
                    // Bullet or normal line
                    else {
                        const isBullet = line.startsWith('- ') || line.startsWith('* ');
                        const hasBold = line.includes('**');
                        
                        let text = isBullet ? line.substring(2).trim() : line;
                        text = text.replace(/\*\*/g, ''); 
                        
                        if (hasBold) {
                            // Highlight background
                            doc.setFillColor(241, 245, 249); 
                            const splitText = doc.splitTextToSize(text, pageWidth - (marginLeft * 2) - (isBullet ? 15 : 0));
                            const boxHeight = splitText.length * 14 + 6;
                            doc.rect(marginLeft - 4, startY - 10, pageWidth - (marginLeft * 2) + 8, boxHeight, 'F');
                            
                            doc.setTextColor(15, 23, 42);
                            doc.setFont("helvetica", "bold");
                        } else {
                            doc.setTextColor(51, 65, 85); 
                            doc.setFont("helvetica", "normal");
                        }
                        
                        const splitText = doc.splitTextToSize(text, pageWidth - (marginLeft * 2) - (isBullet ? 15 : 0));
                        for (let j = 0; j < splitText.length; j++) {
                            checkPageBreak(15);
                            if (isBullet && j === 0) {
                                doc.setFillColor(79, 70, 229);
                                doc.circle(marginLeft + 4, startY - 3, 2, 'F');
                            }
                            doc.text(splitText[j], marginLeft + (isBullet ? 12 : 0), startY);
                            startY += 14;
                        }
                        if (hasBold) startY += 4;
                    }
                }
                if (tableMode) {
                    renderTable();
                }
            } else {
                doc.setFontSize(10);
                doc.setTextColor(200, 0, 0);
                doc.text("Errore: Testo IA non disponibile.", marginLeft, startY);
            }
        }

        // Save
        const fileName = `M2T_Report_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(fileName);

    } catch (err) {
        console.error('Error generating PDF:', err);
        alert('Errore durante la generazione del report PDF.');
    } finally {
        if (buttonEl && originalText) {
            buttonEl.disabled = false;
            buttonEl.innerHTML = originalText;
        }
    }
};

// Check if we have an AI report saved and update UI
window.checkLatestAiReport = async function() {
    try {
        const res = await fetch('/api/analytics/ai-report/latest');
        if (res.ok) {
            const data = await res.json();
            if (data.date && data.text) {
                const dateStr = new Date(data.date).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                const btnDownloadAi = document.getElementById('btn-download-ai');
                const dateSpan = document.getElementById('ai-report-date');
                if (btnDownloadAi && dateSpan) {
                    dateSpan.textContent = dateStr;
                    btnDownloadAi.classList.remove('hidden');
                }
            }
        }
    } catch (e) {
        console.error('Error checking latest AI report:', e);
    }
};
