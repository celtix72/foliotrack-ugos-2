window.generateDetailedPDFReport = async function(buttonEl) {
    if (buttonEl) {
        buttonEl.disabled = true;
        const originalText = buttonEl.innerHTML;
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
                metrics.totalROI !== undefined ? (metrics.totalROI * 100).toFixed(2) + '%' : 'N/A',
                metrics.totalGain !== undefined ? '€ ' + metrics.totalGain.toFixed(2) : 'N/A',
                metrics.sharpeRatio !== undefined ? metrics.sharpeRatio.toFixed(2) : 'N/A',
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
                    '€ ' + (pm.currentValue || 0).toFixed(2),
                    pm.totalROI !== undefined ? (pm.totalROI * 100).toFixed(2) + '%' : '0%',
                    pm.twr !== undefined ? (pm.twr * 100).toFixed(2) + '%' : '0%',
                    pm.xirr !== undefined ? (pm.xirr * 100).toFixed(2) + '%' : '0%'
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
                allocBody.push([type, '€ ' + val.toFixed(2), totalVal > 0 ? ((val / totalVal) * 100).toFixed(1) + '%' : '0%']);
            }
            allocBody.sort((a, b) => parseFloat(b[2]) - parseFloat(a[2]));

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
        doc.text('Dettaglio Asset Posseduti (Posizioni Aperte)', marginLeft, startY);
        startY += 20;

        // Aggregate open positions across portfolios
        const allAssets = [];
        for (const p of portfolioDetailsList) {
            const pName = p.portfolio.name;
            const pCurr = p.portfolio.currency;
            if (p.details && p.details.holdings) {
                const divMap = {};
                if (p.details.dividends) {
                    for (const d of p.details.dividends) {
                        divMap[d.ticker] = (divMap[d.ticker] || 0) + d.amount;
                    }
                }
                for (const h of p.details.holdings) {
                    allAssets.push({
                        port: pName,
                        ticker: h.ticker,
                        name: h.name,
                        qty: h.shares || 0,
                        price: h.currentPrice || 0,
                        unrealized: h.unrealizedGain || 0,
                        dividends: divMap[h.ticker] || 0,
                        currency: h.currency || pCurr
                    });
                }
            }
        }

        allAssets.sort((a, b) => b.unrealized - a.unrealized); // sort by unrealized

        const assetsBody = allAssets.map(a => [
            a.port,
            a.ticker,
            a.name,
            a.qty.toFixed(4),
            `${a.price.toFixed(2)} ${a.currency}`,
            `€ ${a.unrealized.toFixed(2)}`,
            `€ ${a.dividends.toFixed(2)}`
        ]);

        doc.autoTable({
            startY: startY,
            head: [['Portafoglio', 'Ticker', 'Nome', 'Quantità', 'Prezzo', 'Unrealized (EUR)', 'Dividendi (EUR)']],
            body: assetsBody,
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42] },
            styles: { fontSize: 8 },
            margin: { left: marginLeft }
        });

        // Save
        const fileName = `M2T_Report_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(fileName);

    } catch (err) {
        console.error('Error generating PDF:', err);
        alert('Errore durante la generazione del report PDF.');
    } finally {
        if (buttonEl && buttonEl.innerHTML) {
            buttonEl.disabled = false;
            // Restore text by removing the spinner html, simplest way is to check class
            if (buttonEl.id === 'mob-pdf-btn') {
                buttonEl.innerHTML = '<span class="material-symbols-outlined">picture_as_pdf</span>';
            } else {
                buttonEl.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">picture_as_pdf</span> Scarica PDF';
            }
        }
    }
};
