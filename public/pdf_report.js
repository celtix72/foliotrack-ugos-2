window.generateDetailedPDFReport = async function(buttonEl, mode = 'classic') {
    let originalText = '';
    if (buttonEl) {
        buttonEl.disabled = true;
        originalText = buttonEl.innerHTML;
        buttonEl.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> Generazione PDF...';
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'pt', 'a4'); // 'p' for portrait

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
            const formatNumber = (val, decimals = 2) => {
                if (val === undefined || val === null || isNaN(val)) return '0';
                return Number(val).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            };

            const formatCurrency = (val, decimals = 2) => {
                if (val === undefined || val === null || isNaN(val)) return '€ 0,00';
                const sign = val < 0 ? '-€ ' : '€ ';
                return sign + Math.abs(Number(val)).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            };

            const formatCurrencyShort = (val) => {
                if (val === undefined || val === null || isNaN(val)) return '€ 0';
                const sign = val < 0 ? '-€ ' : '€ ';
                return sign + Math.abs(Number(val)).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            };

            const formatAssetCurrency = (val, currency = 'EUR', decimals = 2) => {
                if (val === undefined || val === null || isNaN(val)) return '0,00';
                const symbol = currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : (currency === 'GBP' ? '£' : (currency || '€')));
                return symbol + ' ' + Number(val).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            };

            const formatPercent = (val, decimals = 1, showSign = true) => {
                if (val === undefined || val === null || isNaN(val)) return '0,0%';
                const num = Number(val);
                const sgn = (showSign && num > 0) ? '+' : '';
                return sgn + num.toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';
            };

            // ─── 1. TOP HEADER BANNER ──────────────────────────────────────────────
            doc.setFillColor(15, 23, 42); // slate-900
            doc.rect(0, 0, pageWidth, 75, 'F');
            
            doc.setFillColor(37, 99, 235); // blue-600 accent bar
            doc.rect(0, 72, pageWidth, 3, 'F');

            doc.setFont("helvetica", "bold");
            doc.setFontSize(20);
            doc.setTextColor(255, 255, 255);
            doc.text("FOLIOTRACK", marginLeft, 34);

            doc.setFontSize(10);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(148, 163, 184); // slate-400
            doc.text("Report Patrimoniale & Rendiconto Portafogli", marginLeft, 52);

            const dateStr = new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' });
            doc.setFontSize(9);
            doc.setTextColor(226, 232, 240); // slate-200
            doc.text(`Data: ${dateStr}`, pageWidth - marginLeft, 34, { align: 'right' });
            doc.text(`Portafogli Inclusi: ${portfolios.length}`, pageWidth - marginLeft, 52, { align: 'right' });

            startY = 95;

            // ─── 2. CALCULATE GLOBAL METRICS & AGGREGATE ASSETS ────────────────────
            let totalInvestedEUR = 0;
            let totalCurrentValEUR = 0;
            let totalCashEUR = 0;
            let totalEstimatedDividends = 0;
            let totalLatentMinusvalenze = 0;
            let totalEstimatedTaxes = 0;

            const allAssets = [];

            for (const pItem of portfolioDetailsList) {
                const p = pItem.portfolio || {};
                const pName = p.name || 'Portafoglio';
                const pCurr = p.currency || 'EUR';
                const rate = (p.totalValue > 0 && p.totalValueEUR > 0) ? (p.totalValue / p.totalValueEUR) : (pCurr === 'USD' ? 1.08 : 1);

                if (pItem.details) {
                    const cashVal = pItem.details.currentCash || 0;
                    if (cashVal > 0) {
                        const cashInEUR = cashVal / rate;
                        totalCashEUR += cashInEUR;
                        totalInvestedEUR += cashInEUR;
                        totalCurrentValEUR += cashInEUR;

                        allAssets.push({
                            portfolioName: pName,
                            ticker: 'CASH',
                            name: `Liquidità (${pCurr})`,
                            type: 'Liquidità',
                            qty: cashVal,
                            currency: pCurr,
                            pmcAssetCurr: 1,
                            valAcqEUR: cashInEUR,
                            valNowEUR: cashInEUR,
                            gainPct: 0,
                            gainAssolutoEUR: 0,
                            annualDividendEUR: 0
                        });
                    }

                    const holdings = pItem.details.holdings || [];
                    for (const h of holdings) {
                        if (h.shares <= 0) continue;
                        const qty = h.shares || 0;
                        const pmc = h.avgCostAssetCurr || (h.totalCostAssetCurr ? h.totalCostAssetCurr / qty : 0);
                        const valAcqEUR = h.totalCostInPCurr ? (h.totalCostInPCurr / rate) : ((pmc * qty) / rate);
                        const valNowEUR = h.currentValue ? (h.currentValue / rate) : ((h.currentPrice * qty) / rate);
                        const gainAssEUR = valNowEUR - valAcqEUR;
                        const gainPct = valAcqEUR > 0 ? (gainAssEUR / valAcqEUR) * 100 : 0;

                        totalInvestedEUR += valAcqEUR;
                        totalCurrentValEUR += valNowEUR;

                        let annualDivEUR = 0;
                        if (h.currentPrice && h.dividendYield) {
                            annualDivEUR = ((h.currentPrice * h.dividendYield * qty) / rate) || 0;
                            totalEstimatedDividends += annualDivEUR;
                        }

                        if (gainAssEUR > 0) {
                            const isBond = (h.type || '').toUpperCase().includes('BOND') || (h.type || '').toUpperCase().includes('OBBLIG') || (h.ticker || '').toUpperCase().startsWith('BTP') || (h.ticker || '').toUpperCase().startsWith('BOT');
                            totalEstimatedTaxes += gainAssEUR * (isBond ? 0.125 : 0.26);
                        } else if (gainAssEUR < 0) {
                            totalLatentMinusvalenze += Math.abs(gainAssEUR);
                        }

                        allAssets.push({
                            portfolioName: pName,
                            ticker: h.ticker,
                            name: h.name || h.ticker,
                            type: h.type || 'Other',
                            qty: qty,
                            currency: h.currency || pCurr,
                            pmcAssetCurr: pmc,
                            valAcqEUR: valAcqEUR,
                            valNowEUR: valNowEUR,
                            gainPct: gainPct,
                            gainAssolutoEUR: gainAssEUR,
                            annualDividendEUR: annualDivEUR
                        });
                    }
                }
            }

            const totalGainEUR = totalCurrentValEUR - totalInvestedEUR;
            const totalGainPct = totalInvestedEUR > 0 ? (totalGainEUR / totalInvestedEUR) * 100 : 0;

            // ─── 3. KPI SUMMARY CARDS (Top Grid) ───────────────────────────────────
            const kpiCardWidth = (pageWidth - (marginLeft * 2) - 30) / 4;
            const kpiCardHeight = 52;

            const drawKpiCard = (x, y, w, h, label, mainText, subText, subColor) => {
                doc.setDrawColor(226, 232, 240); // slate-200
                doc.setFillColor(248, 250, 252); // slate-50
                doc.roundedRect(x, y, w, h, 4, 4, 'FD');

                doc.setFontSize(7.5);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(100, 116, 139); // slate-500
                doc.text(label.toUpperCase(), x + 8, y + 14);

                doc.setFontSize(12.5);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(15, 23, 42); // slate-900
                doc.text(mainText, x + 8, y + 31);

                if (subText) {
                    doc.setFontSize(8);
                    doc.setFont("helvetica", "bold");
                    doc.setTextColor(subColor[0], subColor[1], subColor[2]);
                    doc.text(subText, x + 8, y + 44);
                }
            };

            const totalDividendsAllTime = reportsData?.metrics?.totalDividendsAllTime || (reportsData?.assetGains ? reportsData.assetGains.reduce((s, a) => s + (a.dividends || 0), 0) : 0);

            const gainColor = totalGainEUR >= 0 ? [16, 185, 129] : [239, 68, 68];
            drawKpiCard(marginLeft, startY, kpiCardWidth, kpiCardHeight, 'Patrimonio Netto', formatCurrencyShort(totalCurrentValEUR), `Valuta Base: EUR`, [100, 116, 139]);
            drawKpiCard(marginLeft + kpiCardWidth + 10, startY, kpiCardWidth, kpiCardHeight, 'Capitale Investito', formatCurrencyShort(totalInvestedEUR), `Costo di Carico`, [100, 116, 139]);
            drawKpiCard(marginLeft + (kpiCardWidth * 2) + 20, startY, kpiCardWidth, kpiCardHeight, 'Gain / Loss Totale', formatCurrencyShort(totalGainEUR), formatPercent(totalGainPct), gainColor);
            drawKpiCard(marginLeft + (kpiCardWidth * 3) + 30, startY, kpiCardWidth, kpiCardHeight, 'Dividendi Previsti', formatCurrencyShort(totalEstimatedDividends), `Proiezione Annua`, [16, 185, 129]);

            startY += kpiCardHeight + 18;

            // ─── 4. RIEPILOGO PORTAFOGLI TABLE ─────────────────────────────────────
            doc.setFontSize(11);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(15, 23, 42);
            doc.text("Riepilogo per Portafoglio", marginLeft, startY);
            startY += 10;

            const pTableBody = [];
            for (const pItem of portfolioDetailsList) {
                const p = pItem.portfolio || {};
                const d = pItem.details || {};
                const pValEUR = p.totalValueEUR || (d.totalValue || 0);
                const pCash = d.currentCash || 0;
                const pInvested = d.investedCapital || 0;
                const pGain = (d.totalGain !== undefined) ? d.totalGain : (pValEUR - pInvested);
                const pRoi = pInvested > 0 ? (pGain / pInvested) * 100 : (d.roi !== undefined ? d.roi * 100 : 0);
                const pColor = pGain >= 0 ? [16, 185, 129] : [239, 68, 68];

                pTableBody.push([
                    { content: p.name || 'Portafoglio', styles: { fontStyle: 'bold' } },
                    p.currency || 'EUR',
                    formatCurrency(pCash, 0),
                    formatCurrency(pInvested, 0),
                    { content: formatCurrency(pValEUR, 0), styles: { fontStyle: 'bold' } },
                    { content: formatCurrency(pGain, 0), styles: { fontStyle: 'bold', textColor: pColor } },
                    { content: formatPercent(pRoi, 1), styles: { fontStyle: 'bold', textColor: pColor } },
                    d.twr !== undefined ? formatPercent(d.twr * 100, 1) : 'N/D',
                    d.xirr !== undefined ? formatPercent(d.xirr * 100, 1) : 'N/D'
                ]);
            }

            doc.autoTable({
                startY: startY,
                head: [['Portafoglio', 'Valuta', 'Liquidità', 'Investito', 'Valore Attuale', 'Gain Assoluto', 'ROI', 'TWR', 'XIRR']],
                body: pTableBody,
                theme: 'grid',
                headStyles: { fillColor: [30, 41, 59], fontSize: 8, fontStyle: 'bold', halign: 'left' },
                styles: { fontSize: 7.5, cellPadding: 3.5, valign: 'middle' },
                columnStyles: {
                    0: { cellWidth: 105 },
                    1: { cellWidth: 35, halign: 'center' },
                    2: { cellWidth: 50, halign: 'right' },
                    3: { cellWidth: 55, halign: 'right' },
                    4: { cellWidth: 60, halign: 'right' },
                    5: { cellWidth: 60, halign: 'right' },
                    6: { cellWidth: 42, halign: 'right' },
                    7: { cellWidth: 42, halign: 'right' },
                    8: { cellWidth: 42, halign: 'right' }
                },
                margin: { left: marginLeft }
            });

            startY = doc.lastAutoTable.finalY + 18;

            // ─── 5. ASSET ALLOCATION & RISK DOUGHNUT CHART ─────────────────────────
            checkPageBreak(135);

            doc.setFontSize(11);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(15, 23, 42);
            doc.text("Allocazione Asset per Tipologia e Profilo di Rischio", marginLeft, startY);
            startY += 12;

            const getAssetCategory = (a) => {
                const tk = (a.ticker || '').toUpperCase();
                const tp = (a.type || '').toUpperCase();
                if (tk === 'CASH' || tk.startsWith('CASH_') || tp.includes('LIQUIDIT')) return 'Liquidità';
                if (tk.startsWith('CD_') || tp.includes('DEPOSITO') || tp === 'CONTO DEPOSITO' || tp.includes('DEPOSITO VINCOLATO')) return 'Conti Deposito';
                if (tk.startsWith('BP_') || tp.includes('POSTALE') || tp.includes('BUONO POSTALE') || tp.includes('BUONO FRUTTIFERO')) return 'Buoni Postali';
                if (tp.includes('MONETAR')) return 'ETF Monetari';
                if (tp.includes('BOND') || tp.includes('OBBLIGAZION') || tk.startsWith('BTP') || tk.startsWith('BOT')) return 'Obbligazioni';
                if (tp.includes('ETF')) return 'ETF Azionari';
                if (tp.includes('AZION') || tp.includes('STOCK') || tp.includes('EQUITY')) return 'Azioni';
                return 'Altro';
            };

            const allocationCategories = [
                { id: 'Liquidità', label: 'Liquidità', color: [22, 101, 52], order: 1, value: 0 },
                { id: 'Conti Deposito', label: 'Conti Deposito', color: [21, 128, 61], order: 2, value: 0 },
                { id: 'Buoni Postali', label: 'Buoni Postali', color: [16, 185, 129], order: 3, value: 0 },
                { id: 'ETF Monetari', label: 'ETF Monetari', color: [34, 197, 94], order: 4, value: 0 },
                { id: 'Obbligazioni', label: 'Obbligazioni & Bond', color: [234, 179, 8], order: 5, value: 0 },
                { id: 'ETF Azionari', label: 'ETF Azionari', color: [249, 115, 22], order: 6, value: 0 },
                { id: 'Azioni', label: 'Azioni', color: [239, 68, 68], order: 7, value: 0 },
                { id: 'Altro', label: 'Altro / Cripto', color: [139, 92, 246], order: 8, value: 0 }
            ];

            for (const a of allAssets) {
                const cat = getAssetCategory(a);
                const found = allocationCategories.find(c => c.id === cat) || allocationCategories.find(c => c.id === 'Altro');
                if (found) found.value += a.valNowEUR;
            }

            const activeAllocations = allocationCategories.filter(c => c.value > 0);
            const totalAllocValue = activeAllocations.reduce((sum, c) => sum + c.value, 0);

            if (totalAllocValue > 0) {
                const chartCenterX = marginLeft + 65;
                const chartCenterY = startY + 45;
                const outerRadius = 45;
                const innerRadius = 24;

                let currentAngle = -90;

                for (const item of activeAllocations) {
                    const sliceAngle = (item.value / totalAllocValue) * 360;
                    const endAngle = currentAngle + sliceAngle;
                    doc.setFillColor(...item.color);

                    for (let a = currentAngle; a < endAngle; a += 0.5) {
                        const r1 = a * Math.PI / 180;
                        const r2 = Math.min(a + 0.5, endAngle) * Math.PI / 180;
                        const x1 = chartCenterX + outerRadius * Math.cos(r1);
                        const y1 = chartCenterY + outerRadius * Math.sin(r1);
                        const x2 = chartCenterX + outerRadius * Math.cos(r2);
                        const y2 = chartCenterY + outerRadius * Math.sin(r2);
                        doc.triangle(chartCenterX, chartCenterY, x1, y1, x2, y2, 'F');
                    }
                    currentAngle = endAngle;
                }

                doc.setFillColor(255, 255, 255);
                doc.circle(chartCenterX, chartCenterY, innerRadius, 'F');

                doc.setFontSize(7.5);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(100, 116, 139);
                doc.text("TOTALE", chartCenterX, chartCenterY - 2, { align: 'center' });
                doc.setFontSize(8.5);
                doc.setTextColor(15, 23, 42);
                doc.text(formatCurrencyShort(totalAllocValue), chartCenterX, chartCenterY + 8, { align: 'center' });

                const legendX = chartCenterX + outerRadius + 30;
                let legendY = startY + 8;
                const colWidth = (pageWidth - marginLeft - legendX) / 2;

                activeAllocations.forEach((item, idx) => {
                    const col = idx % 2;
                    const row = Math.floor(idx / 2);
                    const curX = legendX + (col * colWidth);
                    const curY = legendY + (row * 20);

                    const pct = (item.value / totalAllocValue) * 100;

                    doc.setFillColor(...item.color);
                    doc.circle(curX + 4, curY + 2, 3.5, 'F');

                    doc.setFontSize(8);
                    doc.setFont("helvetica", "bold");
                    doc.setTextColor(15, 23, 42);
                    doc.text(item.label, curX + 11, curY + 4);

                    doc.setFont("helvetica", "normal");
                    doc.setTextColor(100, 116, 139);
                    doc.text(`${formatCurrencyShort(item.value)} (${formatPercent(pct, 1, false)})`, curX + 11, curY + 13);
                });

                startY += 105;
            }

            // ─── 6. DETTAGLIO ASSET POSSEDUTI (CATEGORIZZATI) ──────────────────────
            doc.addPage();
            startY = 40;

            doc.setFontSize(14);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(15, 23, 42);
            doc.text("Dettaglio Asset Posseduti", marginLeft, startY);
            
            doc.setFontSize(9);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(100, 116, 139);
            doc.text("Elenco posizioni raggruppate per tipologia con indicazione di PMC, Valore Acquisto e Valore Attuale", marginLeft, startY + 14);
            startY += 26;

            const groupedAssets = {};
            for (const cat of allocationCategories) {
                groupedAssets[cat.id] = [];
            }

            for (const a of allAssets) {
                const cat = getAssetCategory(a);
                if (!groupedAssets[cat]) groupedAssets[cat] = [];
                groupedAssets[cat].push(a);
            }

            for (const cat of allocationCategories) {
                const assets = groupedAssets[cat.id] || [];
                if (assets.length === 0) continue;

                assets.sort((a, b) => b.valNowEUR - a.valNowEUR);

                checkPageBreak(65);

                doc.setFontSize(11);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(...cat.color);
                doc.text(`• ${cat.label.toUpperCase()}`, marginLeft, startY);
                startY += 8;

                let catValAcq = 0;
                let catValNow = 0;

                const tableBody = assets.map(a => {
                    catValAcq += a.valAcqEUR;
                    catValNow += a.valNowEUR;

                    const rowGainColor = a.gainAssolutoEUR >= 0 ? [16, 185, 129] : [239, 68, 68];
                    return [
                        { content: `${a.ticker}\n${a.name}`, styles: { fontStyle: 'bold' } },
                        a.portfolioName,
                        formatNumber(a.qty, a.qty % 1 === 0 ? 0 : 2),
                        formatAssetCurrency(a.pmcAssetCurr, a.currency),
                        formatCurrency(a.valAcqEUR),
                        { content: formatCurrency(a.valNowEUR), styles: { fontStyle: 'bold' } },
                        { content: formatPercent(a.gainPct), styles: { fontStyle: 'bold', textColor: rowGainColor } },
                        { content: formatCurrency(a.gainAssolutoEUR), styles: { fontStyle: 'bold', textColor: rowGainColor } }
                    ];
                });

                const catGainAss = catValNow - catValAcq;
                const catGainPct = catValAcq > 0 ? (catGainAss / catValAcq) * 100 : 0;
                const catGainColor = catGainAss >= 0 ? [16, 185, 129] : [239, 68, 68];

                tableBody.push([
                    { content: `SUBTOTALE ${cat.label.toUpperCase()}`, colSpan: 4, styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatCurrency(catValAcq), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatCurrency(catValNow), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatPercent(catGainPct), styles: { fontStyle: 'bold', textColor: catGainColor, fillColor: [241, 245, 249] } },
                    { content: formatCurrency(catGainAss), styles: { fontStyle: 'bold', textColor: catGainColor, fillColor: [241, 245, 249] } }
                ]);

                doc.autoTable({
                    startY: startY,
                    head: [['Asset', 'Portafoglio', 'Qtà', 'PMC', 'Val.ACQ', 'Val.NOW', 'Gain %', 'Gain Assoluto']],
                    body: tableBody,
                    theme: 'grid',
                    headStyles: { fillColor: cat.color, fontSize: 8, fontStyle: 'bold' },
                    styles: { fontSize: 8, cellPadding: 3.5, valign: 'middle' },
                    columnStyles: {
                        0: { cellWidth: 120 },
                        1: { cellWidth: 65 },
                        2: { cellWidth: 40, halign: 'right' },
                        3: { cellWidth: 55, halign: 'right' },
                        4: { cellWidth: 60, halign: 'right' },
                        5: { cellWidth: 65, halign: 'right' },
                        6: { cellWidth: 48, halign: 'right' },
                        7: { cellWidth: 68, halign: 'right' }
                    },
                    margin: { left: marginLeft }
                });

                startY = doc.lastAutoTable.finalY + 16;
            }

            // ─── 7. GRAND TOTAL & FISCAL SUMMARY BOX ───────────────────────────────
            checkPageBreak(85);

            doc.setFillColor(15, 23, 42); // slate-900
            doc.roundedRect(marginLeft, startY, pageWidth - (marginLeft * 2), 70, 4, 4, 'F');

            doc.setTextColor(255, 255, 255);
            doc.setFontSize(10.5);
            doc.setFont("helvetica", "bold");
            doc.text('PATRIMONIO NETTO COMPLESSIVO', marginLeft + 14, startY + 22);

            doc.setFontSize(16);
            doc.text(formatCurrency(totalCurrentValEUR), pageWidth - marginLeft - 14, startY + 24, { align: 'right' });

            const sgn = totalGainEUR >= 0 ? '+' : '';
            doc.setFontSize(9);
            doc.setTextColor(203, 213, 225); // slate-300
            doc.text(`Capitale Investito: ${formatCurrency(totalInvestedEUR)}   |   Gain Totale: ${sgn}${formatCurrency(totalGainEUR)} (${sgn}${formatPercent(totalGainPct, 1, false)})   |   Dividendi Incassati: ${formatCurrency(totalDividendsAllTime)}`, marginLeft + 14, startY + 42);

            doc.setFontSize(8);
            doc.setTextColor(148, 163, 184); // slate-400
            doc.text(`Minusvalenze Latenti Potenziali: ${formatCurrency(totalLatentMinusvalenze)}   •   Stima Imposte Gain Latenti: ${formatCurrency(totalEstimatedTaxes)}`, marginLeft + 14, startY + 57);

            startY += 85;

            // ─── 8. ANALISI FONDAMENTALE (YAHOO FINANCE) SE PRESENTI ───────────────
            const uniqueTickers = [...new Set(
                allAssets
                    .filter(a => a.ticker && a.ticker !== 'CASH' && !a.ticker.startsWith('CD_') && !a.ticker.startsWith('BP_') && !['Liquidità', 'Conti Deposito', 'Buoni Postali'].includes(getAssetCategory(a)))
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
                            fundamentalsMap[ticker] = await res.json();
                        }
                    } catch (err) {
                        console.error(`Error fetching fundamentals for ${ticker}:`, err);
                    }
                }));

                const fundRows = [];
                for (const ticker of uniqueTickers) {
                    const data = fundamentalsMap[ticker];
                    if (!data) continue;

                    const ks = data.keyStats || {};
                    const sd = data.summaryDetail || {};

                    const zScore = data.altmanZScore !== undefined && data.altmanZScore !== null ? `${data.altmanZScore.toFixed(2)} (${data.altmanZScoreZone || ''})` : 'N/D';
                    const ic = data.interestCoverageRatio !== undefined && data.interestCoverageRatio !== null ? (data.interestCoverageRatio === Infinity ? 'Inf' : `${data.interestCoverageRatio.toFixed(1)}x`) : 'N/D';
                    const netTang = data.netTangibleAssetsPerShare !== undefined && data.netTangibleAssetsPerShare !== null ? `${data.netTangibleAssetsPerShare.toFixed(2)}` : 'N/D';

                    fundRows.push([
                        ticker,
                        data.name || ticker,
                        sd.trailingPE ? sd.trailingPE.toFixed(1) : 'N/D',
                        ks.forwardPE ? ks.forwardPE.toFixed(1) : 'N/D',
                        data.pegRatio ? data.pegRatio.toFixed(2) : 'N/D',
                        ks.priceToBook ? ks.priceToBook.toFixed(2) : 'N/D',
                        zScore,
                        ic,
                        netTang
                    ]);
                }

                if (fundRows.length > 0) {
                    doc.addPage();
                    startY = 40;

                    doc.setFontSize(14);
                    doc.setFont("helvetica", "bold");
                    doc.setTextColor(15, 23, 42);
                    doc.text("Analisi Fondamentale degli Asset (Yahoo Finance)", marginLeft, startY);

                    doc.setFontSize(9);
                    doc.setFont("helvetica", "normal");
                    doc.setTextColor(100, 116, 139);
                    doc.text("Indicatori finanziari, multipli di valutazione e indici di solidità patrimoniale", marginLeft, startY + 14);
                    startY += 26;

                    doc.autoTable({
                        startY: startY,
                        head: [['Ticker', 'Nome', 'P/E Trail.', 'P/E Forw.', 'PEG', 'P/B', 'Altman Z-Score', 'Int. Coverage', 'Net Tang./Share']],
                        body: fundRows,
                        theme: 'grid',
                        headStyles: { fillColor: [79, 70, 229], fontSize: 8, fontStyle: 'bold' },
                        styles: { fontSize: 7.5, cellPadding: 3.5, valign: 'middle' },
                        margin: { left: marginLeft }
                    });
                }
            }
        } else if (mode === 'balance_sheet') {
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
                return Number(val).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            };

            const formatCurrency = (val) => {
                if (val === undefined || val === null || isNaN(val)) return '€ 0';
                return '€ ' + Number(val).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            };
            
            const formatAssetCurrency = (val, currency) => {
                if (val === undefined || val === null || isNaN(val)) return '0';
                const sign = currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : (currency === 'GBP' ? '£' : currency));
                return sign + ' ' + Number(val).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            };

            const formatPercent = (val) => {
                if (val === undefined || val === null || isNaN(val)) return '0%';
                return Number(val).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + '%';
            };

            // Header
            doc.setFontSize(22);
            doc.setFont("helvetica", "bold");
            doc.text('M2T - Stato Patrimoniale', marginLeft, startY);
            
            doc.setFontSize(10);
            doc.setFont("helvetica", "normal");
            const dateStr = new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' });
            doc.text(`Generato il: ${dateStr}`, pageWidth - marginLeft - 150, startY);
            startY += 30;

            // Aggregation
            const aggregated = {};
            for (const pItem of portfolioDetailsList) {
                const p = pItem.portfolio;
                if (p && p.currentCash > 0) {
                    const cashTicker = 'CASH_' + p.currency;
                    if (!aggregated[cashTicker]) {
                        aggregated[cashTicker] = {
                            ticker: cashTicker,
                            name: `Liquidità (${p.currency})`,
                            type: 'Liquidità',
                            qty: 0,
                            totalCostEUR: 0,
                            currentValueEUR: 0,
                            totalCostAssetCurr: 0,
                            currency: p.currency,
                            portfolios: new Set()
                        };
                    }
                    aggregated[cashTicker].portfolios.add(p.name);
                    const rate = (p.totalValue > 0 && p.totalValueEUR > 0) ? (p.totalValue / p.totalValueEUR) : (p.currency === 'USD' ? 1.08 : 1);
                    const cashEUR = p.currentCash / rate;
                    
                    aggregated[cashTicker].qty += p.currentCash;
                    aggregated[cashTicker].currentValueEUR += cashEUR;
                    aggregated[cashTicker].totalCostEUR += cashEUR;
                    aggregated[cashTicker].totalCostAssetCurr += p.currentCash;
                }

                const holdings = pItem.details.holdings || [];
                for (const h of holdings) {
                    if (h.shares <= 0) continue;
                    if (!aggregated[h.ticker]) {
                        aggregated[h.ticker] = {
                            ticker: h.ticker,
                            name: h.name,
                            type: h.type || 'Altro',
                            qty: 0,
                            totalCostEUR: 0,
                            currentValueEUR: 0,
                            totalCostAssetCurr: 0,
                            currency: h.currency,
                            portfolios: new Set()
                        };
                    }
                    aggregated[h.ticker].portfolios.add(pItem.portfolio.name);
                    aggregated[h.ticker].qty += h.shares;
                    aggregated[h.ticker].currentValueEUR += h.currentValue || 0;
                    aggregated[h.ticker].totalCostEUR += h.totalCostInPCurr || 0;
                    aggregated[h.ticker].totalCostAssetCurr += (h.avgCostAssetCurr * h.shares) || 0;
                }
            }

            // Categorization
            const categories = {
                'Liquidità': [],
                'Conti Deposito': [],
                'ETF Monetari': [],
                'ETF Azionari': [],
                'Obbligazioni': [],
                'Azioni': [],
                'Altro': []
            };

            for (const key in aggregated) {
                const a = aggregated[key];
                const t = a.type.toLowerCase();
                
                a.pmcAssetCurr = a.qty > 0 ? (a.totalCostAssetCurr / a.qty) : 0;
                a.gainAssoluto = a.currentValueEUR - a.totalCostEUR;
                a.gainPct = a.totalCostEUR > 0 ? (a.gainAssoluto / a.totalCostEUR) * 100 : 0;

                if (t.includes('cash') || t.includes('liquidit')) {
                    categories['Liquidità'].push(a);
                } else if (t.includes('deposito')) {
                    categories['Conti Deposito'].push(a);
                } else if (t.includes('monetari')) {
                    categories['ETF Monetari'].push(a);
                } else if (t.includes('etf azionari') || (t.includes('etf') && !t.includes('obblig'))) {
                    categories['ETF Azionari'].push(a);
                } else if (t.includes('bond') || t.includes('obblig')) {
                    categories['Obbligazioni'].push(a);
                } else if (t.includes('azioni') || t.includes('stock')) {
                    categories['Azioni'].push(a);
                } else {
                    categories['Altro'].push(a);
                }
            }

            let grandTotalValue = 0;
            let grandTotalCost = 0;

            // Calculate Risk Allocation
            const riskSegments = [
                { id: 'liquidita', label: 'Liquidità/Cash', color: [22, 101, 52], value: 0 },
                { id: 'cd', label: 'Conti Deposito', color: [21, 128, 61], value: 0 },
                { id: 'etf_mon', label: 'ETF Monetario', color: [34, 197, 94], value: 0 },
                { id: 'obbligazioni', label: 'Obbligazioni', color: [234, 179, 8], value: 0 },
                { id: 'etf_az', label: 'ETF Azionari', color: [249, 115, 22], value: 0 },
                { id: 'azioni', label: 'Azioni', color: [239, 68, 68], value: 0 }
            ];
            let altroValue = 0;
            let totalValueForRisk = 0;

            for (const [catName, assets] of Object.entries(categories)) {
                for (const a of assets) {
                    if (a.currentValueEUR > 0) {
                        totalValueForRisk += a.currentValueEUR;
                        if (catName === 'Liquidità') riskSegments[0].value += a.currentValueEUR;
                        else if (catName === 'Conti Deposito') riskSegments[1].value += a.currentValueEUR;
                        else if (catName === 'ETF Monetari') riskSegments[2].value += a.currentValueEUR;
                        else if (catName === 'Obbligazioni') riskSegments[3].value += a.currentValueEUR;
                        else if (catName === 'ETF Azionari') riskSegments[4].value += a.currentValueEUR;
                        else if (catName === 'Azioni') riskSegments[5].value += a.currentValueEUR;
                        else altroValue += a.currentValueEUR;
                    }
                }
            }

            if (altroValue > 0) {
                riskSegments.push({ id: 'altro', label: 'Altro', color: [148, 163, 184], value: altroValue });
            }

            if (totalValueForRisk > 0) {
                doc.setFontSize(12);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(15, 23, 42); // slate-900
                doc.text("Allocazione per Rischio", marginLeft, startY);
                startY += 15;

                const centerX = marginLeft + 60;
                const centerY = startY + 50;
                const radius = 50;

                let startAngle = -90; // Start from top
                for (const seg of riskSegments) {
                    if (seg.value > 0) {
                        doc.setFillColor(...seg.color);
                        const sliceAngle = (seg.value / totalValueForRisk) * 360;
                        const endAngle = startAngle + sliceAngle;
                        
                        // Draw slice using small triangles
                        for (let a = startAngle; a < endAngle; a += 0.5) {
                            const rad1 = a * Math.PI / 180;
                            const rad2 = Math.min((a + 0.5), endAngle) * Math.PI / 180;
                            const x1 = centerX + radius * Math.cos(rad1);
                            const y1 = centerY + radius * Math.sin(rad1);
                            const x2 = centerX + radius * Math.cos(rad2);
                            const y2 = centerY + radius * Math.sin(rad2);
                            doc.triangle(centerX, centerY, x1, y1, x2, y2, 'F');
                        }
                        startAngle = endAngle;
                    }
                }

                // Legend
                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                
                let legendX = centerX + radius + 30;
                let legendY = startY + 10;
                
                for (const seg of riskSegments) {
                    if (seg.value > 0) {
                        const pctStr = formatPercent((seg.value / totalValueForRisk) * 100);
                        const text = `${seg.label}: ${pctStr}`;
                        
                        doc.setFillColor(...seg.color);
                        doc.circle(legendX + 2, legendY - 3, 3, 'F');
                        doc.setTextColor(15, 23, 42);
                        doc.text(text, legendX + 7, legendY);
                        legendY += 14;
                    }
                }
                
                startY += 110;
            }

            let estimatedTaxes = 0;
            let potentialMinusvalenze = 0;

            // Generate Tables
            for (const [catName, assets] of Object.entries(categories)) {
                if (assets.length === 0) continue;
                
                // Sort by current value
                assets.sort((a,b) => b.currentValueEUR - a.currentValueEUR);

                checkPageBreak(50);
                
                doc.setFontSize(14);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(30, 64, 175); // Blue-800
                doc.text(catName, marginLeft, startY);
                startY += 15;

                let catTotalValue = 0;
                let catTotalCost = 0;

                const tableBody = assets.map(a => {
                    catTotalValue += a.currentValueEUR;
                    catTotalCost += a.totalCostEUR;

                    if (a.gainAssoluto > 0) {
                        const taxRate = catName === 'Obbligazioni' ? 0.125 : 0.26;
                        estimatedTaxes += (a.gainAssoluto * taxRate);
                    } else if (a.gainAssoluto < 0) {
                        potentialMinusvalenze += Math.abs(a.gainAssoluto);
                    }
                    
                    const gainColor = a.gainAssoluto >= 0 ? [22, 163, 74] : [220, 38, 38];
                    const portsStr = Array.from(a.portfolios).join(', ');
                    return [
                        { content: `${a.ticker}\n${a.name}`, styles: { fontStyle: 'bold' } },
                        portsStr,
                        formatValue(a.qty),
                        formatAssetCurrency(a.pmcAssetCurr, a.currency),
                        formatCurrency(a.totalCostEUR),
                        { content: formatCurrency(a.currentValueEUR), styles: { fontStyle: 'bold' } },
                        { content: formatPercent(a.gainPct), styles: { textColor: gainColor } },
                        { content: formatCurrency(a.gainAssoluto), styles: { textColor: gainColor } }
                    ];
                });

                const catGain = catTotalValue - catTotalCost;
                const catGainPct = catTotalCost > 0 ? (catGain / catTotalCost) * 100 : 0;
                const catGainColor = catGain >= 0 ? [22, 163, 74] : [220, 38, 38];

                tableBody.push([
                    { content: 'TOTALE ' + catName.toUpperCase(), colSpan: 4, styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatCurrency(catTotalCost), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatCurrency(catTotalValue), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [15, 23, 42] } },
                    { content: formatPercent(catGainPct), styles: { fontStyle: 'bold', textColor: catGainColor, fillColor: [241, 245, 249] } },
                    { content: formatCurrency(catGain), styles: { fontStyle: 'bold', textColor: catGainColor, fillColor: [241, 245, 249] } }
                ]);

                grandTotalValue += catTotalValue;
                grandTotalCost += catTotalCost;

                doc.autoTable({
                    startY: startY,
                    head: [['Asset', 'Portafoglio', 'Qtà', 'PMC', 'Val.ACQ', 'Val.NOW', 'Gain %', 'Gain Assoluto']],
                    body: tableBody,
                    theme: 'grid',
                    headStyles: { fillColor: [59, 130, 246] }, // Blue-500
                    styles: { fontSize: 9, cellPadding: 4, valign: 'middle' },
                    columnStyles: {
                        0: { cellWidth: 125 },
                        1: { cellWidth: 65 },
                        2: { cellWidth: 35, halign: 'right' },
                        3: { cellWidth: 50, halign: 'right' },
                        4: { cellWidth: 60, halign: 'right' },
                        5: { cellWidth: 60, halign: 'right' },
                        6: { cellWidth: 50, halign: 'right' },
                        7: { cellWidth: 70, halign: 'right' }
                    },
                    margin: { left: marginLeft },
                    didDrawPage: function (data) {
                        startY = data.cursor.y;
                    }
                });
                startY = doc.lastAutoTable.finalY + 20;
            }

            // Grand Total
            checkPageBreak(90);
            
            doc.setFillColor(30, 58, 138); // Blue-900
            doc.rect(marginLeft, startY, pageWidth - (marginLeft * 2), 75, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(12);
            doc.text('PATRIMONIO NETTO COMPLESSIVO', marginLeft + 15, startY + 25);
            
            doc.setFontSize(20);
            doc.text(formatCurrency(grandTotalValue), pageWidth - marginLeft - 15, startY + 30, { align: 'right' });
            
            const grandGain = grandTotalValue - grandTotalCost;
            const grandGainPct = grandTotalCost > 0 ? (grandGain / grandTotalCost) * 100 : 0;
            const sign = grandGain >= 0 ? '+' : '';
            
            doc.setFontSize(10);
            doc.text(`Costo: ${formatCurrency(grandTotalCost)} | Gain: ${sign}${formatCurrency(grandGain)} (${sign}${formatPercent(grandGainPct)})`, pageWidth - marginLeft - 15, startY + 45, { align: 'right' });
            
            doc.setFontSize(9);
            doc.setTextColor(203, 213, 225); // slate-300
            doc.text(`Minusvalenze latenti: ${formatCurrency(potentialMinusvalenze)} | Tasse previste sui gain latenti: ${formatCurrency(estimatedTaxes)}`, pageWidth - marginLeft - 15, startY + 60, { align: 'right' });
            
            startY += 90;

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

            const formatCurrency = (val) => '€ ' + Number(val).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            
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

        // Running Page Numbers & Footer
        const pageCount = doc.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            
            // Skip footer on page 1 if AI header covers full top, but for classic and balance_sheet always draw
            doc.setDrawColor(226, 232, 240); // slate-200
            doc.setLineWidth(0.75);
            doc.line(marginLeft, pageHeight - 26, pageWidth - marginLeft, pageHeight - 26);
            
            doc.setFontSize(8);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(148, 163, 184); // slate-400
            doc.text("FolioTrack • Report Patrimoniale Riservato", marginLeft, pageHeight - 14);
            doc.text(`Pagina ${i} di ${pageCount}`, pageWidth - marginLeft, pageHeight - 14, { align: 'right' });
        }

        // Save
        let fileName = `Patrimonio_PDF_${new Date().toISOString().split('T')[0]}.pdf`;
        if (mode === 'balance_sheet') {
            fileName = `stato_patrimoniale_${new Date().toISOString().split('T')[0]}.pdf`;
        }
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
