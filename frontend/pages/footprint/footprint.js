/* =============================================================
   HYPERFLOW — Footprint Renderer (pure drawing, no state)
   Called by chartwindow.js via FP.render(ctx)
   ============================================================= */

window.FP = (() => {

  const fmtVol = v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(1);
  const fmtTime = ms => {
    const d = new Date(ms);
    return d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0') + ':' +
           d.getSeconds().toString().padStart(2,'0');
  };

  function lvTotal(lv) {
    if (!lv) return 0;
    return lv.total !== undefined ? lv.total : (lv.bid_vol || 0) + (lv.ask_vol || 0);
  }

  // Cluster levels clamped to candle range
  function clusterLevels(levels, candleHigh, candleLow, tickSize, n) {
    if (n <= 1) return levels;
    const ts  = tickSize || 1;
    const out = {};
    for (const [k, lv] of Object.entries(levels)) {
      const price   = parseFloat(k);
      const clamped = Math.min(Math.max(price, candleLow), candleHigh);
      const bucket  = Math.floor(clamped / (ts * n)) * (ts * n);
      const bk      = String(parseFloat(bucket.toFixed(8)));
      if (!out[bk]) out[bk] = { bid_vol: 0, ask_vol: 0, delta: 0, total: 0 };
      out[bk].bid_vol += lv.bid_vol || 0;
      out[bk].ask_vol += lv.ask_vol || 0;
      out[bk].delta    = out[bk].bid_vol - out[bk].ask_vol;
      out[bk].total    = out[bk].bid_vol + out[bk].ask_vol;
    }
    return out;
  }

  // ─ Main entry point ──────────────────────────────────────────
  function render(c) {
    const { mainCtx: ctx, CHART_H, HEAT_W } = c;

    drawGrid(c);
    drawSessionLevels(c);

    // Per-candle pass
    for (let col = 0; col < c.visCols; col++) {
      const si = c.startIdx + col;
      if (si >= c.candles.length) break;
      const candle = c.candles[si];
      const cx     = col * c.colPx;
      drawCandle(ctx, candle, cx, c.colPx, c.CHART_H, c.py);
      drawFootprintCells(c, candle, cx, col, si);
    }

    drawPriceLine(c);
    drawTimestampBar(c);
    drawPriceAxis(c);
    drawBubbles(c);
    drawVolumeProfile(c);
  }

  // ─ Grid ──────────────────────────────────────────────────────
  function drawGrid({ mainCtx: ctx, CHART_H, HEAT_W }) {
    ctx.strokeStyle = 'rgba(30,30,50,0.45)';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round((i / 10) * CHART_H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(HEAT_W, y); ctx.stroke();
    }
  }

  // ─ Session levels (VWAP, POC, VAH, VAL) ─────────────────────
  function drawSessionLevels({ mainCtx: ctx, CHART_H, HEAT_W, session, cfg, py }) {
    if (cfg.showVWAP && session.vwap) {
      const vy = py(session.vwap);
      if (vy >= 0 && vy <= CHART_H) {
        ctx.save();
        ctx.setLineDash([6, 3]);
        ctx.strokeStyle = 'rgba(201,162,234,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, vy); ctx.lineTo(HEAT_W, vy); ctx.stroke();
        ctx.font = '9px Inter,monospace'; ctx.fillStyle = 'rgba(201,162,234,1)';
        ctx.textAlign = 'left';
        ctx.fillText('VWAP ' + session.vwap.toFixed(session.vwap > 100 ? 1 : 4), 4, vy - 3);
        ctx.setLineDash([]); ctx.restore();
      }
    }
    const lvl = (price, label, color) => {
      if (!price) return;
      const y = py(price);
      if (y < 0 || y > CHART_H) return;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(HEAT_W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '9px Inter,monospace'; ctx.fillStyle = color; ctx.textAlign = 'left';
      ctx.fillText(label + ' ' + price.toFixed(price > 100 ? 1 : 4), 4, y + 9);
      ctx.restore();
    };
    lvl(session.poc, 'POC', 'rgba(229,192,123,0.9)');
    lvl(session.vah, 'VAH', 'rgba(137,220,235,0.7)');
    lvl(session.val, 'VAL', 'rgba(137,220,235,0.7)');
  }

  // ─ OHLC candle — no fill, saturated borders + wicks ─────────
  function drawCandle(ctx, c, cx, colPx, CHART_H, py) {
    if (!c.open) return;
    const isBull = c.close >= c.open;
    const color  = isBull ? 'rgb(0,255,80)' : 'rgb(255,30,30)';
    const x      = cx + colPx / 2;
    const bodyT  = py(Math.max(c.open, c.close));
    const bodyB  = py(Math.min(c.open, c.close));
    const wickT  = py(c.high);
    const wickB  = py(c.low);
    const bodyH  = Math.max(2, bodyB - bodyT);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.shadowColor = isBull ? 'rgba(0,255,80,0.35)' : 'rgba(255,30,30,0.35)';
    ctx.shadowBlur  = 4;

    ctx.beginPath(); ctx.moveTo(x, wickT); ctx.lineTo(x, bodyT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, bodyB); ctx.lineTo(x, wickB); ctx.stroke();
    // No fill — border only
    ctx.shadowBlur = 4;
    ctx.strokeRect(cx + 2, bodyT, colPx - 4, bodyH);
    ctx.restore();
  }

  // ─ Footprint cells ───────────────────────────────────────────
  function drawFootprintCells(c, candle, cx, col, si) {
    const { mainCtx: ctx, colPx, cfg, tickSize, rowH, py, CHART_H } = c;

    const levels = clusterLevels(
      candle.levels || {},
      candle.high || c.midPrice,
      candle.low  || c.midPrice,
      tickSize,
      cfg.cluster
    );
    const keys = Object.keys(levels).sort((a, b) => parseFloat(a) - parseFloat(b));
    if (!keys.length) return;

    // Per-candle maxima for independent scaling
    const maxTotal = Math.max(...keys.map(k => lvTotal(levels[k])), 1);
    const maxBid   = Math.max(...keys.map(k => levels[k].bid_vol || 0), 1);
    const maxAsk   = Math.max(...keys.map(k => levels[k].ask_vol || 0), 1);
    const pocKey   = candle.poc;

    const cellW = colPx - 2;
    const halfW = Math.floor(cellW / 2);
    const mid   = cx + 1 + halfW;  // center divider x

    // ── Build POC zone bands ──────────────────────────────────
    // Find consecutive price runs at each tier threshold and merge into zones
    // so borders draw as one continuous rectangle, not per-cell
    const tierRanges = buildTierRanges(keys, levels, maxTotal, pocKey, tickSize, cfg.cluster, py, rowH);

    // ── Draw cells ───────────────────────────────────────────
    for (const k of keys) {
      const lv     = levels[k];
      const price  = parseFloat(k);
      const y      = py(price);
      if (y < 0 || y > CHART_H) continue;

      const total    = lvTotal(lv);
      const bidVol   = lv.bid_vol || 0;
      const askVol   = lv.ask_vol || 0;
      const ratio    = total / maxTotal;
      const bidRatio = bidVol / maxBid;
      const askRatio = askVol / maxAsk;
      const cellH    = Math.max(2, rowH - 1);
      const alpha    = 0.25 + ratio * 0.75;

      // Ask (buyers) — green, grows LEFT from center
      const askBarW = Math.max(1, askRatio * halfW);
      ctx.fillStyle = `rgba(50,255,100,${alpha.toFixed(2)})`;
      ctx.fillRect(mid - askBarW, y - cellH / 2, askBarW, cellH);

      // Bid (sellers) — red, grows RIGHT from center
      const bidBarW = Math.max(1, bidRatio * halfW);
      ctx.fillStyle = `rgba(255,50,50,${alpha.toFixed(2)})`;
      ctx.fillRect(mid, y - cellH / 2, bidBarW, cellH);

      // Center divider
      ctx.fillStyle = 'rgba(120,120,150,0.5)';
      ctx.fillRect(mid, y - cellH / 2, 1, cellH);

      // Side POC markers (brightest bar on each side)
      if (askRatio >= 0.98) {
        ctx.save();
        ctx.strokeStyle = 'rgba(50,255,100,1)';
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(50,255,100,0.6)';
        ctx.shadowBlur  = 4;
        ctx.beginPath(); ctx.moveTo(cx + 1, y - cellH / 2); ctx.lineTo(cx + 1, y + cellH / 2);
        ctx.stroke(); ctx.restore();
      }
      if (bidRatio >= 0.98) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,50,50,1)';
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(255,50,50,0.6)';
        ctx.shadowBlur  = 4;
        ctx.beginPath(); ctx.moveTo(cx + cellW, y - cellH / 2); ctx.lineTo(cx + cellW, y + cellH / 2);
        ctx.stroke(); ctx.restore();
      }

      // Imbalance triangle on right edge
      if (cfg.showImbalance) {
        const imb = total > 0 ? askVol / total : 0.5;
        const thr = cfg.imbalanceThreshold;
        if (imb >= thr || imb <= 1 - thr) {
          ctx.fillStyle = imb >= thr ? 'rgba(50,255,100,1)' : 'rgba(255,50,50,1)';
          ctx.beginPath();
          ctx.moveTo(cx + cellW,     y - cellH / 2);
          ctx.lineTo(cx + cellW + 4, y);
          ctx.lineTo(cx + cellW,     y + cellH / 2);
          ctx.closePath(); ctx.fill();
        }
      }

      // Numbers on outer edges — ask on far left, bid on far right
      if (colPx >= 44 && cellH >= 11) {
        const fs = Math.min(9, cellH - 2);
        ctx.font      = `${fs}px Inter,monospace`;
        ctx.fillStyle = 'rgba(220,220,240,0.95)';
        ctx.textAlign = 'left';
        ctx.fillText(fmtVol(askVol), cx + 2, y + fs / 2 - 1);    // ask: left edge
        ctx.textAlign = 'right';
        ctx.fillText(fmtVol(bidVol), cx + cellW - 1, y + fs / 2 - 1); // bid: right edge
        ctx.textAlign = 'left';
      }
    }

    // ── Draw tier zone borders (merged continuous rectangles) ──
    drawTierBorders(ctx, tierRanges, cx, cellW);

    // Delta label below candle
    if (colPx >= 28 && candle.delta !== undefined) {
      const d    = candle.delta;
      const botY = py(candle.low) + 14;
      ctx.font      = '8px Inter,monospace';
      ctx.fillStyle = d >= 0 ? 'rgb(50,255,100)' : 'rgb(255,50,50)';
      ctx.textAlign = 'center';
      ctx.fillText(
        (d >= 0 ? '+' : '') + (Math.abs(d) >= 1000 ? (d/1000).toFixed(1)+'k' : d.toFixed(1)),
        cx + colPx / 2, botY
      );
      ctx.textAlign = 'left';
    }
  }

  // Build merged vertical zones for tier borders
  // Returns array of { tier: 'poc'|'high'|'mid', yTop, yBot }
  function buildTierRanges(keys, levels, maxTotal, pocKey, tickSize, cluster, py, rowH) {
    const zones = [];
    let current = null;

    for (const k of keys) {
      const lv    = levels[k];
      const price = parseFloat(k);
      const ratio = lvTotal(lv) / maxTotal;
      const isPOC = pocKey !== undefined && pocKey !== null && Math.abs(price - pocKey) < 1e-6;

      // Determine tier for this level
      let tier = null;
      if (isPOC)         tier = 'poc';
      else if (ratio >= 0.75) tier = 'high';
      else if (ratio >= 0.50) tier = 'mid';

      if (!tier) { current = null; continue; }

      const y     = py(price);
      const cellH = Math.max(2, rowH - 1);
      const yTop  = y - cellH / 2;
      const yBot  = y + cellH / 2;

      if (current && current.tier === tier && yTop <= current.yBot + 2) {
        // Extend existing zone — but if POC is inside a high/mid zone, promote it
        current.yBot = yBot;
        if (isPOC) current.hasPOC = true;
      } else {
        if (current) zones.push(current);
        current = { tier, yTop, yBot, hasPOC: isPOC };
      }
    }
    if (current) zones.push(current);
    return zones;
  }

  function drawTierBorders(ctx, zones, cx, cellW) {
    for (const z of zones) {
      const h = z.yBot - z.yTop;

      if (z.tier === 'poc' || z.hasPOC) {
        // Gold glow — POC always visible even inside a merged zone
        ctx.save();
        ctx.strokeStyle = 'rgba(229,192,123,1)';
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(229,192,123,0.8)';
        ctx.shadowBlur  = 6;
        ctx.strokeRect(cx + 1, z.yTop, cellW, h);
        ctx.restore();
      } else if (z.tier === 'high') {
        ctx.save();
        ctx.strokeStyle = 'rgba(220,220,220,0.85)';
        ctx.lineWidth   = 1.5;
        ctx.shadowColor = 'rgba(220,220,220,0.3)';
        ctx.shadowBlur  = 3;
        ctx.strokeRect(cx + 1, z.yTop, cellW, h);
        ctx.restore();
      } else if (z.tier === 'mid') {
        ctx.save();
        ctx.strokeStyle = 'rgba(100,160,255,0.6)';
        ctx.lineWidth   = 1;
        ctx.strokeRect(cx + 1, z.yTop, cellW, h);
        ctx.restore();
      }
    }
  }

  // ─ Price line ────────────────────────────────────────────────
  function drawPriceLine({ mainCtx: ctx, HEAT_W, AXIS_W, H, TS_BAR_H, midPrice, windowHalf, py }) {
    const midY = py(midPrice);
    ctx.strokeStyle = 'rgba(122,162,247,0.95)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(HEAT_W, midY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(122,162,247,0.15)';
    ctx.fillRect(HEAT_W, midY - 8, AXIS_W, 16);
  }

  // ─ Timestamp bar ─────────────────────────────────────────────
  function drawTimestampBar({ mainCtx: ctx, CHART_H, HEAT_W, TS_BAR_H, colPx, visCols, startIdx, candles }) {
    ctx.fillStyle = 'rgba(13,13,30,0.9)';
    ctx.fillRect(0, CHART_H, HEAT_W, TS_BAR_H);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(40,40,70,0.9)'; ctx.lineWidth = 1;
    ctx.moveTo(0, CHART_H); ctx.lineTo(HEAT_W, CHART_H); ctx.stroke();
    const step = Math.max(1, Math.round(100 / colPx));
    ctx.font = '9px Inter,monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(108,112,134,0.9)';
    for (let col = 0; col < visCols; col += step) {
      const si = startIdx + col;
      if (si >= candles.length) break;
      const x = col * colPx + colPx / 2;
      if (x < 20 || x > HEAT_W - 10) continue;
      ctx.fillText(fmtTime(candles[si].open_ts * 1000), x, CHART_H + 13);
    }
    ctx.textAlign = 'left';
  }

  // ─ Price axis ────────────────────────────────────────────────
  function drawPriceAxis({ mainCtx: ctx, HEAT_W, AXIS_W, H, CHART_H, TS_BAR_H, midPrice, windowHalf, py }) {
    ctx.fillStyle = 'rgba(10,10,20,0.92)';
    ctx.fillRect(HEAT_W, 0, AXIS_W, H);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(40,40,70,0.9)'; ctx.lineWidth = 1;
    ctx.moveTo(HEAT_W, 0); ctx.lineTo(HEAT_W, H); ctx.stroke();
    const lo    = midPrice - windowHalf;
    const range = windowHalf * 2;
    ctx.font = '10px Inter,monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 12; i++) {
      const price = lo + (range / 12) * i;
      const y     = CHART_H - (i / 12) * CHART_H;
      ctx.fillStyle = 'rgba(108,112,134,0.85)';
      ctx.fillText(price.toFixed(price > 100 ? 1 : 4), HEAT_W + 4, y + 3);
    }
    const midY = py(midPrice);
    ctx.fillStyle = 'rgba(205,214,244,1)'; ctx.font = 'bold 11px Inter,monospace';
    ctx.fillText(midPrice.toFixed(midPrice > 100 ? 1 : 4), HEAT_W + 4, midY + 4);
  }

  // ─ Bubbles ───────────────────────────────────────────────────
  function drawBubbles({ mainCtx: ctx, bubbles }) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (b.alpha <= 0) { bubbles.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      const rgb = b.side === 'B' ? '50,255,100' : '255,50,50';
      ctx.fillStyle   = `rgba(${rgb},${b.alpha.toFixed(2)})`;
      ctx.strokeStyle = `rgba(${rgb},0.9)`;
      ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      b.alpha -= 0.004;
    }
  }

  // ─ Volume profile ────────────────────────────────────────────
  function drawVolumeProfile({ vpCtx, vpCanvas, VP_W, candles, startIdx, visCols, midPrice, windowHalf, tickSize, cfg, session, py_vp }) {
    if (!vpCtx || !midPrice || !windowHalf) return;
    const vH = vpCanvas.height;
    vpCtx.clearRect(0, 0, VP_W, vH);
    const volMap = {};
    for (let col = 0; col < visCols; col++) {
      const si = startIdx + col;
      if (si >= candles.length) break;
      const can = candles[si];
      const lvs = clusterLevels(can.levels || {}, can.high || midPrice, can.low || midPrice, tickSize, cfg.cluster);
      for (const [k, l] of Object.entries(lvs)) {
        volMap[k] = (volMap[k] || 0) + lvTotal(l);
      }
    }
    const keys   = Object.keys(volMap).sort((a, b) => parseFloat(a) - parseFloat(b));
    const maxVol = Math.max(...Object.values(volMap), 1);
    const et     = (tickSize || 1) * cfg.cluster;
    const rh     = Math.max(2, (vH / (windowHalf * 2)) * et);
    for (const k of keys) {
      const price = parseFloat(k);
      const y     = py_vp(price, vH);
      if (y < 0 || y > vH) continue;
      const ratio = volMap[k] / maxVol;
      const w     = Math.floor(ratio * (VP_W - 4));
      if      (ratio >= 1.0)  vpCtx.fillStyle = 'rgba(229,192,123,0.9)';
      else if (ratio >= 0.75) vpCtx.fillStyle = 'rgba(220,220,220,0.6)';
      else if (ratio >= 0.50) vpCtx.fillStyle = 'rgba(100,160,255,0.5)';
      else                    vpCtx.fillStyle = 'rgba(122,162,247,0.3)';
      vpCtx.fillRect(0, y - rh / 2, w, Math.max(1, rh - 0.5));
    }
  }

  // ─ CVD ───────────────────────────────────────────────────────
  function drawCVD(ctx, cW, cH, data) {
    if (!ctx || !cW || !cH || data.length < 2) return;
    ctx.clearRect(0, 0, cW, cH);
    const min   = Math.min(...data);
    const max   = Math.max(...data);
    const range = max - min || 1;
    const xStep = cW / (data.length - 1);
    const lv    = data[data.length - 1];

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * xStep, y = cH - ((v - min) / range) * (cH - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(cW, cH); ctx.lineTo(0, cH); ctx.closePath();
    const gr = ctx.createLinearGradient(0, 0, 0, cH);
    if (lv >= 0) {
      gr.addColorStop(0, 'rgba(50,255,100,0.3)'); gr.addColorStop(1, 'rgba(50,255,100,0.02)');
    } else {
      gr.addColorStop(0, 'rgba(255,50,50,0.02)');  gr.addColorStop(1, 'rgba(255,50,50,0.3)');
    }
    ctx.fillStyle = gr; ctx.fill();

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * xStep, y = cH - ((v - min) / range) * (cH - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = lv >= 0 ? 'rgba(50,255,100,0.9)' : 'rgba(255,50,50,0.9)';
    ctx.lineWidth = 1.5; ctx.stroke();

    if (min < 0 && max > 0) {
      const zy = cH - ((0 - min) / range) * (cH - 4) - 2;
      ctx.strokeStyle = 'rgba(108,112,134,0.4)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(cW, zy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = '9px Inter,monospace'; ctx.fillStyle = 'rgba(108,112,134,0.9)';
    ctx.textAlign = 'right'; ctx.fillText(lv.toFixed(3), cW - 4, 10); ctx.textAlign = 'left';
  }

  return { render, drawCVD };
})();