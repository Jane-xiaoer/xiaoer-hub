/* 小耳 · 光标特效 —— 虚线准星光标 + 点击涟漪
 * 通用叠加层：任何页面加一行 <script src="js/cursor-fx.js"></script> 就有。
 * 自己起一张 fixed 的 2D canvas 铺在最上面(pointer-events:none)，不碰页面原有的渲染。
 *
 * 页面可选接入点：
 *   window.CURSOR_FX_OPTS = { accent:[r,g,b], ... }   // 载入前覆盖默认参数
 *   CursorFX.snap = () => ({x,y,r}) | null            // 让环吸附到页面自己的目标(比如星图节点)
 *   CursorFX.addParams({key:{label,min,max,step,value}})  // 把页面自己的参数塞进调参面板
 *   CursorFX.ext.key                                   // 读回上面注册的值
 *
 * 调参面板：localhost 或网址带 ?fx=1 时出现，按 D 收起/展开。线上默认不出现。
 */
(function () {
  if (window.matchMedia && window.matchMedia('(hover:none)').matches) return; // 触屏没有光标，不装

  const O = {
    cursor: 1,          // 虚线准星光标
    ringR: 18,          // 环半径                              ← Jane 2026-08-04 拖定
    ringA: 0.53,        // 环亮度(常态；压到东西上会自动提亮)  ← Jane 拖定
    ease: 0.53,         // 跟随阻尼：小=拖尾更黏，1=硬跟随      ← Jane 拖定
    spin: 0.4,          // 虚线环自转(圈/秒)                    ← Jane 拖定
    trail: 1,           // 鼠标移动时身后的虚线拖尾
    trailT: 1190,       // 拖尾留多久 ms(停下就自己散掉)        ← Jane 拖定
    readout: 1,         // 坐标读数 + 事件编号
    ripple: 1,          // 点击涟漪
    rippleR: 280,       // 涟漪最大半径
    rippleT: 1200,      // 涟漪时长 ms
    rippleN: 2,         // 涟漪环数(外实线 / 内虚线 / 最内细环)
    accent: [255, 124, 58],
    base: [236, 234, 244],
    hotSel: 'a,button,[data-fx-hot]' // 悬停这些 DOM 元素时环会变色收紧
  };
  Object.assign(O, window.CURSOR_FX_OPTS || {});

  const CFX = window.CursorFX = { opts: O, snap: null, ext: {}, _extDefs: {} };
  CFX.addParams = function (defs) {
    for (const k in defs) { CFX._extDefs[k] = defs[k]; CFX.ext[k] = defs[k].value; }
    if (panel) buildPanel();
  };

  // ── 叠加画布 ──
  const cv = document.createElement('canvas');
  cv.id = 'cfx-layer';
  cv.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;display:block';
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);

  // ── 藏掉系统箭头 ──
  const st = document.createElement('style');
  st.textContent = 'html.cfx-on,html.cfx-on *{cursor:none !important}'
    + '#cfx-panel{position:fixed;top:96px;right:26px;z-index:100000;width:206px;padding:13px 14px 11px;'
    + 'background:rgba(10,6,10,.84);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.13);border-radius:8px;'
    + 'font-family:"Cutive Mono",ui-monospace,monospace;font-size:10px;color:rgba(255,255,255,.62);letter-spacing:.04em}'
    + '#cfx-panel.hide{display:none}'
    + '#cfx-panel h4{font-size:9px;letter-spacing:.3em;text-transform:uppercase;font-weight:400;margin:0 0 10px}'
    + '#cfx-panel .row{display:flex;justify-content:space-between;margin-bottom:2px}'
    + '#cfx-panel .row span{color:rgba(255,255,255,.78)}'
    + '#cfx-panel input[type=range]{width:100%;height:13px;margin:0 0 7px;cursor:pointer}'
    + '#cfx-panel label{display:flex;align-items:center;gap:7px;margin-bottom:6px;cursor:pointer}'
    + '#cfx-panel hr{border:0;border-top:1px solid rgba(255,255,255,.1);margin:9px 0 8px}'
    + '#cfx-panel button{width:100%;margin-top:3px;padding:6px;background:rgba(255,255,255,.08);'
    + 'border:1px solid rgba(255,255,255,.22);color:inherit;font:inherit;font-size:9px;letter-spacing:.2em;'
    + 'border-radius:4px;cursor:pointer;text-transform:uppercase}';

  // ── 状态 ──
  let mx = -9999, my = -9999;              // 真实鼠标
  const cur = { x: -9999, y: -9999, r: O.ringR }; // 环(带阻尼，落后一点)
  let hotEl = null;                        // 鼠标下的可交互 DOM
  let TRAIL = [];                          // 移动轨迹(拖尾)
  let RIPPLES = [], evtNo = 0, live = null, downX = 0, downY = 0;

  addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (cur.x < -1000) { cur.x = mx; cur.y = my; }  // 第一次进来别从屏外飞过来
    const last = TRAIL[TRAIL.length - 1];
    if (!last || Math.hypot(mx - last.x, my - last.y) > 5) TRAIL.push({ x: mx, y: my, t: performance.now() });
    const t = e.target;
    hotEl = (t && t.closest) ? t.closest(O.hotSel) : null;
    if (live && Math.abs(mx - downX) + Math.abs(my - downY) > 3) live.dead = true; // 变成拖拽了，涟漪收掉
  }, { passive: true });
  addEventListener('mouseout', e => { if (!e.relatedTarget) { mx = my = -9999; } });

  addEventListener('pointerdown', e => {
    if (!O.ripple) return;
    downX = e.clientX; downY = e.clientY;
    live = { x: e.clientX, y: e.clientY, t0: performance.now(), no: ++evtNo, dead: false };
    RIPPLES.push(live);
  }, true);
  addEventListener('pointerup', () => { live = null; }, true);

  // ── 画 ──
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const now = performance.now();
    document.documentElement.classList.toggle('cfx-on', !!O.cursor);

    // 移动拖尾：身后拖一串一条一条的短虚线，按年龄淡出；停下来 trailT 内自己散干净。
    // 每一小段都硬性截断到 DASH 长度 —— 鼠标甩得再快也不会把两个远点连成长线拉出斜网纹。
    if (O.trail && TRAIL.length) {
      TRAIL = TRAIL.filter(p => now - p.t < O.trailT);
      if (TRAIL.length > 150) TRAIL = TRAIL.slice(-150); // 上限要留够,否则 trailT 调长了也被这里截短
      const DASH = 7;
      ctx.save(); ctx.setLineDash([]); ctx.lineWidth = 0.9; ctx.lineCap = 'round';
      for (let i = 1; i < TRAIL.length; i++) {
        const p = TRAIL[i], q = TRAIL[i - 1];
        const vx = p.x - q.x, vy = p.y - q.y, len = Math.hypot(vx, vy) || 1;
        const k = Math.min(DASH, len) / len;               // 只画贴着该点的一小截
        const age = (now - p.t) / O.trailT;
        ctx.strokeStyle = `rgba(${O.base},${O.ringA * 0.85 * (1 - age)})`;
        ctx.beginPath();
        ctx.moveTo(p.x - vx * k, p.y - vy * k); ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 涟漪：从落点扩散的细环，ease-out 出去、越远越淡
    if (RIPPLES.length) {
      for (const rp of RIPPLES) {
        const dur = rp.dead ? 260 : O.rippleT;
        const t = (now - rp.t0) / dur;
        if (t >= 1) continue;
        const e = 1 - Math.pow(1 - t, 3);
        const fade = Math.pow(1 - t, 1.8);
        const R = O.rippleR * e * (rp.dead ? 0.35 : 1);
        ctx.save();
        ctx.lineWidth = 0.9; ctx.strokeStyle = `rgba(${O.base},${0.42 * fade})`;
        ctx.beginPath(); ctx.arc(rp.x, rp.y, R, 0, 7); ctx.stroke();
        if (O.rippleN >= 2) {
          ctx.setLineDash([3, 7]); ctx.lineWidth = 0.8;
          ctx.strokeStyle = `rgba(${O.accent},${0.34 * fade})`;
          ctx.beginPath(); ctx.arc(rp.x, rp.y, R * 0.58, 0, 7); ctx.stroke();
          ctx.setLineDash([]);
        }
        if (O.rippleN >= 3) {
          ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(${O.base},${0.22 * fade})`;
          ctx.beginPath(); ctx.arc(rp.x, rp.y, R * 0.28, 0, 7); ctx.stroke();
        }
        // 落点残留的小准星 + 事件编号(仪表盘味)
        if (O.readout && !rp.dead) {
          const a = 0.5 * fade;
          ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(${O.base},${a})`;
          ctx.beginPath();
          ctx.moveTo(rp.x - 9, rp.y); ctx.lineTo(rp.x - 3, rp.y);
          ctx.moveTo(rp.x + 3, rp.y); ctx.lineTo(rp.x + 9, rp.y);
          ctx.moveTo(rp.x, rp.y - 9); ctx.lineTo(rp.x, rp.y - 3);
          ctx.moveTo(rp.x, rp.y + 3); ctx.lineTo(rp.x, rp.y + 9);
          ctx.stroke();
          ctx.font = '9px "Cutive Mono",ui-monospace,monospace';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(${O.base},${a * 0.8})`;
          ctx.fillText('EVT_' + String(rp.no).padStart(2, '0'), rp.x + 15, rp.y - 6);
          ctx.fillStyle = `rgba(${O.base},${a * 0.5})`;
          ctx.fillText(Math.round(rp.x) + ' · ' + Math.round(rp.y), rp.x + 15, rp.y + 6);
        }
        ctx.restore();
      }
      RIPPLES = RIPPLES.filter(rp => (now - rp.t0) / (rp.dead ? 260 : O.rippleT) < 1);
    }

    // 光标环
    if (O.cursor && mx > -1000) {
      // 吸附目标：先问页面(星图节点)，再看鼠标底下的按钮/链接
      let snap = null;
      try { snap = CFX.snap && CFX.snap(); } catch (err) { snap = null; }
      if (!snap && hotEl) {
        const b = hotEl.getBoundingClientRect();
        const m = Math.max(b.width, b.height);
        // 小方块(图标/按钮)整个吸进去；长条(导航文字)只放大不挪位，免得环乱飞
        if (m < 64) snap = { x: b.left + b.width / 2, y: b.top + b.height / 2, r: m / 2 + 9 };
      }
      const hot = !!(snap || hotEl);
      const tx = snap ? snap.x : mx, ty = snap ? snap.y : my;
      const tr = snap ? snap.r : (hotEl ? O.ringR * 1.35 : O.ringR);
      cur.x += (tx - cur.x) * O.ease;
      cur.y += (ty - cur.y) * O.ease;
      cur.r += (tr - cur.r) * 0.18;

      const col = hot ? O.accent : O.base;
      const A = hot ? Math.min(1, O.ringA + 0.28) : O.ringA;
      ctx.save();
      ctx.translate(cur.x, cur.y);
      // 虚线环，慢慢自转
      ctx.save();
      ctx.rotate(now * 0.001 * O.spin * Math.PI * 2);
      ctx.setLineDash([3, 4.5]); ctx.lineWidth = hot ? 1.15 : 1;
      ctx.strokeStyle = `rgba(${col},${A})`;
      ctx.beginPath(); ctx.arc(0, 0, cur.r, 0, 7); ctx.stroke();
      ctx.restore();
      // 四向准星，中间留空不挡东西
      const i0 = cur.r + 4, i1 = cur.r + 12;
      ctx.setLineDash([]); ctx.lineWidth = 0.8;
      ctx.strokeStyle = `rgba(${col},${A * 0.75})`;
      ctx.beginPath();
      ctx.moveTo(-i1, 0); ctx.lineTo(-i0, 0); ctx.moveTo(i0, 0); ctx.lineTo(i1, 0);
      ctx.moveTo(0, -i1); ctx.lineTo(0, -i0); ctx.moveTo(0, i0); ctx.lineTo(0, i1);
      ctx.stroke();
      ctx.restore();
      // 环有阻尼会落后，这个小点才是"你真正在哪"
      ctx.fillStyle = `rgba(${col},${A * 0.9})`;
      ctx.beginPath(); ctx.arc(mx, my, 1.3, 0, 7); ctx.fill();
      if (O.readout) {
        ctx.font = '9px "Cutive Mono",ui-monospace,monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(${col},${hot ? 0.6 : 0.34})`;
        ctx.fillText(Math.round(mx) + ' · ' + Math.round(my), mx + cur.r + 16, my + cur.r * 0.55);
      }
    }
    requestAnimationFrame(draw);
  }

  // ── 调参面板(localhost 或 ?fx=1 才出现，按 D 收起) ──
  const SLIDERS = [
    ['ringR', '光标环半径', 8, 50, 1], ['ringA', '环亮度', 0.15, 1, 0.02],
    ['ease', '跟随阻尼', 0.05, 1, 0.01], ['spin', '环自转', 0, 2, 0.05],
    ['trailT', '拖尾长度', 150, 1600, 20],
    ['rippleR', '涟漪半径', 60, 600, 10], ['rippleT', '涟漪时长', 300, 2500, 50], ['rippleN', '涟漪环数', 1, 3, 1]
  ];
  const TOGGLES = [['cursor', '准星光标'], ['readout', '坐标读数'], ['ripple', '点击涟漪'], ['trail', '移动拖尾']];
  let panel = null;
  function row(k, label, a, b, s, v) {
    return `<div class="row">${label}<span id="cfxv_${k}">${v}</span></div>`
      + `<input type="range" data-k="${k}" min="${a}" max="${b}" step="${s}" value="${v}">`;
  }
  function buildPanel() {
    const ex = Object.keys(CFX._extDefs);
    panel.innerHTML = '<h4 style="color:rgb(' + O.accent + ')">Cursor FX · 调参</h4>'
      + TOGGLES.map(([k, n]) => `<label><input type="checkbox" data-k="${k}" ${O[k] ? 'checked' : ''}>${n}</label>`).join('')
      + '<hr>' + SLIDERS.map(([k, n, a, b, s]) => row(k, n, a, b, s, O[k])).join('')
      + (ex.length ? '<hr>' + ex.map(k => { const d = CFX._extDefs[k]; return row('ext:' + k, d.label, d.min, d.max, d.step, CFX.ext[k]); }).join('') : '')
      + '<button id="cfxCopy">复制当前参数</button>';
    panel.querySelector('#cfxCopy').onclick = () => {
      navigator.clipboard.writeText(JSON.stringify({ opts: O, ext: CFX.ext }, null, 2));
      const b = panel.querySelector('#cfxCopy');
      b.textContent = '已复制 ✓'; setTimeout(() => b.textContent = '复制当前参数', 1400);
    };
  }
  function initPanel() {
    panel = document.createElement('div');
    panel.id = 'cfx-panel';
    panel.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      const v = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : parseFloat(e.target.value);
      if (k.startsWith('ext:')) CFX.ext[k.slice(4)] = v; else O[k] = v;
      const s = panel.querySelector('#cfxv_' + CSS.escape(k)); if (s) s.textContent = v;
    });
    document.body.appendChild(panel);
    buildPanel();
    addEventListener('keydown', e => {
      if ((e.key === 'd' || e.key === 'D') && !/input|textarea/i.test(e.target.tagName)) panel.classList.toggle('hide');
    });
  }

  function boot() {
    document.head.appendChild(st);
    document.body.appendChild(cv);
    resize();
    const local = /^(localhost|127\.|192\.168\.|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:';
    if (local || /[?&]fx=1/.test(location.search)) initPanel();
    requestAnimationFrame(draw);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
