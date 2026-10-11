/**
 * FolioTrack - AI Analysis Professional PDF Generator & Markdown Engine
 * Eliminates character encoding issues, formats markdown tables,
 * guarantees perfect word-wrapping, and produces publication-quality reports.
 */
(function() {
    // ─── Character & Typography Sanitizer ────────────────────────────────────
    function sanitizeForPdf(str) {
        if (!str) return '';
        let s = String(str).normalize('NFC');

        // Number emojis
        s = s.replace(/1️⃣/g, '1.')
             .replace(/2️⃣/g, '2.')
             .replace(/3️⃣/g, '3.')
             .replace(/4️⃣/g, '4.')
             .replace(/5️⃣/g, '5.');

        // Convert specific financial / business emojis to semantic clean labels
        s = s.replace(/🏰/g, '')
             .replace(/🛡️?/g, '')
             .replace(/🔍/g, '')
             .replace(/💼/g, '')
             .replace(/🎯/g, '')
             .replace(/🚀/g, '')
             .replace(/💡/g, '')
             .replace(/💰/g, '')
             .replace(/📈/g, '')
             .replace(/📉/g, '')
             .replace(/📊/g, '')
             .replace(/🤖/g, '')
             .replace(/⭐|★/g, '*')
             .replace(/✔/g, '[OK]')
             .replace(/✖|✗/g, '[NO]')
             .replace(/❗/g, '[!]')
             .replace(/❓/g, '[?]')
             .replace(/⚠️?/g, '[AVVISO]')
             .replace(/✅/g, '[OK]')
             .replace(/❌/g, '[NO]')
             .replace(/👁️?/g, '[WATCHLIST]');

        // Ratings in tables or metrics
        s = s.replace(/🟢/g, '[FORTE]')
             .replace(/🟡/g, '[NEUTRO]')
             .replace(/🔴/g, '[CRITICO]');

        // Remove all remaining emojis and unicode symbols (standard helvetica WinAnsi can't render them)
        s = s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '');
        s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');

        // Typography replacements
        s = s.replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')   // Smart quotes
             .replace(/[\u2018\u2019\u201A\u0060\u00B4]/g, "'")   // Smart single quotes
             .replace(/[\u2013\u2014\u2212\u2012]/g, '-')         // Dashes and minus
             .replace(/[\u2022\u25AA\u25FE\u25CF\u2023\u25A0\u25A1\u25CB]/g, '-') // Bullets
             .replace(/\u2026/g, '...')                     // Ellipsis
             .replace(/[\u00A0\u2000-\u200B]/g, ' ')        // Non-breaking spaces
             .replace(/[\u2192\u21D2]/g, '->')              // Arrows
             .replace(/[\u2190\u21D0]/g, '<-')
             .replace(/\u00B7/g, '-')                      // Middle dot
             .replace(/€/g, 'EUR ')                        // Currency symbol to standard ASCII
             .replace(/™/g, '(TM)')
             .replace(/©/g, '(C)')
             .replace(/®/g, '(R)');

        return s.replace(/[ \t]+/g, ' ').trim();
    }

    async function ensureJsPdfLibs() {
        if (!window.jspdf) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
        if (!window.jspdf.jsPDF.API.autoTable) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
    }

    // ─── Markdown to PDF Rendering Engine ────────────────────────────────────
    function renderMarkdownToPdf(doc, markdownText, options = {}) {
        if (!doc || !markdownText) return options.startY || 50;

        let y = options.startY || 50;
        const margin = options.margin || 40;
        const pageW = options.pageW || doc.internal.pageSize.getWidth();
        const pageH = options.pageH || doc.internal.pageSize.getHeight();
        const contentW = options.contentW || (pageW - margin * 2);
        const bottomMargin = options.bottomMargin || 45;
        const fontSize = options.fontSize || 8.5;
        const lineHeight = options.lineHeight || 12.5;

        const C = options.colors || {
            primary: [67, 56, 202],       // Indigo 700
            primaryLight: [238, 242, 255],// Indigo 50
            dark: [15, 23, 42],           // Slate 900
            slate: [51, 65, 85],          // Slate 700
            muted: [100, 116, 139],       // Slate 500
            light: [148, 163, 184],       // Slate 400
            border: [226, 232, 240],      // Slate 200
            cardBg: [248, 250, 252],      // Slate 50
            emerald: [16, 185, 129],
            rose: [225, 29, 72],
            amber: [217, 119, 6]
        };

        function ensureSpace(needed) {
            if (typeof options.checkPageBreak === 'function') {
                options.checkPageBreak(needed);
            } else if (y + needed > pageH - bottomMargin) {
                doc.addPage();
                y = 45;
                if (typeof options.onNewPage === 'function') {
                    options.onNewPage(doc, y);
                }
            }
        }

        function renderFormattedParagraph(line, leftIndent = 0) {
            line = sanitizeForPdf(line);
            if (!line) { y += 4; return; }

            const startX = margin + leftIndent;
            const maxW = contentW - leftIndent;

            // Tokenize words with bold markers
            const tokens = [];
            const parts = line.split(/(\*\*[^*]+\*\*)/);
            for (const part of parts) {
                if (!part) continue;
                const isBold = /^\*\*/.test(part);
                const clean = part.replace(/\*\*/g, '');
                const words = clean.split(/\s+/).filter(w => w.length > 0);
                for (const w of words) {
                    tokens.push({ word: w, bold: isBold });
                }
            }

            if (tokens.length === 0) return;

            doc.setFontSize(fontSize);
            doc.setTextColor(...C.slate);
            ensureSpace(lineHeight);

            let curX = startX;
            for (let i = 0; i < tokens.length; i++) {
                const { word, bold } = tokens[i];
                doc.setFont('helvetica', bold ? 'bold' : 'normal');
                if (bold) doc.setTextColor(...C.dark);
                else doc.setTextColor(...C.slate);

                const wordW = doc.getTextWidth(word + ' ');

                if (curX > startX && curX + doc.getTextWidth(word) > pageW - margin) {
                    ensureSpace(lineHeight);
                    y += lineHeight;
                    curX = startX;
                }

                doc.text(word, curX, y);
                curX += wordW;
            }
            y += lineHeight;
        }

        function renderPdfTable(rows) {
            if (rows.length < 2) return;

            const rawParsed = rows.map(r => {
                const cells = r.split('|').map(c => c.trim());
                if (cells[0] === '') cells.shift();
                if (cells[cells.length - 1] === '') cells.pop();
                return cells;
            });

            const cleanRows = rawParsed.filter(cells => !cells.every(c => /^[-:\s]+$/.test(c)));
            if (cleanRows.length < 2) return;

            const head = [cleanRows[0].map(c => sanitizeForPdf(c.replace(/\*\*/g, '')))];
            const body = cleanRows.slice(1).map(row => row.map(c => sanitizeForPdf(c.replace(/\*\*/g, ''))));

            const numCols = head[0].length;
            let columnStyles = {};

            if (numCols === 4) {
                columnStyles = {
                    0: { cellWidth: contentW * 0.28, fontStyle: 'bold' },
                    1: { cellWidth: contentW * 0.18, halign: 'right' },
                    2: { cellWidth: contentW * 0.18, halign: 'center' },
                    3: { cellWidth: contentW * 0.36 }
                };
            } else if (numCols === 3) {
                columnStyles = {
                    0: { cellWidth: contentW * 0.30, fontStyle: 'bold' },
                    1: { cellWidth: contentW * 0.25, fontStyle: 'bold', halign: 'right' },
                    2: { cellWidth: contentW * 0.45 }
                };
            } else if (numCols === 2) {
                columnStyles = {
                    0: { cellWidth: contentW * 0.35, fontStyle: 'bold' },
                    1: { cellWidth: contentW * 0.65 }
                };
            }

            ensureSpace(45);

            doc.autoTable({
                startY: y,
                head: head,
                body: body,
                theme: 'striped',
                headStyles: {
                    fillColor: [30, 41, 59],
                    textColor: [255, 255, 255],
                    fontSize: 8,
                    fontStyle: 'bold',
                    cellPadding: { top: 5, bottom: 5, left: 6, right: 6 }
                },
                bodyStyles: {
                    fontSize: 7.5,
                    textColor: [30, 41, 59],
                    cellPadding: { top: 4.5, bottom: 4.5, left: 6, right: 6 },
                    lineColor: [226, 232, 240],
                    lineWidth: 0.5
                },
                alternateRowStyles: {
                    fillColor: [248, 250, 252]
                },
                columnStyles: columnStyles,
                margin: { left: margin, right: margin },
                tableWidth: contentW,
                didParseCell: function(data) {
                    if (data.section === 'body') {
                        const cellText = String(data.cell.raw || '');
                        if (cellText.includes('[FORTE]') || cellText.includes('[OK]')) {
                            data.cell.styles.textColor = [16, 185, 129];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (cellText.includes('[NEUTRO]')) {
                            data.cell.styles.textColor = [217, 119, 6];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (cellText.includes('[CRITICO]') || cellText.includes('[NO]')) {
                            data.cell.styles.textColor = [225, 29, 72];
                            data.cell.styles.fontStyle = 'bold';
                        }
                    }
                }
            });

            y = doc.lastAutoTable.finalY + 12;
        }

        const rawLines = String(markdownText).split(/\r?\n|\\n/);
        let inTable = false;
        let tableBuffer = [];

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i].trim();

            // Table row detection
            if (line.startsWith('|') && line.endsWith('|')) {
                if (!inTable) {
                    inTable = true;
                    tableBuffer = [];
                }
                tableBuffer.push(line);
                continue;
            } else if (inTable) {
                renderPdfTable(tableBuffer);
                inTable = false;
                tableBuffer = [];
            }

            if (!line) {
                y += 4;
                continue;
            }

            // Blockquote callout (e.g. > Nota operativa)
            if (line.startsWith('>')) {
                const quoteText = line.replace(/^>\s*/, '');
                const cleanQ = sanitizeForPdf(quoteText.replace(/\*\*/g, ''));
                const splitQ = doc.splitTextToSize(cleanQ, contentW - 24);
                const bH = splitQ.length * 11 + 10;

                ensureSpace(bH + 6);
                doc.setFillColor(248, 250, 252);
                doc.roundedRect(margin, y - 6, contentW, bH, 4, 4, 'F');
                doc.setFillColor(...C.primary);
                doc.roundedRect(margin, y - 6, 3.5, bH, 1, 1, 'F');

                doc.setFontSize(8);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(...C.slate);
                splitQ.forEach(ql => {
                    doc.text(ql, margin + 12, y + 4);
                    y += 11;
                });
                y += 6;
                continue;
            }

            // Horizontal rule ---
            if (/^[-*_]{3,}$/.test(line)) {
                ensureSpace(10);
                doc.setDrawColor(...C.border);
                doc.setLineWidth(0.5);
                doc.line(margin, y, pageW - margin, y);
                y += 8;
                continue;
            }

            // Heading 1 / 2 (##)
            const h2Match = line.match(/^#{1,2}\s+(.*)/);
            if (h2Match) {
                ensureSpace(24);
                const hText = sanitizeForPdf(h2Match[1].replace(/\*\*/g, ''));
                doc.setFontSize(11);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...C.dark);
                const wrappedH = doc.splitTextToSize(hText, contentW);
                wrappedH.forEach(hl => {
                    doc.text(hl, margin, y);
                    y += 13;
                });
                y += 4;
                continue;
            }

            // Heading 3 (###)
            const h3Match = line.match(/^#{3,4}\s+(.*)/);
            if (h3Match) {
                ensureSpace(24);
                const hText = sanitizeForPdf(h3Match[1].replace(/\*\*/g, ''));
                doc.setFontSize(9.5);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...C.primary);
                const wrappedH = doc.splitTextToSize(hText, contentW);
                wrappedH.forEach(hl => {
                    doc.text(hl, margin, y);
                    y += 12;
                });
                doc.setDrawColor(...C.border);
                doc.setLineWidth(0.5);
                doc.line(margin, y, margin + 100, y);
                y += 7;
                continue;
            }

            // Bullet point
            const bulletMatch = line.match(/^[-*]\s+(.*)/);
            if (bulletMatch) {
                ensureSpace(12);
                doc.setFillColor(...C.primary);
                doc.circle(margin + 4, y - 3, 1.5, 'F');
                renderFormattedParagraph(bulletMatch[1], 12);
                continue;
            }

            // Numbered list item
            const numMatch = line.match(/^(\d+)\.\s+(.*)/);
            if (numMatch) {
                ensureSpace(12);
                doc.setFontSize(8);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...C.primary);
                doc.text(`${numMatch[1]}.`, margin + 2, y);
                renderFormattedParagraph(numMatch[2], 14);
                continue;
            }

            // Standard paragraph
            renderFormattedParagraph(line);
        }

        if (inTable && tableBuffer.length > 0) {
            renderPdfTable(tableBuffer);
        }

        return y;
    }

    // ─── Single Asset & Asset History PDF Generator ──────────────────────────
    window.generateAssetAiPdf = async function(ticker, options = {}) {
        if (!ticker) return;
        await ensureJsPdfLibs();

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'pt', 'a4');
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 40;
        const contentW = pageW - margin * 2;

        const C = {
            primary: [67, 56, 202],       // Indigo 700
            primaryLight: [238, 242, 255],// Indigo 50
            dark: [15, 23, 42],           // Slate 900
            slate: [51, 65, 85],          // Slate 700
            muted: [100, 116, 139],       // Slate 500
            light: [148, 163, 184],       // Slate 400
            border: [226, 232, 240],      // Slate 200
            cardBg: [248, 250, 252],      // Slate 50
            emerald: [16, 185, 129],
            rose: [225, 29, 72],
            amber: [217, 119, 6],
            sky: [14, 165, 233]
        };

        // Fetch data if not supplied
        let history = options.history || [];
        let fundamentals = options.fundamentals || null;

        try {
            if (!history || history.length === 0) {
                const resH = await fetch('/api/assets/' + encodeURIComponent(ticker) + '/ai-history?t=' + Date.now());
                if (resH.ok) history = await resH.json();
            }
            if (!fundamentals) {
                const resF = await fetch('/api/fundamentals/' + encodeURIComponent(ticker) + '?t=' + Date.now());
                if (resF.ok) fundamentals = await resF.json();
            }
        } catch (e) {
            console.error('[AI PDF] Fetch error:', e);
        }

        // Filter valid analyses (ignore running or error unless specific analysis requested)
        if (options.historyId) {
            history = history.filter(h => h.id == options.historyId);
        } else if (options.mode === 'single' && history.length > 0) {
            history = [history[0]];
        } else {
            history = history.filter(h => h.status !== 'error' && h.status !== 'running' && h.status !== 'pending');
        }

        if (!history || history.length === 0) {
            alert('Nessuna analisi IA valida da esportare in PDF.');
            return;
        }

        let y = 50;

        function ensureSpace(needed) {
            if (y + needed > pageH - 45) {
                doc.addPage();
                y = 50;
            }
        }

        function formatVal(val, type = 'num', curr = 'EUR') {
            if (val === null || val === undefined || isNaN(val)) return 'N/D';
            if (type === 'percent') return `${val.toFixed(1)}%`;
            if (type === 'curr') {
                const abs = Math.abs(val);
                const str = abs >= 1e9 ? (val / 1e9).toFixed(2) + 'B' : (abs >= 1e6 ? (val / 1e6).toFixed(2) + 'M' : val.toFixed(2));
                return `${str} ${curr}`;
            }
            return val.toFixed(2);
        }

        // ─── Cover / Executive Header ────────────────────────────────────────
        doc.setFillColor(...C.primary);
        doc.roundedRect(margin, y, contentW, 6, 2, 2, 'F');
        y += 20;

        // Title and Ticker Header
        doc.setFontSize(20);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...C.dark);
        doc.text(`REPORT ANALISI FONDAMENTALE & IA`, margin, y);
        y += 18;

        const assetName = fundamentals?.assetName || fundamentals?.shortName || ticker;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...C.muted);
        doc.text(`Asset: ${ticker} (${assetName})   -   FolioTrack Investment Intelligence`, margin, y);
        y += 18;

        doc.setDrawColor(...C.border);
        doc.setLineWidth(0.75);
        doc.line(margin, y, pageW - margin, y);
        y += 16;

        // ─── Fundamental Metrics Boxes (If Available) ────────────────────────
        if (fundamentals) {
            const ks = fundamentals.keyStats || {};
            const sd = fundamentals.summaryDetail || {};
            const fd = fundamentals.financialData || {};
            const curr = fd.currency || sd.currency || 'USD';

            const boxW = (contentW - 20) / 3;
            const boxH = 115;
            const boxStartY = y;

            const drawMetricBox = (bx, bTitle, bItems, titleColor) => {
                doc.setFillColor(...C.cardBg);
                doc.setDrawColor(...C.border);
                doc.setLineWidth(0.5);
                doc.roundedRect(bx, boxStartY, boxW, boxH, 6, 6, 'FD');

                doc.setFontSize(8);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...titleColor);
                doc.text(bTitle.toUpperCase(), bx + 8, boxStartY + 14);

                let rY = boxStartY + 27;
                bItems.forEach(item => {
                    doc.setFontSize(7.5);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(...C.muted);
                    doc.text(item.label, bx + 8, rY);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(...C.dark);
                    doc.text(String(item.value), bx + boxW - 8, rY, { align: 'right' });
                    rY += 12;
                });
            };

            const valMetrics = [
                { label: 'P/E Trailing', value: formatVal(sd.trailingPE) },
                { label: 'P/E Forward', value: formatVal(ks.forwardPE) },
                { label: 'PEG Ratio', value: formatVal(fundamentals.pegRatio) },
                { label: 'Price / Book', value: formatVal(ks.priceToBook) },
                { label: 'EV / EBITDA', value: formatVal(ks.enterpriseToEbitda) },
                { label: 'EV / Revenue', value: formatVal(ks.enterpriseToRevenue) },
                { label: 'Beta (5Y)', value: formatVal(sd.beta) }
            ];

            const profitMetrics = [
                { label: 'Margine Lordo', value: formatVal(fd.grossMargins ? fd.grossMargins * 100 : null, 'percent') },
                { label: 'Margine Operativo', value: formatVal(fd.operatingMargins ? fd.operatingMargins * 100 : null, 'percent') },
                { label: 'Margine Netto', value: formatVal(fd.profitMargins ? fd.profitMargins * 100 : null, 'percent') },
                { label: 'ROE', value: formatVal(fd.returnOnEquity ? fd.returnOnEquity * 100 : null, 'percent') },
                { label: 'ROA', value: formatVal(fd.returnOnAssets ? fd.returnOnAssets * 100 : null, 'percent') },
                { label: 'Dividend Yield', value: formatVal(sd.dividendYield ? sd.dividendYield * 100 : null, 'percent') },
                { label: 'Analyst Target', value: formatVal(fd.targetMeanPrice, 'curr', curr) }
            ];

            const balanceMetrics = [
                { label: 'Liquidita Totale', value: formatVal(fd.totalCash, 'curr', curr) },
                { label: 'Debito Totale', value: formatVal(fd.totalDebt, 'curr', curr) },
                { label: 'Debt / Equity', value: formatVal(fd.debtToEquity) },
                { label: 'Current Ratio', value: formatVal(fd.currentRatio) },
                { label: 'Quick Ratio', value: formatVal(fd.quickRatio) },
                { label: 'Azioni in Circ.', value: ks.sharesOutstanding ? (ks.sharesOutstanding / 1e9).toFixed(2) + 'B' : 'N/D' },
                { label: 'Book Value/Share', value: formatVal(ks.bookValue, 'curr', curr) }
            ];

            drawMetricBox(margin, 'Multipli di Valutazione', valMetrics, C.primary);
            drawMetricBox(margin + boxW + 10, 'Redditivita e Margini', profitMetrics, C.emerald);
            drawMetricBox(margin + (boxW + 10) * 2, 'Bilancio e Solidita', balanceMetrics, C.amber);

            y += boxH + 16;

            // Historical Financials mini table
            if (fundamentals.historicalFinancials && fundamentals.historicalFinancials.length > 0) {
                ensureSpace(90);
                doc.setFontSize(8.5);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...C.dark);
                doc.text('STORICO FINANZIARIO ANNUALE (DATI DI BILANCIO)', margin, y);
                y += 6;

                const hHead = [['Anno', 'Ricavi Totali', 'Utile Netto', 'EPS', 'P/E']];
                const hBody = fundamentals.historicalFinancials.map(f => [
                    f.date ? String(f.date).substring(0, 4) : 'TTM',
                    formatVal(f.totalRevenue, 'curr', curr),
                    formatVal(f.netIncome, 'curr', curr),
                    formatVal(f.eps),
                    formatVal(f.pe)
                ]);

                doc.autoTable({
                    startY: y,
                    head: hHead,
                    body: hBody,
                    theme: 'striped',
                    headStyles: { fillColor: [30, 41, 59], fontSize: 7.5, cellPadding: 4 },
                    bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59], cellPadding: 3.5 },
                    margin: { left: margin, right: margin },
                    tableWidth: contentW
                });
                y = doc.lastAutoTable.finalY + 16;
            }
        }

        // ─── Iterate Analyses ────────────────────────────────────────────────
        history.forEach((h, hIdx) => {
            // New page for each subsequent analysis
            if (hIdx > 0 || fundamentals) {
                doc.addPage();
                y = 50;
            }

            const dObj = new Date(h.created_at || Date.now());
            const dateStr = dObj.toLocaleDateString('it-IT') + ' ' + dObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Card Header Bar
            doc.setFillColor(...C.cardBg);
            doc.setDrawColor(...C.border);
            doc.setLineWidth(0.5);
            doc.roundedRect(margin, y, contentW, 40, 6, 6, 'FD');

            // Action Badge
            const act = (h.action || 'HOLD').toUpperCase();
            let actBg = C.muted;
            if (act === 'BUY' || act === 'INC' || act === 'INCREASE') actBg = C.emerald;
            else if (act === 'SELL' || act === 'DEC' || act === 'DECREASE') actBg = C.rose;
            else if (act === 'WATCHLIST') actBg = [139, 92, 246];
            else if (act === 'AVOID') actBg = C.amber;

            doc.setFillColor(...actBg);
            doc.roundedRect(margin + 8, y + 10, 60, 20, 4, 4, 'F');
            doc.setFontSize(8.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(255, 255, 255);
            doc.text(act, margin + 38, y + 23, { align: 'center' });

            // Strategy and Model info
            let eng = h.engine || 'N/D';
            if (eng.includes('/')) eng = eng.split('/').pop().replace(':free', '');
            const pType = (h.prompt_type || 'VALUE').toUpperCase();

            doc.setFontSize(8.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...C.dark);
            doc.text(`Analisi ${pType}  -  Modello: ${eng}`, margin + 78, y + 19);

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(...C.muted);
            doc.text(`Eseguita il: ${dateStr}`, margin + 78, y + 30);

            // Metrics bar (Target / Stop Loss)
            if (h.targetPrice || h.stopLoss || h.asset_price) {
                const pParts = [];
                if (h.asset_price) pParts.push(`Prezzo Analisi: EUR ${parseFloat(h.asset_price).toFixed(2)}`);
                if (h.targetPrice) pParts.push(`Target FV: EUR ${parseFloat(h.targetPrice).toFixed(2)}`);
                if (h.stopLoss) pParts.push(`Stop Loss: EUR ${parseFloat(h.stopLoss).toFixed(2)}`);
                doc.text(pParts.join('   |   '), pageW - margin - 10, y + 24, { align: 'right' });
            }

            y += 52;

            // Render Markdown Reasoning Content with shared engine
            y = renderMarkdownToPdf(doc, h.reasoning || '', {
                startY: y,
                margin: margin,
                pageW: pageW,
                pageH: pageH,
                contentW: contentW,
                bottomMargin: 45,
                colors: C,
                ensureSpace: ensureSpace
            });
        });

        // ─── Two-Pass Professional Header & Footer on All Pages ──────────────
        const totalPages = doc.getNumberOfPages();
        const dateGen = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });

        for (let i = 1; i <= totalPages; i++) {
            doc.setPage(i);

            // Top Running Header
            doc.setFillColor(248, 250, 252);
            doc.rect(0, 0, pageW, 28, 'F');
            doc.setDrawColor(...C.border);
            doc.setLineWidth(0.5);
            doc.line(0, 28, pageW, 28);

            doc.setFontSize(7.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...C.primary);
            doc.text(`FolioTrack   -   Analisi Strategica: ${ticker}`, margin, 18);

            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...C.light);
            doc.text(`Pagina ${i} di ${totalPages}`, pageW - margin, 18, { align: 'right' });

            // Bottom Running Footer
            doc.setDrawColor(...C.border);
            doc.setLineWidth(0.5);
            doc.line(margin, pageH - 24, pageW - margin, pageH - 24);

            doc.setFontSize(7);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...C.light);
            doc.text(`Documento informativo generato da FolioTrack il ${dateGen}`, margin, pageH - 12);
            doc.text('Uso personale riservato', pageW - margin, pageH - 12, { align: 'right' });
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        doc.save(`IA_${ticker}_${dateStr}.pdf`);
    };

    // Wrapper for single analysis export from detail modal
    window.downloadSingleAssetAiPdf = function(ticker, action, encodedReasoning, date) {
        let reasoning = '';
        try { reasoning = decodeURIComponent(encodedReasoning); } catch(e) { reasoning = encodedReasoning; }
        const item = {
            ticker: ticker,
            action: action,
            reasoning: reasoning,
            created_at: date || new Date().toISOString()
        };
        window.generateAssetAiPdf(ticker, { mode: 'single', history: [item] });
    };

    // Expose utility functions for other modules (e.g. portfolio AI report)
    window.FolioTrackPdfUtils = {
        sanitizeForPdf: sanitizeForPdf,
        renderMarkdownToPdf: renderMarkdownToPdf,
        ensureJsPdfLibs: ensureJsPdfLibs
    };
})();
